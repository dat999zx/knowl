/**
 * Build the unassisted-capture experiment corpus from a live Knowl database.
 *
 * Session events are hard-deleted past `expires_at` by `purgeExpiredSessionEvents`
 * (src/store/session-repository.ts), with a TTL of roughly two days. The corpus is
 * therefore not regenerable from an older database — this script must be run while the
 * events are still present, and its output is the durable artifact.
 *
 * Usage:
 *   node benchmarks/unassisted-capture/build-corpus.mjs [dbPath] [transcriptDir]
 *
 * Defaults to `.knowl/knowl.db` and the Claude project transcript directory. Transcripts
 * are never copied or committed: only their presence is recorded, since they carry raw
 * conversation text.
 */
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

/** A session needs this much activity before it can discriminate between extractors. */
const MIN_EVENTS = 10;
const MIN_CHANGED_PATHS = 2;

const DB_PATH = process.argv[2] ?? '.knowl/knowl.db';
const TRANSCRIPT_DIR = process.argv[3] ?? null;
const OUT_DIR = path.join('benchmarks', 'unassisted-capture', 'corpus');

const changedPathsOf = (event) => {
  try {
    return JSON.parse(String(event.payload)).changedPaths ?? [];
  } catch {
    return [];
  }
};

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });
  const query = async (sql, args = []) => (await client.execute({ sql, args })).rows;

  const events = await query('SELECT * FROM memory_session_events ORDER BY session_id, observed_at');
  const bySession = new Map();
  for (const event of events) {
    const key = String(event.session_id);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(event);
  }

  // Keep only sessions carrying enough signal to tell two extractors apart. Stub sessions
  // — a session opened with no work done — would otherwise dominate the corpus and flatten
  // every score toward zero regardless of extractor quality.
  const selected = [];
  for (const [sessionId, sessionEvents] of bySession) {
    const paths = new Set(sessionEvents.flatMap(changedPathsOf));
    if (sessionEvents.length >= MIN_EVENTS && paths.size >= MIN_CHANGED_PATHS) {
      selected.push({ sessionId, eventCount: sessionEvents.length, changedPathCount: paths.size });
    }
  }
  selected.sort((a, b) => b.eventCount - a.eventCount);
  const ids = selected.map((s) => s.sessionId);
  if (ids.length === 0) throw new Error('No sessions met the activity threshold — nothing to build.');
  const placeholders = ids.map(() => '?').join(',');

  const sessions = await query(`SELECT * FROM memory_sessions WHERE id IN (${placeholders})`, ids);
  const selectedEvents = ids.flatMap((id) => bySession.get(id));
  const bindings = await query(
    `SELECT * FROM host_session_bindings WHERE memory_session_id IN (${placeholders})`,
    ids,
  );

  // Transcript availability is recorded, never the transcript. Method 3 (model reading the
  // full conversation) needs these; today too few exist to run it, and this count is how we
  // know when that changes.
  const transcripts = new Set(
    TRANSCRIPT_DIR && fs.existsSync(TRANSCRIPT_DIR)
      ? fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''))
      : [],
  );
  const externalIdOf = new Map(
    bindings.filter((b) => b.host === 'claude').map((b) => [String(b.memory_session_id), String(b.external_session_id)]),
  );

  // Seed material for the answer key: knowledge the model chose to write while the session
  // was open. Items carry no session foreign key, so the join is the session's time window.
  const seeds = [];
  for (const session of sessions) {
    const from = String(session.started_at);
    const to = String(session.finished_at ?? session.last_heartbeat_at);
    const items = await query(
      'SELECT id, category, title, content, created_at FROM knowledge_items WHERE created_at >= ? AND created_at <= ?',
      [from, to],
    );
    const external = externalIdOf.get(String(session.id)) ?? null;
    seeds.push({
      sessionId: String(session.id),
      externalSessionId: external,
      hasTranscript: external !== null && transcripts.has(external),
      window: [from, to],
      items,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 1)}\n`);
  write('sessions.json', sessions);
  write('events.json', selectedEvents);
  write('bindings.json', bindings);
  write('seed-items.json', seeds);

  const manifest = {
    builtAt: new Date().toISOString(),
    source: DB_PATH,
    thresholds: { minEvents: MIN_EVENTS, minChangedPaths: MIN_CHANGED_PATHS },
    sessionsInDatabase: bySession.size,
    sessionsSelected: sessions.length,
    events: selectedEvents.length,
    sessionsWithError: ids.filter((id) => bySession.get(id).some((e) => e.type === 'error')).length,
    sessionsWithTranscript: seeds.filter((s) => s.hasTranscript).length,
    seedItems: seeds.reduce((total, s) => total + s.items.length, 0),
  };
  write('manifest.json', manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
