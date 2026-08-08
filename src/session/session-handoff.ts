import { NormalizedHostHook } from '../core/host-hook-types.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';
import { inlineUntrusted } from '../core/untrusted.js';
import { normalizeConflictKey } from '../store/conflicts.js';
import * as repo from '../store/repository.js';
import { getClient } from '../store/database.js';
import { getMemorySession } from '../store/session-repository.js';

export const PENDING_HANDOFF_TITLE = 'Pending session handoff';
export const RATE_LIMIT_URGENCY = 'critical';
export const AUTH_URGENCY = 'critical';
export const PROVIDER_OUTAGE_URGENCY = 'high';
export const INTERRUPTED_URGENCY = 'high';
export const GENERIC_FAILURE_URGENCY = 'high';
/** Not an urgency in the alarm sense. A parked baton is waiting, not burning. */
export const HANDOFF_URGENCY = 'planned';

/**
 * Every kind a pending handoff can carry.
 *
 * `handoff` is the one that is not a failure: the user parked a workstream deliberately. It
 * rides the same slot, claim and delivery machinery as a crash, because none of that differs --
 * only the opening the receiving session should read.
 *
 * A single `const` the type, the writer and the parser all derive from. They used to be two
 * hand-maintained copies, and the parser's copy was the shorter one: a kind added to the type
 * was written successfully and then dropped on every read, with nothing to notice at write time.
 */
export const SESSION_HANDOFF_KINDS = [
  'handoff',
  'rate_limit',
  'auth',
  'provider_outage',
  'interrupted',
  'failed',
] as const;

export type SessionFailureKind = typeof SESSION_HANDOFF_KINDS[number];

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
  urgency:
    | typeof RATE_LIMIT_URGENCY
    | typeof AUTH_URGENCY
    | typeof PROVIDER_OUTAGE_URGENCY
    | typeof INTERRUPTED_URGENCY
    | typeof GENERIC_FAILURE_URGENCY
    | typeof HANDOFF_URGENCY;
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
  // Unreachable from failure detection, which never returns 'handoff' -- but this is a
  // hand-maintained kind map, and an unhandled member falling through to 'high' would tell
  // the next reader a parked baton is burning. The same trap the kind list itself had.
  if (kind === 'handoff') return HANDOFF_URGENCY;
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
    // Derived, never a second copy: a hand-maintained duplicate here is what made a newly
    // added kind unreadable.
    if (!(SESSION_HANDOFF_KINDS as readonly string[]).includes(parsed.kind)) return null;
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
  // A planned baton and a crash both arrive here and deserve opposite openings: one resumes
  // work, the other recovers from a blocker. Telling a session that parked cleanly it "ended
  // before a clean finish" invites it to go looking for damage that does not exist.
  const planned = handoff.kind === 'handoff';
  // This card is injected at SessionStart with no human in the loop, and every value below
  // reaches it as raw text on a `- Label: value` line. A value carrying a newline used to break
  // out to column 0, where an ATX heading or a fence opener is live markdown -- so `errorMessage`,
  // which is a string from an external host process rather than anything an agent wrote, could
  // put `## SYSTEM` into the first thing a fresh session reads.
  //
  // Every value is contained, with no triage over which ones are "really" untrusted. The set of
  // host-supplied fields grows as fields are added, and a rule with exceptions is the one that
  // gets forgotten at the next `lines.push`. Collapsing is a no-op on the one-line values.
  const field = (value: string) => inlineUntrusted(value);
  const lines = [
    planned ? '# KNOWL - SESSION HANDOFF' : '# KNOWL - PENDING SESSION HANDOFF',
    '',
    planned
      ? 'The previous session parked this work for you on purpose. Pick it up from here.'
      : 'Previous host session ended before a clean finish. Continue from this handoff first.',
    '',
    `- Kind: ${field(handoff.kind)}`,
    `- Urgency: ${field(handoff.urgency)}`,
    `- Host: ${field(handoff.host)}`,
    planned ? `- Parked at: ${field(handoff.failedAt)}` : `- Failed at: ${field(handoff.failedAt)}`,
    `- External session: ${field(handoff.externalSessionId)}`,
  ];
  if (handoff.memorySessionId) lines.push(`- Memory session: ${field(handoff.memorySessionId)}`);
  if (handoff.sessionTitle) lines.push(`- Session title: ${field(handoff.sessionTitle)}`);
  if (handoff.errorCode) lines.push(`- Error code: ${field(handoff.errorCode)}`);
  if (handoff.errorMessage) lines.push(`- Error: ${field(handoff.errorMessage)}`);
  if (handoff.lastCheckpoint) lines.push(`- Last checkpoint: ${field(handoff.lastCheckpoint)}`);
  if (handoff.changedPaths?.length) lines.push(`- Changed paths: ${field(handoff.changedPaths.join(', '))}`);
  if (handoff.taskState) {
    lines.push('', '## Task state');
    if (handoff.taskState.goal) lines.push(`- Goal: ${field(handoff.taskState.goal)}`);
    if (handoff.taskState.completed?.length) lines.push(`- Completed: ${field(handoff.taskState.completed.join('; '))}`);
    if (handoff.taskState.nextAction) lines.push(`- Next action: ${field(handoff.taskState.nextAction)}`);
    if (handoff.taskState.blocker) lines.push(`- Blocker: ${field(handoff.taskState.blocker)}`);
    if (handoff.taskState.artifactRefs?.length) lines.push(`- Artifacts: ${field(handoff.taskState.artifactRefs.join(', '))}`);
    if (handoff.taskState.verificationStatus) lines.push(`- Verification: ${field(handoff.taskState.verificationStatus)}`);
  }
  lines.push('', 'Do not restart from scratch. Resume the interrupted work using this handoff plus recent project memory.');
  return truncateText(lines.join('\n'), DEFAULT_CONTEXT_MAX_CHARS);
}

function confidenceFor(kind: SessionFailureKind): number {
  // A deliberate baton is a user act and a rate limit or auth failure is read straight off a
  // structured code. Everything else is inference from a message, and inference can be wrong.
  return kind === 'handoff' || kind === 'rate_limit' || kind === 'auth' ? 1 : 0.9;
}

/**
 * The single write path for a pending handoff, whatever its kind.
 *
 * Slot lookup, conflict identity, replacement of whatever is already pending, and the knowledge
 * commit all live here. A crash and a deliberate baton differ only in `merge`, so there is no
 * second copy of this to drift out of step with the first.
 */
async function persistPendingHandoff(
  projectId: string,
  handoff: PendingHandoff,
  options: { merge: boolean },
): Promise<{ itemId: string; handoff: PendingHandoff; replacedPrevious: boolean }> {
  const host = handoff.host;
  // Normalized here because `findActivePendingHandoff` looks the slot up normalized. Passing
  // the raw spelling survived a create, which normalizes for us, but an update wrote it
  // through verbatim -- leaving the row active and permanently undeliverable.
  const conflictKey = normalizeConflictKey(pendingHandoffConflictKey(host));
  const identity = { host, externalSessionId: handoff.externalSessionId };
  const write = (value: PendingHandoff) => ({
    title: PENDING_HANDOFF_TITLE,
    content: JSON.stringify(value),
    tags: ['pending_handoff', value.kind, value.urgency, host, `session:${value.externalSessionId}`],
    source: `host://${host}/${value.kind === 'handoff' ? 'session-handoff' : 'session-failure'}`,
    freshness: 'fresh' as const,
    confidence: confidenceFor(value.kind),
    conflictKey,
    conflictScope: identity,
    conflictExclusive: true,
  });

  const existing = await findActivePendingHandoff(host);
  if (existing) {
    // One active handoff per host. Only repeated failures from the same host session merge.
    const extendsExisting = options.merge && existing.handoff.externalSessionId === handoff.externalSessionId;
    const merged = extendsExisting ? mergeHandoff(existing.handoff, handoff) : handoff;
    const updated = await repo.updateKnowledgeItem(existing.id, write(merged));
    await repo.createKnowledgeCommit(projectId, `Update pending session handoff (${host}/${merged.kind})`, [
      { itemId: updated.id, action: 'update', before: existing.handoff as any, after: updated },
    ]);
    // A merge extends the same session's baton; anything else overwrote a different active
    // handoff whose contents are now gone. The caller reports which, so parking again does not
    // silently discard a baton the schema comment itself calls "the destruction of the real one".
    //
    // Read off the branch that decided it, not off object identity: `mergeHandoff` always
    // allocates, so `merged !== existing.handoff` reported a replacement for every merge too --
    // wrong the moment any caller passes `merge: true` and surfaces this. Today only
    // `recordDeliberateHandoff` reads it, and it never merges, so the identity test happened to
    // agree with the intent. Latent agreement is not the same as saying what you mean.
    return { itemId: updated.id, handoff: merged, replacedPrevious: !extendsExisting };
  }

  const created = await repo.createKnowledgeItem(projectId, { category: 'state', ...write(handoff) });
  await repo.createKnowledgeCommit(projectId, `Record pending session handoff (${host}/${handoff.kind})`, [
    { itemId: created.id, action: 'insert', after: created },
  ]);
  return { itemId: created.id, handoff, replacedPrevious: false };
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

  const handoff: PendingHandoff = {
    kind,
    urgency: urgencyFor(kind),
    host: String(input.host),
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

  // Repeated failures from one host session accumulate detail rather than overwrite it.
  return persistPendingHandoff(projectId, handoff, { merge: true });
}

/**
 * Park a workstream on purpose.
 *
 * Same slot and same one-shot delivery as a crash handoff, so nothing new is built for the
 * receiving side -- only the kind differs, and with it the tone the next session opens in.
 *
 * One baton per project: an existing pending handoff is replaced. That is the right behaviour
 * for "I am leaving this session now", and it is also why this is a pass rather than a durable
 * note -- anything worth keeping goes to `knowl_store`.
 */
export async function recordDeliberateHandoff(
  projectId: string,
  input: {
    host: string;
    projectRoot: string;
    externalSessionId: string;
    sessionTitle?: string;
    taskState: HandoffTaskState;
  },
): Promise<{ itemId: string; handoff: PendingHandoff; replacedPrevious: boolean }> {
  const handoff: PendingHandoff = {
    kind: 'handoff',
    urgency: HANDOFF_URGENCY,
    host: input.host,
    projectRoot: input.projectRoot,
    externalSessionId: input.externalSessionId,
    sessionTitle: input.sessionTitle,
    taskState: input.taskState,
    // The same field a crash stamps. A parked baton renders it as "Parked at", so the slot
    // does not need a second timestamp column that only one kind ever fills.
    failedAt: new Date().toISOString(),
    consumed: false,
  };

  // Never merged. Parking again is a replacement by definition -- carrying the previous
  // baton's next action into the new one would hand the next session a stale instruction.
  return persistPendingHandoff(projectId, handoff, { merge: false });
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
