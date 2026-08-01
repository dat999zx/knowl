import { getClient } from './database.js';
import { ensureTranscriptIndex, sessionFiles } from './transcript-index.js';

// A browsable directory of a project's Claude Code sessions, host-session
// grained - the unit a person actually thinks in ("the UI session", "the forge
// session"), not the fine-grained memory sessions the lifecycle hooks create
// per agent turn.
//
// Everything here is derived deterministically from data that already exists:
// names and opening asks captured by the transcript indexer as it streams,
// activity figures from the index, and - where lifecycle hooks ran - the
// knowledge each session actually promoted. No AI provider, no cap on how far
// back it reaches, and sessions that were never named still appear with their
// opening ask, which is precisely where the native picker gives up.

export interface SessionDirectoryEntry {
  sessionId: string;
  /** Best available name: user rename > agent name > generated title > null. */
  name: string | null;
  /** The first real user ask, one line - what the session set out to do. */
  opening: string | null;
  /**
   * Derived at read time from lifecycle data, never stored:
   * 'interrupted' - an unconsumed crash handoff names this session; there is a
   *                 blocker waiting to be resumed. Strongest signal, wins.
   * 'active'      - a live memory session with a recent heartbeat is bound to
   *                 it, or the transcript was written moments ago.
   * 'idle'        - everything else; lastActiveAt carries the rest.
   * Fine-grained working/stalled tiers exist in live monitors, but this is a
   * recall surface - their precondition (real-time observation) is absent.
   */
  status: 'active' | 'interrupted' | 'idle';
  /** Title of the newest declared session card, when one was stored (tags: session-card + session:<id>). */
  card: string | null;
  lastActiveAt: string;
  sizeBytes: number;
  messagesIndexed: number;
  /** Titles of knowledge atoms this session promoted into memory, when lifecycle hooks captured any. */
  promoted: string[];
}

/** A heartbeat older than this no longer counts as "working right now". */
const ACTIVE_HEARTBEAT_MS = 30 * 60 * 1000;
/** A transcript written this recently is active even without lifecycle hooks. */
const ACTIVE_MTIME_MS = 10 * 60 * 1000;

export interface SessionDirectoryOptions {
  projectDir?: string;
  /** Keyword filter over name + opening. All tokens must match. */
  query?: string;
  limit?: number;
  /** Override transcript roots. Injected by tests so they never mutate HOME. */
  stores?: string[];
}

export async function listSessionDirectory(
  options: SessionDirectoryOptions = {},
): Promise<{ entries: SessionDirectoryEntry[]; total: number; indexComplete: boolean }> {
  const { projectDir = process.cwd(), query, limit = 12, stores } = options;
  const client = getClient();

  // Names and openings are captured by the indexer, so the directory is only as
  // current as the index. Same budget-bounded call the search path uses.
  const index = await ensureTranscriptIndex(projectDir, stores);
  const files = await sessionFiles(projectDir, stores);

  const rows = (await client.execute({
    sql: `SELECT f.session_id, f.display_name, f.opening,
                 (SELECT COUNT(*) FROM transcript_messages m WHERE m.session_id = f.session_id AND m.project_dir = ?) AS messages
          FROM transcript_files f WHERE f.project_dir = ?`,
    args: [projectDir, projectDir],
  })).rows;
  const meta = new Map(rows.map(row => [String(row.session_id), row]));

  // Promoted knowledge per host session, through the lifecycle chain:
  // host session -> bound memory sessions -> promoted item ids -> item titles.
  // Best-effort: a project without lifecycle hooks simply has none of this.
  const promoted = new Map<string, string[]>();
  try {
    const promotedRows = (await client.execute(
      `SELECT b.external_session_id AS sid, i.title AS title
       FROM host_session_bindings b
       JOIN memory_sessions s ON s.id = b.memory_session_id
       JOIN json_each(COALESCE(s.promotion_items, '[]')) p
       JOIN knowledge_items i ON i.id = p.value
       WHERE s.promotion_status = 'promoted'`,
    )).rows;
    for (const row of promotedRows) {
      const sid = String(row.sid);
      const list = promoted.get(sid) ?? [];
      if (!list.includes(String(row.title))) list.push(String(row.title));
      promoted.set(sid, list);
    }
  } catch { /* older schema or no lifecycle data */ }

  // Lifecycle signals, one query each, mapped by host session id.
  const activeHeartbeat = new Map<string, number>();
  try {
    const hb = (await client.execute(
      `SELECT b.external_session_id AS sid, MAX(s.last_heartbeat_at) AS beat
       FROM host_session_bindings b
       JOIN memory_sessions s ON s.id = b.memory_session_id
       WHERE s.status = 'active'
       GROUP BY b.external_session_id`,
    )).rows;
    for (const row of hb) activeHeartbeat.set(String(row.sid), Date.parse(String(row.beat)));
  } catch { /* no lifecycle data */ }

  // Crash handoffs and declared cards both tag themselves session:<id>, so one
  // scan of active state items covers both. Parsed in JS: tags are JSON text,
  // and per-session LIKE queries would cost a round trip per session.
  const interrupted = new Set<string>();
  const cards = new Map<string, string>();
  try {
    const tagged = (await client.execute(
      `SELECT title, tags, content, updated_at FROM knowledge_items
       WHERE status = 'active' AND (tags LIKE '%"pending_handoff"%' OR tags LIKE '%"session-card"%')
       ORDER BY updated_at ASC`,
    )).rows;
    for (const row of tagged) {
      let tags: string[] = [];
      try { tags = JSON.parse(String(row.tags ?? '[]')); } catch { continue; }
      // Handoffs written before the session: tag existed carry the id only in
      // their content JSON; real archives have these, so fall back to it.
      let sid = tags.find(tag => tag.startsWith('session:'))?.slice('session:'.length);
      if (!sid) { try { sid = JSON.parse(String(row.content)).externalSessionId; } catch { /* not JSON */ } }
      if (!sid) continue;
      if (tags.includes('pending_handoff') && !tags.includes('consumed')) {
        try { if (JSON.parse(String(row.content)).consumed === true) continue; } catch { /* treat as live */ }
        interrupted.add(sid);
      }
      // Ascending updated_at, so the newest card naturally wins.
      if (tags.includes('session-card')) cards.set(sid, String(row.title));
    }
  } catch { /* no state items */ }

  const now = Date.now();
  let entries: SessionDirectoryEntry[] = files.map(file => {
    const row = meta.get(file.sessionId);
    const beat = activeHeartbeat.get(file.sessionId);
    const status = interrupted.has(file.sessionId) ? 'interrupted' as const
      : (beat !== undefined && now - beat < ACTIVE_HEARTBEAT_MS) || now - file.mtimeMs < ACTIVE_MTIME_MS ? 'active' as const
      : 'idle' as const;
    return {
      sessionId: file.sessionId,
      name: row?.display_name ? String(row.display_name) : null,
      opening: row?.opening ? String(row.opening) : null,
      status,
      card: cards.get(file.sessionId) ?? null,
      lastActiveAt: new Date(file.mtimeMs).toISOString(),
      sizeBytes: file.size,
      messagesIndexed: row ? Number(row.messages) : 0,
      promoted: (promoted.get(file.sessionId) ?? []).slice(0, 3),
    };
  });

  if (query?.trim()) {
    // Substring AND-match over the intent fields. This filters the INVENTORY
    // (what a session is about); content questions belong to transcript search.
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    entries = entries.filter(entry => {
      const haystack = `${entry.name ?? ''}\n${entry.opening ?? ''}\n${entry.card ?? ''}\n${entry.promoted.join('\n')}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
  }

  return { entries: entries.slice(0, limit), total: entries.length, indexComplete: index.complete };
}
