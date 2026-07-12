import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';
import { normalizeConflictKey } from './conflicts.js';
import * as repo from './repository.js';
import { getClient } from './database.js';
import { getMemorySession } from './session-repository.js';

export const PENDING_HANDOFF_CONFLICT_KEY = 'pending-session-handoff';
export const PENDING_HANDOFF_TITLE = 'Pending session handoff';
export const RATE_LIMIT_URGENCY = 'critical';
export const GENERIC_FAILURE_URGENCY = 'high';

export type SessionFailureKind = 'rate_limit' | 'failed';

export type PendingHandoff = {
  kind: SessionFailureKind;
  urgency: typeof RATE_LIMIT_URGENCY | typeof GENERIC_FAILURE_URGENCY;
  host: string;
  projectRoot: string;
  externalSessionId: string;
  memorySessionId?: string;
  sessionTitle?: string;
  errorCode?: string;
  errorMessage?: string;
  lastCheckpoint?: string;
  changedPaths?: string[];
  failedAt: string;
  consumed?: boolean;
  consumedAt?: string;
};

const RATE_LIMIT_MARKERS = [
  'rate_limit',
  'rate-limit',
  'ratelimit',
  'rate limit',
  'usage_limit',
  'usage-limit',
  'usage limit',
  'quota_exceeded',
  'quota exceeded',
  'session limit',
  'hit your limit',
  'limit reached',
];

function asString(value: unknown, max = 2_000): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;
}

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) collectStrings(entry, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out.push(key);
      collectStrings(entry, out, depth + 1);
    }
  }
  return out;
}

export function detectSessionFailureKind(payload: Record<string, unknown>, status?: 'finished' | 'failed'): SessionFailureKind | null {
  if (status !== 'failed' && status !== undefined) return null;
  const haystack = collectStrings(payload).join(' ').toLowerCase();
  if (RATE_LIMIT_MARKERS.some(marker => haystack.includes(marker))) return 'rate_limit';
  if (status === 'failed') return 'failed';
  return null;
}

function parseHandoffContent(content: string): PendingHandoff | null {
  try {
    const parsed = JSON.parse(content) as PendingHandoff;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'rate_limit' && parsed.kind !== 'failed') return null;
    if (!parsed.failedAt || !parsed.host || !parsed.projectRoot || !parsed.externalSessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loadLatestSessionCheckpoint(sessionId: string): Promise<{ summary?: string; changedPaths?: string[] }> {
  const rows = (await getClient().execute({
    sql: `SELECT payload FROM memory_session_events
      WHERE session_id = ? AND type = 'checkpoint'
      ORDER BY observed_at DESC
      LIMIT 1`,
    args: [sessionId],
  })).rows;
  if (!rows[0]) return {};
  try {
    const payload = JSON.parse(String(rows[0].payload)) as Record<string, unknown>;
    const summary = asString(payload.summary);
    const changedPaths = Array.isArray(payload.changedPaths)
      ? payload.changedPaths.filter((value): value is string => typeof value === 'string').slice(0, 20)
      : undefined;
    return { summary, changedPaths };
  } catch {
    return {};
  }
}

async function findActivePendingHandoff(projectId: string) {
  void projectId;
  const conflictKey = normalizeConflictKey(PENDING_HANDOFF_CONFLICT_KEY);
  const rows = await getClient().execute({
    sql: `SELECT id, content, tags FROM knowledge_items
      WHERE status = 'active' AND category = 'state' AND conflict_key = ?
      ORDER BY updated_at DESC
      LIMIT 5`,
    args: [conflictKey],
  });
  for (const row of rows.rows) {
    const handoff = parseHandoffContent(String(row.content));
    if (!handoff || handoff.consumed) continue;
    return { id: String(row.id), handoff };
  }
  return null;
}

export function formatPendingHandoffContext(handoff: PendingHandoff): string {
  const lines = [
    '# KNOWL - PENDING SESSION HANDOFF',
    '',
    'Previous host session ended before a clean finish. Continue from this handoff first.',
    '',
    `- Kind: ${handoff.kind}`,
    `- Urgency: ${handoff.urgency}`,
    `- Host: ${handoff.host}`,
    `- Failed at: ${handoff.failedAt}`,
    `- External session: ${handoff.externalSessionId}`,
  ];
  if (handoff.memorySessionId) lines.push(`- Memory session: ${handoff.memorySessionId}`);
  if (handoff.sessionTitle) lines.push(`- Session title: ${handoff.sessionTitle}`);
  if (handoff.errorCode) lines.push(`- Error code: ${handoff.errorCode}`);
  if (handoff.errorMessage) lines.push(`- Error: ${handoff.errorMessage}`);
  if (handoff.lastCheckpoint) lines.push(`- Last checkpoint: ${handoff.lastCheckpoint}`);
  if (handoff.changedPaths?.length) lines.push(`- Changed paths: ${handoff.changedPaths.join(', ')}`);
  lines.push('', 'Do not restart from scratch. Resume the interrupted work using this handoff plus recent project memory.');
  return truncateText(lines.join('\n'), DEFAULT_CONTEXT_MAX_CHARS);
}

export async function recordPendingSessionHandoff(
  projectId: string,
  input: NormalizedHostHook,
  options: { memorySessionId?: string } = {},
): Promise<{ itemId: string; handoff: PendingHandoff } | null> {
  const kind = detectSessionFailureKind(input.payload, input.status);
  if (!kind) return null;

  let sessionTitle: string | undefined;
  let lastCheckpoint: string | undefined;
  let changedPaths: string[] | undefined;
  if (options.memorySessionId) {
    try {
      const session = await getMemorySession(options.memorySessionId);
      sessionTitle = session.title;
    } catch {
      // Session may already be terminal or missing; handoff still records host failure.
    }
    const checkpoint = await loadLatestSessionCheckpoint(options.memorySessionId);
    lastCheckpoint = checkpoint.summary;
    changedPaths = checkpoint.changedPaths;
  }

  const handoff: PendingHandoff = {
    kind,
    urgency: kind === 'rate_limit' ? RATE_LIMIT_URGENCY : GENERIC_FAILURE_URGENCY,
    host: String(input.host),
    projectRoot: input.projectRoot,
    externalSessionId: input.externalSessionId,
    memorySessionId: options.memorySessionId,
    sessionTitle,
    errorCode: asString(input.payload.error ?? input.payload.code ?? input.payload.error_code, 200),
    errorMessage: asString(input.payload.message ?? input.payload.summary ?? input.payload.error_message, 500),
    lastCheckpoint,
    changedPaths,
    failedAt: new Date().toISOString(),
    consumed: false,
  };

  const existing = await findActivePendingHandoff(projectId);
  if (existing) {
    const updated = await repo.updateKnowledgeItem(existing.id, {
      title: PENDING_HANDOFF_TITLE,
      content: JSON.stringify(handoff),
      tags: ['pending_handoff', kind, handoff.urgency, String(input.host)],
      source: `host://${input.host}/session-failure`,
      freshness: 'fresh',
      confidence: kind === 'rate_limit' ? 1 : 0.9,
      conflictKey: PENDING_HANDOFF_CONFLICT_KEY,
      conflictExclusive: true,
    });
    await repo.createKnowledgeCommit(projectId, `Update pending session handoff (${kind})`, [
      { itemId: updated.id, action: 'update', before: existing.handoff as any, after: updated },
    ]);
    return { itemId: updated.id, handoff };
  }

  const created = await repo.createKnowledgeItem(projectId, {
    category: 'state',
    title: PENDING_HANDOFF_TITLE,
    content: JSON.stringify(handoff),
    tags: ['pending_handoff', kind, handoff.urgency, String(input.host)],
    source: `host://${input.host}/session-failure`,
    freshness: 'fresh',
    confidence: kind === 'rate_limit' ? 1 : 0.9,
    conflictKey: PENDING_HANDOFF_CONFLICT_KEY,
    conflictExclusive: true,
  });
  await repo.createKnowledgeCommit(projectId, `Record pending session handoff (${kind})`, [
    { itemId: created.id, action: 'insert', after: created },
  ]);
  return { itemId: created.id, handoff };
}

export async function consumePendingSessionHandoff(
  projectId: string,
): Promise<{ itemId: string; handoff: PendingHandoff; context: string } | null> {
  const existing = await findActivePendingHandoff(projectId);
  if (!existing) return null;

  const consumed: PendingHandoff = {
    ...existing.handoff,
    consumed: true,
    consumedAt: new Date().toISOString(),
  };
  const updated = await repo.updateKnowledgeItem(existing.id, {
    content: JSON.stringify(consumed),
    status: 'archived',
    freshness: 'stale',
    tags: ['pending_handoff', existing.handoff.kind, existing.handoff.urgency, existing.handoff.host, 'consumed'],
  });
  await repo.createKnowledgeCommit(projectId, `Consume pending session handoff (${existing.handoff.kind})`, [
    { itemId: updated.id, action: 'archive', after: updated },
  ]);

  return {
    itemId: updated.id,
    handoff: existing.handoff,
    context: formatPendingHandoffContext(existing.handoff),
  };
}
