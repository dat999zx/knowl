import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';
import { normalizeConflictKey } from './conflicts.js';
import * as repo from './repository.js';
import { getClient } from './database.js';
import { getMemorySession } from './session-repository.js';

export const PENDING_HANDOFF_TITLE = 'Pending session handoff';
export const RATE_LIMIT_URGENCY = 'critical';
export const AUTH_URGENCY = 'critical';
export const PROVIDER_OUTAGE_URGENCY = 'high';
export const INTERRUPTED_URGENCY = 'high';
export const GENERIC_FAILURE_URGENCY = 'high';

export type SessionFailureKind =
  | 'rate_limit'
  | 'auth'
  | 'provider_outage'
  | 'interrupted'
  | 'failed';

export type HandoffTaskState = {
  goal?: string;
  completed?: string[];
  nextAction?: string;
  blocker?: string;
  artifactRefs?: string[];
  verificationStatus?: string;
};

export type PendingHandoff = {
  kind: SessionFailureKind;
  urgency: typeof RATE_LIMIT_URGENCY | typeof AUTH_URGENCY | typeof PROVIDER_OUTAGE_URGENCY | typeof INTERRUPTED_URGENCY | typeof GENERIC_FAILURE_URGENCY;
  host: string;
  projectRoot: string;
  externalSessionId: string;
  memorySessionId?: string;
  sessionTitle?: string;
  errorCode?: string;
  errorMessage?: string;
  lastCheckpoint?: string;
  changedPaths?: string[];
  taskState?: HandoffTaskState;
  failedAt: string;
  consumed?: boolean;
  consumedAt?: string;
};

const RATE_LIMIT_CODES = [
  'rate_limit', 'rate-limit', 'ratelimit', 'usage_limit', 'usage-limit',
  'quota_exceeded', 'quota-exceeded', 'resource_exhausted', 'too_many_requests', '429',
];
const AUTH_CODES = [
  'auth', 'unauthorized', 'unauthenticated', 'authentication',
  'permission_denied', 'forbidden', '401', '403',
];
const PROVIDER_OUTAGE_CODES = [
  'provider_outage', 'service_unavailable', 'unavailable', 'overloaded',
  'internal_error', 'server_error', '502', '503', '504',
];
const INTERRUPTED_CODES = [
  'interrupted', 'cancelled', 'canceled', 'aborted', 'timeout', 'timed_out', 'deadline_exceeded',
];
const RATE_LIMIT_MESSAGES = [
  'rate limit', 'usage limit', 'quota exceeded', 'session limit', 'hit your limit', 'limit reached', 'too many requests',
];
const AUTH_MESSAGES = [
  'unauthorized', 'unauthenticated', 'invalid api key', 'authentication failed', 'permission denied',
];
const PROVIDER_OUTAGE_MESSAGES = [
  'service unavailable', 'provider unavailable', 'temporarily overloaded', 'internal server error',
];
const INTERRUPTED_MESSAGES = [
  'interrupted', 'cancelled', 'canceled', 'aborted', 'timed out', 'deadline exceeded',
];

function asString(value: unknown, max = 2_000): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;
}

function pendingHandoffConflictKey(host: string): string {
  return `pending-session-handoff:${host}`;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function collectStructuredCodes(payload: Record<string, unknown>): string[] {
  const codes: string[] = [];
  const push = (value: unknown) => {
    const text = asString(value, 200);
    if (text) codes.push(normalizeToken(text));
  };
  push(payload.error);
  push(payload.code);
  push(payload.error_code);
  push(payload.type);
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : undefined;
  if (nested) {
    push(nested.code);
    push(nested.type);
    push(nested.error);
    push(nested.name);
  }
  return codes;
}

function collectMessages(payload: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const push = (value: unknown) => {
    const text = asString(value, 500);
    if (text) messages.push(text.toLowerCase());
  };
  push(payload.message);
  push(payload.summary);
  push(payload.error_message);
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : undefined;
  if (nested) push(nested.message);
  const errorText = asString(payload.error, 500);
  if (errorText && errorText.includes(' ')) push(errorText);
  return messages;
}

function matchesAny(values: string[], needles: string[]): boolean {
  return values.some(value => needles.some(needle => value === needle || value.includes(needle)));
}

function matchesMessage(values: string[], needles: string[]): boolean {
  return values.some(value => needles.some(needle => value.includes(needle)));
}

function urgencyFor(kind: SessionFailureKind) {
  if (kind === 'rate_limit') return RATE_LIMIT_URGENCY;
  if (kind === 'auth') return AUTH_URGENCY;
  if (kind === 'provider_outage') return PROVIDER_OUTAGE_URGENCY;
  if (kind === 'interrupted') return INTERRUPTED_URGENCY;
  return GENERIC_FAILURE_URGENCY;
}

export function detectSessionFailureKind(
  payload: Record<string, unknown>,
  status?: 'finished' | 'failed',
): SessionFailureKind | null {
  if (status !== 'failed') return null;
  const codes = collectStructuredCodes(payload);
  if (matchesAny(codes, RATE_LIMIT_CODES)) return 'rate_limit';
  if (matchesAny(codes, AUTH_CODES)) return 'auth';
  if (matchesAny(codes, PROVIDER_OUTAGE_CODES)) return 'provider_outage';
  if (matchesAny(codes, INTERRUPTED_CODES)) return 'interrupted';
  const messages = collectMessages(payload);
  if (matchesMessage(messages, RATE_LIMIT_MESSAGES)) return 'rate_limit';
  if (matchesMessage(messages, AUTH_MESSAGES)) return 'auth';
  if (matchesMessage(messages, PROVIDER_OUTAGE_MESSAGES)) return 'provider_outage';
  if (matchesMessage(messages, INTERRUPTED_MESSAGES)) return 'interrupted';
  return 'failed';
}

function parseHandoffContent(content: string): PendingHandoff | null {
  try {
    const parsed = JSON.parse(content) as PendingHandoff;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!['rate_limit', 'auth', 'provider_outage', 'interrupted', 'failed'].includes(parsed.kind)) return null;
    if (!parsed.failedAt || !parsed.host || !parsed.projectRoot || !parsed.externalSessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stringList(value: unknown, maxItems = 20, maxLength = 2_000): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, maxItems)
    .map(entry => entry.trim().slice(0, maxLength));
  return values.length ? values : undefined;
}

function taskStateFromPayload(payload: Record<string, unknown>): HandoffTaskState | undefined {
  const taskState: HandoffTaskState = {
    goal: asString(payload.goal, 1_000),
    completed: stringList(payload.completed, 20, 500),
    nextAction: asString(payload.nextAction, 1_000),
    blocker: asString(payload.blocker, 1_000),
    artifactRefs: stringList(payload.artifactRefs, 20, 500),
    verificationStatus: asString(payload.verificationStatus, 100),
  };
  return Object.values(taskState).some(value => value !== undefined) ? taskState : undefined;
}

function mergeTaskState(existing: HandoffTaskState | undefined, incoming: HandoffTaskState | undefined): HandoffTaskState | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const taskState: HandoffTaskState = {
    goal: incoming.goal ?? existing.goal,
    completed: incoming.completed?.length ? incoming.completed : existing.completed,
    nextAction: incoming.nextAction ?? existing.nextAction,
    blocker: incoming.blocker ?? existing.blocker,
    artifactRefs: incoming.artifactRefs?.length ? incoming.artifactRefs : existing.artifactRefs,
    verificationStatus: incoming.verificationStatus ?? existing.verificationStatus,
  };
  return Object.values(taskState).some(value => value !== undefined) ? taskState : undefined;
}

function mergeHandoff(existing: PendingHandoff, incoming: PendingHandoff): PendingHandoff {
  return {
    ...incoming,
    memorySessionId: incoming.memorySessionId ?? existing.memorySessionId,
    sessionTitle: incoming.sessionTitle ?? existing.sessionTitle,
    errorCode: incoming.errorCode ?? existing.errorCode,
    errorMessage: incoming.errorMessage ?? existing.errorMessage,
    lastCheckpoint: incoming.lastCheckpoint ?? existing.lastCheckpoint,
    changedPaths: incoming.changedPaths?.length ? incoming.changedPaths : existing.changedPaths,
    taskState: mergeTaskState(existing.taskState, incoming.taskState),
  };
}

async function loadLatestSessionCheckpoint(sessionId: string): Promise<{ summary?: string; changedPaths?: string[]; taskState?: HandoffTaskState }> {
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
    return { summary, changedPaths, taskState: taskStateFromPayload(payload) };
  } catch {
    return {};
  }
}

async function findActivePendingHandoff(host: string) {
  const conflictKey = normalizeConflictKey(pendingHandoffConflictKey(host));
  const rows = await getClient().execute({
    sql: `SELECT id, content FROM knowledge_items
      WHERE status = 'active' AND category = 'state' AND conflict_key = ?
      ORDER BY updated_at DESC
      LIMIT 5`,
    args: [conflictKey],
  });
  for (const row of rows.rows) {
    const handoff = parseHandoffContent(String(row.content));
    if (!handoff || handoff.consumed) continue;
    if (handoff.host !== host) continue;
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
  if (handoff.taskState) {
    lines.push('', '## Task state');
    if (handoff.taskState.goal) lines.push(`- Goal: ${handoff.taskState.goal}`);
    if (handoff.taskState.completed?.length) lines.push(`- Completed: ${handoff.taskState.completed.join('; ')}`);
    if (handoff.taskState.nextAction) lines.push(`- Next action: ${handoff.taskState.nextAction}`);
    if (handoff.taskState.blocker) lines.push(`- Blocker: ${handoff.taskState.blocker}`);
    if (handoff.taskState.artifactRefs?.length) lines.push(`- Artifacts: ${handoff.taskState.artifactRefs.join(', ')}`);
    if (handoff.taskState.verificationStatus) lines.push(`- Verification: ${handoff.taskState.verificationStatus}`);
  }
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
  let taskState = taskStateFromPayload(input.payload);
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
    taskState = mergeTaskState(checkpoint.taskState, taskState);
  }

  const host = String(input.host);
  const handoff: PendingHandoff = {
    kind,
    urgency: urgencyFor(kind),
    host,
    projectRoot: input.projectRoot,
    externalSessionId: input.externalSessionId,
    memorySessionId: options.memorySessionId,
    sessionTitle,
    errorCode: asString(input.payload.error ?? input.payload.code ?? input.payload.error_code, 200),
    errorMessage: asString(input.payload.message ?? input.payload.summary ?? input.payload.error_message, 500),
    lastCheckpoint,
    changedPaths,
    taskState,
    failedAt: new Date().toISOString(),
    consumed: false,
  };

  const conflictKey = pendingHandoffConflictKey(host);
  const identity = {
    host,
    externalSessionId: handoff.externalSessionId,
  };
  const existing = await findActivePendingHandoff(host);
  if (existing) {
    // One active handoff per host. Only repeated failures from the same host session merge.
    const mergedHandoff = existing.handoff.externalSessionId === handoff.externalSessionId
      ? mergeHandoff(existing.handoff, handoff)
      : handoff;
    const updated = await repo.updateKnowledgeItem(existing.id, {
      title: PENDING_HANDOFF_TITLE,
      content: JSON.stringify(mergedHandoff),
      tags: ['pending_handoff', kind, mergedHandoff.urgency, host, `session:${mergedHandoff.externalSessionId}`],
      source: `host://${host}/session-failure`,
      freshness: 'fresh',
      confidence: kind === 'rate_limit' || kind === 'auth' ? 1 : 0.9,
      conflictKey,
      conflictScope: identity,
      conflictExclusive: true,
    });
    await repo.createKnowledgeCommit(projectId, `Update pending session handoff (${host}/${kind})`, [
      { itemId: updated.id, action: 'update', before: existing.handoff as any, after: updated },
    ]);
    return { itemId: updated.id, handoff: mergedHandoff };
  }

  const created = await repo.createKnowledgeItem(projectId, {
    category: 'state',
    title: PENDING_HANDOFF_TITLE,
    content: JSON.stringify(handoff),
    tags: ['pending_handoff', kind, handoff.urgency, host, `session:${handoff.externalSessionId}`],
    source: `host://${host}/session-failure`,
    freshness: 'fresh',
    confidence: kind === 'rate_limit' || kind === 'auth' ? 1 : 0.9,
    conflictKey,
    conflictScope: identity,
    conflictExclusive: true,
  });
  await repo.createKnowledgeCommit(projectId, `Record pending session handoff (${host}/${kind})`, [
    { itemId: created.id, action: 'insert', after: created },
  ]);
  return { itemId: created.id, handoff };
}

export async function consumePendingSessionHandoff(
  projectId: string,
  host: string,
): Promise<{ itemId: string; handoff: PendingHandoff; context: string } | null> {
  const existing = await findActivePendingHandoff(host);
  if (!existing) return null;

  const claim = await getClient().execute({
    sql: `UPDATE knowledge_items
      SET status = 'archived', freshness = 'stale', updated_at = ?
      WHERE id = ? AND status = 'active'`,
    args: [new Date().toISOString(), existing.id],
  });
  if (Number(claim.rowsAffected ?? 0) === 0) return null;

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
  await repo.createKnowledgeCommit(projectId, `Consume pending session handoff (${host}/${existing.handoff.kind})`, [
    { itemId: updated.id, action: 'archive', after: updated },
  ]);

  return {
    itemId: updated.id,
    handoff: existing.handoff,
    context: formatPendingHandoffContext(existing.handoff),
  };
}
