import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NormalizedHostHook } from '../core/host-hook-types.js';
import { renderChangeCard, type ImpactCardEntry } from './change-card.js';
import { hostProfile } from './hosts/index.js';
import { indexFile, listCodeSymbols } from '../code/symbol-index.js';
import {
  areSkillNudgesEnabled, driftReminderEvery, isDriftBackoffEnabled, loadConfig, shouldSendDriftReminder,
} from '../core/config.js';
import { isImpactEnabled } from '../store/impact-config.js';
import {
  captureCheckpointMode, captureEventsMode, captureNudgeMode, captureScope,
  CHECKPOINT_EVERY_TURNS,
} from '../store/capture-config.js';
import { classifyDestructiveCommand } from '../core/lesson-signals.js';
import {
  claimLessonBlock,
  markPendingLessons,
  claimAssumptionCheckpoint,
  openPendingLessons,
  recordCorrectionLesson,
  recordDestructiveLesson,
  renderCorrectionNudge,
  renderAssumptionCheckpoint,
  renderLessonNudge,
  renderLessonStopReason,
  resolveLessonsBefore,
} from '../store/pending-lessons.js';
import {
  claimSilenceNudge,
  claimTurnCapturePrompt,
  conversationKey,
  isDurableWriteTool,
  readCaptureOutcome,
  recordDurableWrite,
  recordSessionTurn,
  recordTurnToolEvent,
  renderSilenceNudge,
  renderTurnCapturePrompt,
  resetTurnCapture,
  shouldPromptTurnCapture,
  shouldNudgeForSilence,
  turnCaptureKey,
} from '../store/capture-outcome.js';
import { detectCertainImpactBestEffort, markFindingsDelivered, openFindingsForSession } from './impact.js';
import {
  recordReadsBestEffort, releaseReadSetBestEffort, repoRelativePath, sweepReadSetsBestEffort,
  type ReadObservation,
} from '../store/read-set.js';
import { shouldRefuseWrite } from './write-gate.js';
import { observeRecallGapBestEffort } from '../store/recall-gap.js';
import { KNOWL_CLAUDE_CONTINUATION_REMINDER, KNOWL_SUBAGENT_BOOTSTRAP_CARD } from '../core/knowl-guidance.js';
import { isKnowlProjectGuidanceCurrent } from '../core/agents-guidance.js';
import {
  ChangeSummary,
  loadChangesInRange,
  loadForeignChanges,
  loadForeignPeerChanges,
  mergeChangeSummaries,
  readCommitHead,
  readPeerCommitHeads,
} from '../store/change-watermark.js';
import { findRecentCallRanges, rangeBelongsToCaller, type CommitRange } from '../store/mcp-call-commits.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { captureMemorySessionEvent } from '../store/session-capture.js';
import { finalizeMemorySession } from '../store/session-finalizer.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions } from '../store/session-repository.js';
import { claimCapture, releaseCapture } from './hook-debounce.js';
import { countCommandRepeats, qualifiesForSkillCapture, renderSkillCaptureNudge } from '../store/skill-capture.js';
import { matchSkillForCommand, renderSkillUseNudge, type SurfacedSkill } from '../store/skill-surface.js';
import { toSurfacedSkills } from '../core/skill-surface.js';
import { listActiveSkillItems } from '../store/repository.js';
import {
  closeHostSessionBinding,
  closeHostSessionBindings,
  closeInactiveHostSessionBindings,
  bindHostSession,
  findHostSession,
  getOrCreateHostSession,
  HostSessionKey,
  incrementHostSuccessfulToolCount,
  readHostSeenPeerCommits,
  readHostWatermark,
  resetHostSuccessfulToolCount,
  setHostSeenCommit,
  setHostSeenPeerCommits,
} from './host-session-bindings.js';
import { bootstrapAgentSession } from '../store/context-bootstrap.js';
import { consumePendingSessionHandoff, recordPendingSessionHandoff } from './session-handoff.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';
import { describeAutoDrift, runAutoDriftCheckBestEffort, type AutoDriftResult } from '../store/drift-auto.js';
import { describeObservedUsePromotions, promoteByObservedUseBestEffort } from '../store/tier.js';

// The cadence moved to `reminders.driftEvery` (default DEFAULT_DRIFT_REMINDER_EVERY = 12, `0`
// off), so the number lives beside its predicate in core/config.ts rather than twice.

/**
 * The tools whose paths become a read-set entry -- and the two that look like they belong here
 * and deliberately do not.
 *
 * A read-set row asserts "this session saw this text and holds a belief about it", and the
 * certain tier spends that assertion by interrupting the agent and, once the gate is enforcing,
 * refusing its write. So the
 * set is the tools that return *contents*: `Read`, and `NotebookRead`, whose target the host names
 * `notebook_path` rather than `file_path` -- which is why that key had to be added to `changedPaths`
 * and to the stdin allowlist in the same change, or this entry would have named a tool whose paths
 * never arrive.
 *
 * `Grep` and `Glob` are read-ish and are excluded. Their `path` argument is usually a directory,
 * which `normalizeLocator` already refuses -- but the case that decides this is the one where it
 * is a file. `Grep` returns matching lines and `Glob` returns names; recording either as a read
 * of that file would write one row per symbol in it, claiming the agent saw signatures it never
 * received. The next edit to any of those symbols then fires against a belief the session does
 * not hold: a fabricated false positive, pushed into tool-side context, which AgentNoiseBench
 * measures at ~20.8% mean accuracy cost to the agent receiving it. The trade is the one
 * `normalizeLocator`'s own directory heuristic already makes in this subsystem -- recall on a
 * tier allowed to be incomplete, never precision on the one tier allowed to interrupt.
 *
 * Matched verbatim and case-sensitively against the host's own name (`host-hook.ts:42` keeps it
 * raw for exactly this judgement). A host whose tool vocabulary has not been read is silent here
 * rather than guessed at, for the same asymmetry.
 */
const IMPACT_READ_TOOLS = new Set(['Read', 'NotebookRead']);

/** The write tools whose paths trigger a re-index and certain-tier detection. */
const IMPACT_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether this event read or wrote a file, in the vocabulary of the host that sent it.
 *
 * The two sets above are Claude Code's names, and they were consulted for every host. On any
 * other one they matched nothing: reads were never recorded, so the detector had no beliefs to
 * invalidate, and writes were never recognised, so `runWriteGate` returned "no opinion" before
 * it ever asked the profile whether it could refuse. A host could therefore declare a working
 * deny channel and be structurally unable to reach it.
 *
 * A declared predicate **replaces** the fallback rather than layering over it, so a host that
 * declares one is saying "these and nothing else". The fallback remains Claude Code's names,
 * which is what `claude`, `generic` and `claude-desktop` still use; every other host now
 * declares its own, including `codex`, whose tool is `apply_patch`.
 */
function toolReadsFile(input: NormalizedHostHook): boolean {
  const { readsFiles } = hostProfile(input.host);
  const toolName = input.toolName ?? '';
  return readsFiles
    ? readsFiles(input.hostEvent ?? '', toolName)
    : IMPACT_READ_TOOLS.has(toolName);
}

function toolWritesFile(input: NormalizedHostHook): boolean {
  const { writesFiles, writeTools } = hostProfile(input.host);
  const toolName = input.toolName ?? '';
  if (writesFiles) return writesFiles(input.hostEvent ?? '', toolName);
  // Preferred over the fallback set when a host declares it, so the gate and the pre-tool
  // matcher built from the same list can never disagree about what a write is.
  if (writeTools) return writeTools.includes(toolName);
  return IMPACT_WRITE_TOOLS.has(toolName);
}


/**
 * Symbols above which one read records a single `file://` row instead of one row per symbol.
 *
 * A barrel file, a generated client or a large module carries hundreds of symbols, and a single
 * `Read` of one would otherwise write hundreds of rows -- on a path that runs per tool call,
 * against a subsystem whose own measurement target is "steady-state rows bounded post-GC"
 * (plan §9). The coarse row is a degradation and not silence: the reader stays detectable at file
 * granularity and loses only per-symbol discrimination. 200 matches `READ_SET_CHUNK`, so the
 * fallback also keeps one file's candidate list inside one `IN (...)` batch on the detector side.
 */
const IMPACT_MAX_SYMBOLS_PER_READ = 200;

/**
 * Paths considered from one tool event. `host-hook.ts:128` already caps its own hosts at 50;
 * `normalizeGeneric` copies `changedPaths` through uncapped, so a host that reports a thousand
 * paths would otherwise index and hash all of them inside one agent's tool call.
 */
const IMPACT_MAX_PATHS = 50;

/**
 * How long a *released* read-set row is kept before the sweep collects it.
 *
 * Matches `SESSION_TTL_HOURS` deliberately: a released row's only remaining job is to be the
 * evidence a finding was justified, and a finding cannot be adjudicated after the session that
 * held the read is gone. Keeping rows materially longer than sessions collects storage for a
 * denominator nobody can still add to; keeping them shorter would delete the evidence before the
 * finding it justified was resolved.
 *
 * Unreleased rows are never touched at any age -- see `sweepReadSets`. A session open for a week
 * is the case this subsystem exists for, not garbage.
 */
const READ_SET_RETENTION_HOURS = 7 * 24;

const plusHoursIso = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

export type HostLifecycleResult = {
  accepted: boolean;
  reason?: 'event-loss' | 'debounced';
  sessionId?: string;
  context?: string;
  contextTruncated?: boolean;
  recoveredCount?: number;
  purgedEventCount?: number;
  promotion?: Awaited<ReturnType<typeof finalizeMemorySession>>;
  handoff?: Awaited<ReturnType<typeof recordPendingSessionHandoff>>;
  hostOutput?: Record<string, unknown>;
  /**
   * The refusal text, present only when this result *is* a deliverable refusal.
   *
   * The reason itself rather than a flag, so a host whose deny channel carries no JSON renders
   * the same string the envelope carries and the two channels cannot drift into disagreeing
   * about what the agent was told. Set only once `denyToolCall` has actually produced an
   * envelope: a host that declines to produce one degrades to allowing the write, and a bare
   * boolean here would have turned that documented degradation into a block with an invented
   * reason attached.
   */
  denied?: string;
  changes?: ChangeSummary;
  drift?: AutoDriftResult;
};

function bindingKey(input: NormalizedHostHook, scope: 'session' | 'turn'): HostSessionKey {
  return {
    host: input.host,
    projectRoot: input.projectRoot,
    externalSessionId: input.externalSessionId,
    // A Claude subagent has no turn id but always has an agent id, so its events get
    // their own row: its own drift counter and its own watermark, isolated from
    // siblings and from the main thread. Main-thread events keep `__turn__`.
    externalTurnId: scope === 'session'
      ? '__session__'
      : input.agentId
        ? `__agent__:${input.agentId}`
        : input.externalTurnId ?? '__turn__',
  };
}

function hostContextOutput(input: NormalizedHostHook, context: string | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  // Hosts with no native protocol — `generic` — return undefined, so the host-neutral
  // lifecycle result ({ accepted, sessionId, context, ... }) reaches the caller intact.
  return hostProfile(input.host).startContext(input.event, context);
}

function mergeBootstrapContext(handoffContext: string | undefined, recentContext: string | undefined): { context?: string; truncated: boolean } {
  if (!handoffContext && !recentContext) return { context: undefined, truncated: false };
  if (!handoffContext) {
    return {
      context: recentContext,
      truncated: Boolean(recentContext && recentContext.length > DEFAULT_CONTEXT_MAX_CHARS),
    };
  }

  const handoff = truncateText(handoffContext, DEFAULT_CONTEXT_MAX_CHARS);
  if (!recentContext) {
    return {
      context: handoff,
      truncated: handoffContext.length > DEFAULT_CONTEXT_MAX_CHARS,
    };
  }

  const separator = '\n\n';
  const remaining = Math.max(0, DEFAULT_CONTEXT_MAX_CHARS - handoff.length - separator.length);
  if (remaining <= 0) return { context: handoff, truncated: true };
  const recent = truncateText(recentContext, remaining, '\n\n[Context truncated]');
  return {
    context: `${handoff}${separator}${recent}`,
    truncated: handoffContext.length > DEFAULT_CONTEXT_MAX_CHARS || recentContext.length > remaining,
  };
}

async function startBoundSession(projectId: string, input: NormalizedHostHook, scope: 'session' | 'turn', includeContext = false) {
  return getOrCreateHostSession({
    projectId,
    ...bindingKey(input, scope),
    title: input.title ?? (scope === 'session' ? 'Agent session' : 'Agent turn'),
    includeContext,
  });
}

async function bootstrapWithHandoff(projectId: string, input: NormalizedHostHook, scope: 'session' | 'turn', includeContext: boolean) {
  const started = await startBoundSession(projectId, input, scope, includeContext);
  if (!includeContext) return { ...started, handoff: null as Awaited<ReturnType<typeof consumePendingSessionHandoff>> };

  const handoff = await consumePendingSessionHandoff(projectId, String(input.host));
  const merged = mergeBootstrapContext(handoff?.context, started.context);
  return {
    ...started,
    context: merged.context,
    truncated: merged.truncated,
    handoff,
  };
}

// Subagent bootstrap deliberately halves the recent-context cap: fan-out multiplies
// whatever a subagent costs. The guidance card is prepended rather than left to the
// prompt reminder, because a subagent receives no prompt event and a live probe confirmed
// MCP server instructions do not reach it either — without the card it gets memory data
// and nothing telling it to use memory. The card is charged against the cap first so a
// large recent-context block can never truncate the guidance away.
async function bootstrapAgentContext(projectId: string, input: NormalizedHostHook, sessionId: string) {
  const bootstrap = await bootstrapAgentSession({
    projectId,
    title: input.title ?? 'Agent session (subagent)',
    agent: String(input.host),
    sessionId,
  }, { includeContext: true });
  const cap = Math.floor(DEFAULT_CONTEXT_MAX_CHARS / 2);
  const recentBudget = Math.max(0, cap - KNOWL_SUBAGENT_BOOTSTRAP_CARD.length - 2);
  const recent = bootstrap.context ? truncateText(bootstrap.context, recentBudget) : undefined;
  const context = recent ? `${KNOWL_SUBAGENT_BOOTSTRAP_CARD}\n\n${recent}` : KNOWL_SUBAGENT_BOOTSTRAP_CARD;
  return { context, truncated: Boolean(bootstrap.context && bootstrap.context.length > recentBudget) };
}

/**
 * Ordered watermark rule. Always advances to head; returns only the changes that are
 * not the caller's own. Returns undefined when there is nothing to report, which
 * includes the uninitialised and clamp cases.
 */
async function evaluateLocalChanges(
  input: NormalizedHostHook,
  key: HostSessionKey,
): Promise<ChangeSummary | undefined> {
  const head = await readCommitHead();
  const watermark = await readHostWatermark(key);
  if (watermark === null) return undefined;

  // A row that has never had a watermark set -- one migrated by the ALTER TABLE -- adopts
  // head silently rather than reporting the entire history. Tracked by its own column
  // rather than inferred from `seen === 0`, which a session bound against a repo with no
  // commit history also produces, and which must report its first commit normally.
  if (!watermark.initialized) {
    await setHostSeenCommit(key, head);
    return undefined;
  }
  const seen = watermark.seen;
  // Snapshot restore reassigns rowids, so a stored watermark can exceed head.
  if (seen > head) {
    await setHostSeenCommit(key, head);
    return undefined;
  }
  if (seen === head) return undefined;

  // A confirmed range accounts for this call's work completely, so key matching is not
  // just unnecessary alongside it but harmful: it is the half that hides a foreign change
  // sharing a title. Keys are the fallback for when no range was recorded, never a
  // supplement to one.
  const ranges = await ownCommitRanges(input, seen, head);
  const summary = ranges
    ? await loadForeignChanges(seen, undefined, undefined, ranges)
    : await loadForeignChanges(seen, input.knowlChangeKeys);
  await setHostSeenCommit(key, head);
  return summary.count > 0 ? summary : undefined;
}

/**
 * Commit ranges in this window that this call demonstrably produced.
 *
 * The MCP server records the range each write produced, because it is the only party that
 * knows: it reads the head before dispatch, so its own commits are exactly the rows above
 * it. This side confirms a recorded range is its own by finding one of its own tool_input
 * keys inside it, then hands back the whole range.
 *
 * That is strictly better than the key matching it replaces, in both directions. A write's
 * indirect effects -- a dedup supersede of a differently-titled item, GC, promotion -- carry
 * none of the caller's keys and used to come back as somebody else's work; they fall inside
 * the range. And a foreign change that merely shares a title is no longer hidden, because
 * exclusion no longer looks at titles at all.
 *
 * Returns nothing when no range matches, leaving the key-matching fallback in place: a CLI
 * write, an older MCP server, or a host that does not report tool names all land there.
 */
async function ownCommitRanges(
  input: NormalizedHostHook,
  seen: number,
  head: number,
): Promise<CommitRange[] | undefined> {
  if (!input.knowlToolName || !input.knowlChangeKeys) return undefined;
  try {
    const candidates = await findRecentCallRanges(input.projectRoot, input.knowlToolName);
    const owned: CommitRange[] = [];
    for (const range of candidates) {
      // Only ranges inside the window being reported can affect its outcome.
      if (range.to <= seen || range.from >= head) continue;
      if (rangeBelongsToCaller(await loadChangesInRange(range), input.knowlChangeKeys)) owned.push(range);
    }
    return owned.length > 0 ? owned : undefined;
  } catch {
    return undefined; // fall back to key matching rather than failing the tool event
  }
}

/**
 * The same watermark rule, applied per peer repo.
 *
 * Peers are tracked separately rather than folded into one number because their commit
 * rowids are independent sequences -- repo A's rowid 40 says nothing about repo B's.
 * A peer seen for the first time adopts its head silently, exactly as the local repo
 * does, so linking a workspace never replays a peer's entire history at you.
 */
async function evaluatePeerChanges(
  projectRoot: string,
  key: HostSessionKey,
): Promise<ChangeSummary[]> {
  const workspace = await resolveWorkspace(projectRoot).catch(() => null);
  if (!workspace || workspace.peers.length === 0) return [];

  const heads = await readPeerCommitHeads(workspace.peers);
  if (Object.keys(heads).length === 0) return [];

  const stored = await readHostSeenPeerCommits(key);
  const next = { ...(stored ?? {}) };
  const summaries: ChangeSummary[] = [];

  for (const peer of workspace.peers) {
    const head = heads[peer.name];
    if (head === undefined) continue; // unreadable this time; leave its watermark alone
    const seen = stored?.[peer.name];
    next[peer.name] = head;
    // Unknown peer, or a watermark left past head by a snapshot restore: adopt silently.
    if (seen === undefined || seen >= head) continue;
    try {
      const summary = await loadForeignPeerChanges(peer, seen);
      if (summary.count > 0) summaries.push(summary);
    } catch {
      // Readable a moment ago, unreadable now. Roll this peer's watermark back so the
      // window is retried rather than skipped.
      next[peer.name] = seen;
    }
  }

  await setHostSeenPeerCommits(key, next);
  return summaries;
}

async function evaluateChangeNotification(
  input: NormalizedHostHook,
  key: HostSessionKey,
): Promise<ChangeSummary | undefined> {
  const local = await evaluateLocalChanges(input, key);
  const peers = await evaluatePeerChanges(input.projectRoot, key);
  return mergeChangeSummaries([...(local ? [local] : []), ...peers]);
}

/**
 * Whether this repository asked for change-impact detection. The single gate: capture,
 * detection, delivery and the gate itself all hang off this one boolean, so a repository that
 * never opted in writes no read-set row, produces no finding, and receives a card byte-identical
 * to the one it gets today.
 *
 * Loaded per event rather than cached in module state. The hook path is a one-shot process per
 * tool call, where a cache saves nothing; in the long-lived `serve` process a cache would mean
 * that turning the flag *off* -- the direction that matters, since the subsystem spends the
 * agent's context -- needs a restart to take effect. The cost is a read this path already pays:
 * `evaluatePeerChanges` -> `resolveWorkspace` loads the same file on the same events.
 *
 * `.catch(() => null)` because `loadConfig` throws on a missing or unreadable config, and an
 * unreadable config is the off case by the same rule `isImpactEnabled` states: every failure mode
 * of this subsystem is a failure of turning it on.
 */
async function impactEnabled(projectRoot: string): Promise<boolean> {
  const config = await loadConfig(projectRoot).catch(() => null);
  return isImpactEnabled(config ?? undefined);
}

/**
 * The hash a `file://` observation records: raw bytes, sha256, no normalisation.
 *
 * Byte-for-byte the digest `impact.ts:118` takes when it later asks whether that file moved,
 * which is itself the digest `evidence-repository.ts:180` takes. Any other one -- utf-8
 * normalised, line endings folded, trimmed -- disagrees with the comparison side, and then every
 * `file://` read in the store looks changed the first time anybody writes anywhere near it.
 */
async function impactFileHash(root: string, relativePath: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(path.resolve(root, relativePath))).digest('hex');
  } catch {
    return null;
  }
}

/** The paths a tool event reported, bounded. Non-strings are dropped rather than stringified. */
function impactChangedPaths(payload: Record<string, unknown>): string[] {
  const value = payload.changedPaths;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, IMPACT_MAX_PATHS);
}

/**
 * Record what this session just read, at symbol granularity wherever the file yields symbols.
 *
 * **One `symbol://path#Name` row per symbol, not one `file://path` row per file.** This is the
 * single design difference between this and the only published system with the same shape:
 * STORM's own stated limitation is that file-level granularity makes "two agents editing
 * different functions in the same file" a false-positive rejection (plan §6). The certain tier is
 * the only tier allowed to push into an agent's context and refuse its write, held to ≥95%
 * precision, and file granularity spends that budget on edits that never touched anything the
 * reader saw. `file://` is recorded only when the file yields no symbols at all -- a non-code
 * file, a language with no grammar here, or a parse that produced nothing -- where the file hash
 * is the only observable there is.
 *
 * **`indexFile` first, rather than trusting the index as it stands.** The hash stored here is the
 * agent's belief, and a row left from an earlier version of the file is a hash the agent never
 * saw: the next write to that file would compare against it, find it moved, and report a
 * staleness the reader does not hold -- a manufactured false positive on the tier that may
 * interrupt. When the content has not moved, `indexFile` stops before the parse and the write.
 *
 * Locators are handed over verbatim for `recordReads` to normalise, so the canonical form is
 * decided in exactly one place (`normalizeLocator`); a second spelling of the same rule here is
 * not a bug anyone sees, it is a detector that quietly never fires.
 *
 * **Collected across every path, then written once.** A 200-symbol file used to cost three
 * statements per symbol, so a single `Read` spent ~600 sequential round trips before the agent got
 * its result -- on the per-tool-call path, which is the one place this subsystem promised to be
 * cheap. `recordReads` turns the same work into one SELECT, one UPDATE and a handful of multi-row
 * INSERTs, and into a single SELECT when the re-read learned nothing.
 *
 * One failed path does not cost the others: a file deleted between the tool call and this line is
 * ordinary traffic on a path that observes rather than acts, and its `continue` still leaves every
 * other path's observations in the batch.
 */
async function recordToolReads(input: NormalizedHostHook, sessionId: string, paths: string[]): Promise<void> {
  const observations: ReadObservation[] = [];

  for (const changed of paths) {
    try {
      // Shared with the write gate rather than copied: `listCodeSymbols` is a `WHERE file_path = ?`
      // equality, so a spelling that disagrees with the one the gate compares against does not
      // fail loudly -- one side stops matching the other and the subsystem quietly never fires.
      const relativePath = repoRelativePath(input.projectRoot, changed);
      if (relativePath === null) continue;
      await indexFile(input.projectRoot, relativePath);

      const observed: { locator: string; observedHash: string }[] = [];
      const symbols = await listCodeSymbols(relativePath);
      if (symbols.length > 0 && symbols.length <= IMPACT_MAX_SYMBOLS_PER_READ) {
        // A symbol the extractor gave no signature has no hash to compare against later, so a row
        // for it would be a belief nothing could ever falsify; `recordReads` drops it regardless.
        for (const symbol of symbols) {
          if (symbol.signatureHash) observed.push({ locator: symbol.locator, observedHash: symbol.signatureHash });
        }
      } else {
        const hash = await impactFileHash(input.projectRoot, relativePath);
        if (hash !== null) observed.push({ locator: `file://${relativePath}`, observedHash: hash });
      }

      for (const observation of observed) {
        observations.push({
          sessionId,
          // Recorded for provenance only: belief is session-scoped by `recordReads`' own dedupe
          // key, so a subagent and its parent share one belief per locator by design.
          agentId: input.agentId ?? null,
          locator: observation.locator,
          observedHash: observation.observedHash,
          toolName: input.toolName ?? null,
        });
      }
    } catch {
      // Observation is advisory; a tool call must never fail because we could not describe it.
    }
  }

  await recordReadsBestEffort(observations);
}

/**
 * This session's unresolved certain findings, in the shape the card renders.
 *
 * Queried on every tool event and not only after a write, because the writes that produce these
 * findings happen in *other* sessions: MCP cannot push and there is no async interrupt into a
 * running agent (plan §5 C-2), so a session learns at its next tool call or never.
 *
 * `path_json` is parsed rather than recomputed because it cannot be recomputed: by the time a
 * card is drawn, the only surviving record of the old state is a hash, and a hash does not render
 * (`impact.ts:79`). Parsing is guarded -- a row written by a different version, or truncated, must
 * degrade to a locator with no was/now pair rather than throw inside a hook.
 *
 * **Shown once, not once per tool call.** `undeliveredOnly` is what makes that true: an open
 * finding used to re-render on every subsequent tool event until somebody adjudicated it, which
 * spends the tool-side channel this subsystem's own argument says is expensive. The findings are
 * stamped `delivered_at` immediately after they are turned into entries, and `resolution` is left
 * alone -- delivery is a fact about the card, adjudication is a fact about the finding, and using
 * `dismissed` to quiet a repeat would have corrupted the ≥95% precision number (plan §9). The
 * finding stays open for the gate and stays in the denominator; it just stops shouting.
 *
 * Stamped after rendering rather than before, so a throw between the two leaves the finding
 * undelivered and it is shown next time. Repeating a card is a smaller failure than swallowing one.
 */
async function openImpactCardEntries(sessionId: string): Promise<ImpactCardEntry[]> {
  const findings = await openFindingsForSession(sessionId, 'certain', true);
  if (findings.length === 0) return [];
  const entries = findings.map(finding => {
    // No initializer: both the try and the catch assign it, so a `{}` here would be dead and
    // would hide a path where neither ran.
    let payload: Record<string, unknown>;
    try {
      payload = finding.pathJson ? JSON.parse(finding.pathJson) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    const asText = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
    return {
      locator: asText(payload.locator) ?? finding.causeLocator,
      wasSignature: asText(payload.observedSignature),
      nowSignature: asText(payload.currentSignature),
    };
  });
  await markFindingsDelivered(findings.map(finding => finding.id));
  return entries;
}

/**
 * The subsystem's whole presence on the tool path: capture on a read, detect on a write, and hand
 * back what this session has to be told.
 *
 * Returns entries rather than a card, so the single mid-turn slot stays one decision made in one
 * place (`:416-418`, pinned by `tests/mcp/dual-channel-notification.test.ts`).
 *
 * A write is *not* indexed here before detection, deliberately. `detectCertainImpact` re-indexes
 * each path itself, and it snapshots the pre-change signatures first because that snapshot is the
 * only surviving source of the card's `was:` line -- indexing here would overwrite it before the
 * detector could read it, and every card would announce a change with nothing to compare it to.
 * The session id is passed as the cause so the detector excludes it: a session is never told it
 * invalidated its own read.
 *
 * Totally contained. This runs inside the capture path of every tool call in every session, and a
 * memory server that breaks the agent it is trying to help has done more damage than the
 * staleness it was watching for. The two subsystem calls swallow their own failures; the outer
 * catch covers what sits between them -- the config read, the index, `listCodeSymbols`, and the
 * findings query, which is the one call here with no advisory wrapper of its own.
 */
async function runToolEventImpact(input: NormalizedHostHook, sessionId: string): Promise<ImpactCardEntry[]> {
  try {
    if (!await impactEnabled(input.projectRoot)) return [];

    const paths = impactChangedPaths(input.payload);
    if (paths.length > 0 && toolReadsFile(input)) {
      await recordToolReads(input, sessionId, paths);
    } else if (paths.length > 0 && toolWritesFile(input)) {
      await detectCertainImpactBestEffort(input.projectRoot, paths, sessionId);
    }
    return await openImpactCardEntries(sessionId);
  } catch {
    return [];
  }
}

/**
 * Count whether the store already held knowledge about the file this tool just touched.
 *
 * **Deliberately not gated on `impactEnabled`**, unlike `runToolEventImpact` directly above.
 * `capture_outcomes` established the rule this follows: a measurement gated behind the feature it
 * exists to justify can never justify it, so counting is unconditional and only what is DONE with
 * the count is ever configurable. Nothing is shown to the agent here and no output is produced --
 * the whole function is a row.
 *
 * Reads and writes both count, and for the same reason: the question is whether the agent was
 * about to act on a file the store knew something about, and reading it to decide what to do is
 * exactly that moment. A failed call is excluded because a tool that failed touched nothing.
 */
async function observeToolTouch(input: NormalizedHostHook, projectId: string): Promise<void> {
  if (input.status === 'failed') return;
  if (!toolReadsFile(input) && !toolWritesFile(input)) return;
  const paths = impactChangedPaths(input.payload);
  if (paths.length === 0) return;
  await observeRecallGapBestEffort(projectId, { conversation: conversationKey(input), paths });
}

/**
 * The pre-write branch: refuse this one call when the session is about to write over something it
 * read and has not seen since.
 *
 * Ordered by cost, and the first three checks touch nothing. This fires ahead of *every* tool call
 * with the host blocked on the answer, so the tool-name filter is what keeps it off the path of
 * every read, grep and shell command the agent makes.
 *
 * The session binding is looked up, never created. A pre-tool event is an observation of something
 * about to happen; a session that does not exist yet has read nothing, and bootstrapping one here
 * would mint memory sessions from hook traffic.
 *
 * Wrapped whole, following `flagCorrectionSiblingsBestEffort`. Every failure here allows the
 * write: the worst outcome this subsystem can produce is not a missed detection, it is a person
 * whose agent cannot edit a file because a memory server had an opinion about it.
 */
async function runWriteGate(input: NormalizedHostHook): Promise<HostLifecycleResult> {
  try {
    if (!toolWritesFile(input)) return { accepted: true };
    const paths = impactChangedPaths(input.payload);
    if (paths.length === 0) return { accepted: true };

    // Absent on every host without a pre-tool callback of its own -- capability by return value,
    // the rule the rest of this interface follows. A host that cannot refuse has no use for the
    // answer, and asking anyway would spend the gate's one-shot on a refusal nobody could deliver.
    const { denyToolCall } = hostProfile(input.host);
    if (typeof denyToolCall !== 'function') return { accepted: true };

    const session = await findHostSession(bindingKey(input, 'turn'))
      ?? await findHostSession(bindingKey(input, 'session'));
    if (!session) return { accepted: true };

    const decision = await shouldRefuseWrite(input.projectRoot, session.id, paths);
    if (!decision.deny || !decision.reason) return { accepted: true, sessionId: session.id };
    // A host that declines to produce an envelope costs this one refusal: the gate has already
    // spent its one-shot, so the write proceeds and the finding stays open for the card to carry.
    // Silence is the right degradation -- the alternative is holding the block armed for a host
    // that has no way to explain it, which is a refusal with no reason attached.
    const envelope = denyToolCall(decision.reason);
    if (!envelope) return { accepted: true, sessionId: session.id };
    return { accepted: true, sessionId: session.id, denied: decision.reason, hostOutput: envelope };
  } catch {
    return { accepted: true };
  }
}

/**
 * Release a memory session's read-set when that session stops holding beliefs -- which is when
 * the *memory session* is finished, not when a turn ends.
 *
 * `turn-stop` is not that boundary by itself. A Claude `Stop` ends one assistant response inside
 * a conversation that keeps its context: the agent still holds every file it read in the previous
 * turn and routinely continues on those same files, so releasing there would disarm the detector
 * for the rest of the session -- the failure `releaseReadSet`'s own contract names for releasing
 * a whole session at task-finish. It *is* called from the `turn-stop` paths that finish the memory
 * session (a host with no shared session binding, and either hard-failure path), because there the
 * id these rows are keyed to is over and a new turn binds a new one. Not called on `agent-stop`: a
 * subagent shares its parent's memory session id, so releasing there would drop the parent's live
 * beliefs on the parent's behalf.
 *
 * Alone in this subsystem, this is not gated on the config flag. Every other operation costs
 * something when it runs needlessly; this one costs something when it fails to run. An unreleased
 * row is a live belief forever: `activeReadersOf` keeps handing it to detectors, which then
 * manufacture findings against a session that has ended and can neither be told nor adjudicate
 * them -- straight into the denominator of the precision number this phase exists to produce. And
 * gating it would mean that turning the flag off strands every row recorded while it was on. The
 * price when the feature was never enabled is one UPDATE matching zero rows, at a session
 * boundary rather than on the tool path.
 */
async function releaseSessionReadSet(sessionId: string): Promise<void> {
  await releaseReadSetBestEffort(sessionId);
}

/**
 * Whether to tell this session it has stored nothing, and the envelope to say it in.
 *
 * **Fired at a turn boundary, not at session end, and that is forced rather than chosen.** The
 * natural home would be session finish -- it knows the session is over and owns capture. But
 * `SessionEnd` fires after the model is gone, so nothing said there can reach an agent, and the
 * only channel that reaches one at stop time withholds the stop. So this fires at the first turn
 * boundary where the silence has become meaningful (`MIN_SUBSTANTIVE_TURNS`), which is also the
 * last moment the agent can still act on it. Once.
 *
 * **Three modes, one verdict**, following `shouldRefuseWrite`: `off` does not compute it,
 * `shadow` computes it and records what it would have said, `enforce` delivers it. Shadow is
 * where this is expected to sit -- the measurement it produces is what a decision to enforce
 * would have to be made on, and that measurement cannot be taken by something already blocking.
 *
 * **The claim is spent before the message is delivered.** See `claimSilenceNudge`: a block keyed
 * on "this session stored nothing" is a condition the agent may reasonably decline to clear, so
 * without a one-shot it would fire on every subsequent stop forever.
 *
 * **Fail open, without exception.** No config, an unknown host, a host with no stop channel, a
 * broken store -- every one of them returns undefined and the stop proceeds. This runs in front
 * of every stop in every session of every repo that turns it on, and the failure mode of a nudge
 * that does not fire is a missed note, while the failure mode of a stop that will not complete is
 * somebody's session.
 *
 * Hosts that bind one memory session per turn never reach the floor, because their `turns` count
 * resets with each session. In practice that makes this a Claude-only signal today, which is also
 * the only host whose stop channel is verified.
 */
async function evaluateSilenceNudge(input: NormalizedHostHook): Promise<Record<string, unknown> | undefined> {
  try {
    const config = await loadConfig(input.projectRoot).catch(() => null);
    const mode = captureNudgeMode(config ?? undefined);
    if (mode === 'off') return undefined;

    const conversation = conversationKey(input);
    const outcome = await readCaptureOutcome(conversation);
    if (!shouldNudgeForSilence(outcome)) return undefined;

    if (mode === 'shadow') {
      await claimSilenceNudge(conversation, 'shadow');
      return undefined;
    }

    // Checked before the claim is spent: a host that cannot deliver would otherwise consume the
    // session's one nudge and deliver nothing, so turning the feature on for an unsupported host
    // would look identical to it firing.
    const profile = hostProfile(input.host);
    if (!profile.stopContext) return undefined;
    if (!await claimSilenceNudge(conversation, 'enforce')) return undefined;

    return profile.stopContext(renderSilenceNudge());
  } catch {
    return undefined;
  }
}

/**
 * Whether unresolved pending lessons should withhold this stop, and the envelope to say it in.
 *
 * `evaluateSilenceNudge`'s twin with the opposite scoping: that one speaks once per
 * conversation about a total, this one speaks about specific events -- a destructive command,
 * a correction -- that no durable write has settled since they happened. Same discipline
 * throughout: the same off/shadow/enforce ladder, the delivery capability checked before
 * anything is spent, the claim spent before the message is delivered, and fail-open without
 * exception. Two extra rules of its own:
 *
 * - The lessons are marked resolved BEFORE the block is emitted, so this can cost at most one
 *   extra turn per event and can never nag: if the agent stores nothing, the next stop passes.
 * - The block budget (`MAX_LESSON_BLOCKS`) is a hard ceiling per conversation. Once spent,
 *   everything else settles silently, whatever else happens.
 *
 * Evaluated before the silence nudge and suppressing it for this stop: both spend a blocked
 * stop, a specific reason beats a general one, and two blocks on one stop is the fatigue that
 * teaches agents to ignore the channel.
 */
async function evaluatePendingLessonStop(input: NormalizedHostHook): Promise<Record<string, unknown> | undefined> {
  try {
    const config = await loadConfig(input.projectRoot).catch(() => null);
    const mode = captureEventsMode(config ?? undefined);
    if (mode === 'off') return undefined;

    const conversation = conversationKey(input);
    const open = await openPendingLessons(conversation);
    if (open.length === 0) return undefined;

    if (mode === 'shadow') {
      await markPendingLessons(open.map(lesson => lesson.id), 'shadow');
      return undefined;
    }

    const profile = hostProfile(input.host);
    if (!profile.stopContext) return undefined;
    if (!await claimLessonBlock(conversation)) {
      // Budget exhausted: settle silently so the rows cannot pile up behind a gate that will
      // never speak again, and record that silence as what it was.
      await markPendingLessons(open.map(lesson => lesson.id), 'budget');
      return undefined;
    }

    await markPendingLessons(open.map(lesson => lesson.id), 'blocked');
    return profile.stopContext(renderLessonStopReason(open));
  } catch {
    return undefined;
  }
}

async function finalizeFailedStop(projectId: string, input: NormalizedHostHook, sessionId: string) {
  await finishMemorySession(
    sessionId,
    'failed',
    typeof input.payload.summary === 'string' ? input.payload.summary : undefined,
  );
  // A hard failure ends the session as surely as a clean stop does, and it is the likelier of
  // the two to be followed by a handoff into a fresh session that inherits none of these beliefs.
  await releaseSessionReadSet(sessionId);
  const promotion = await finalizeMemorySession(projectId, sessionId);
  const handoff = await recordPendingSessionHandoff(projectId, input, { memorySessionId: sessionId });
  return { promotion, handoff };
}

/**
 * Whether this project's KNOWL.md and AGENTS.md still say what this build writes.
 *
 * The reason it belongs at session start and not only in `doctor`: the guidance card in this
 * context block is rendered from the RUNNING build, while the host reads KNOWL.md from disk. A
 * stale file therefore does not merely under-inform the agent, it **contradicts** the card in the
 * same session, and nothing said which one to believe. Measured 2026-08-08: a `knowl` command run
 * against a stale `dist/` reverted guidance that had just landed, and every session afterwards
 * carried both versions at once.
 *
 * So the warning names the winner rather than just reporting drift -- an agent that knows the file
 * is wrong can act on the card and tell the user, which is the whole point of saying it here.
 *
 * Two file reads and a string compare, once per session. Not on the per-tool-call path, where the
 * write gate's process cost was the objection. Best-effort throughout: a missing or unreadable
 * instruction file is not a reason to fail a session bootstrap.
 */
async function staleGuidanceWarningBestEffort(projectRoot: string): Promise<string | null> {
  try {
    // Present AND different, not merely "not current" -- `isKnowlProjectGuidanceCurrent` reports
    // false for both, and the two mean opposite things here. A file that does not exist is one
    // the host never read, so there is no second version of the guidance and nothing to
    // contradict; saying "written by a different version of Knowl" about an absent file is just
    // false. That case is `doctor`'s to raise, where "this project was never set up" is the
    // finding. Narrowing to drift also keeps this quiet for every project that uses Knowl through
    // MCP without the markdown files.
    const present = await Promise.all(['KNOWL.md', 'AGENTS.md'].map(name =>
      fs.access(path.join(projectRoot, name)).then(() => true, () => false)));
    if (!present.every(Boolean)) return null;
    if (await isKnowlProjectGuidanceCurrent(projectRoot)) return null;
  } catch {
    return null;
  }
  return 'KNOWL GUIDANCE STALE: this project\'s KNOWL.md / AGENTS.md were written by a different '
    + 'version of Knowl than the one running, so they may contradict the guidance in this block. '
    + 'Where they disagree, the file is the stale one. Run `knowl init` (or `knowl doctor --fix`) '
    + 'to refresh them.';
}

export async function handleHostLifecycleEvent(projectId: string, input: NormalizedHostHook): Promise<HostLifecycleResult> {
  // First, and claimed before anything else can mistake it for a session boundary: every event
  // this function does not recognise falls through to the session-stop handler at the bottom, and
  // this one fires ahead of every tool call. It captures nothing, advances no watermark and
  // finishes nothing -- the tool has not run yet, and the only question here is whether it should.
  if (input.event === 'tool-precheck') return runWriteGate(input);

  if (input.event === 'session-start') {
    const recovered = await recoverAbandonedSessions();
    const purgedEventCount = await purgeExpiredSessionEvents();
    // Beside the session-event purge because it is the same kind of debt and wants the same
    // schedule: rows written per tool call, pruned once per session rather than on the hot path.
    // A read-set with nothing collecting it grows for as long as the repository is used.
    await sweepReadSetsBestEffort(plusHoursIso(-READ_SET_RETENTION_HOURS));
    await closeInactiveHostSessionBindings();
    // Flips survivors to `needs_review` and stamps `last_drift_at`, then names what moved and
    // the command to review it. Detection-only until 2026-08-13; see `drift-auto.ts` for why
    // the narrowed signal made the flip survivable.
    const drift = await runAutoDriftCheckBestEffort(projectId, input.projectRoot);
    // Strictly after drift, and only when drift actually ran. `checked` is false on the run
    // that learns a baseline and on the re-baseline after a rebase -- both skip a window of
    // history -- and null outside a git repository or after a thrown check. In every one of
    // those cases nothing was in a position to contradict an item this session, which is
    // exactly the state where "nothing is drifting" must not be read as evidence of health.
    // A project with no git history therefore never promotes on observed use, which is the
    // same falsifiability rule as `affected_paths`, applied to the repository instead.
    const standing = drift?.checked ? await promoteByObservedUseBestEffort(projectId) : null;
    const started = await bootstrapWithHandoff(projectId, input, 'session', true);
    // The warning is charged against the cap first — the same rule the subagent card
    // follows. Prepending it to an already-budgeted block pushed the session past the size
    // the host was promised, and the warning is the part that must survive: the watermark
    // has already advanced, so this line is the only record of the window.
    // Guidance first, then drift. Both are charged against the cap before recent context, and if
    // only one survives truncation it should be the one saying the instructions on disk cannot be
    // trusted -- an agent acting on stale guidance gets the subsequent work wrong, where a missed
    // drift notice costs it a re-read.
    // Standing last of the three: it reports something the store already did successfully,
    // where the other two are warnings that the work ahead may be built on bad ground. If the
    // cap drops a line, drop this one.
    const warning = truncateText([
      await staleGuidanceWarningBestEffort(input.projectRoot),
      describeAutoDrift(drift),
      describeObservedUsePromotions(standing),
    ].filter(Boolean).join('\n\n'), DEFAULT_CONTEXT_MAX_CHARS);
    const recentBudget = warning
      ? Math.max(0, DEFAULT_CONTEXT_MAX_CHARS - warning.length - 2)
      : DEFAULT_CONTEXT_MAX_CHARS;
    const recent = started.context ? truncateText(started.context, recentBudget) : undefined;
    const context = warning ? (recent ? `${warning}\n\n${recent}` : warning) : recent;
    return {
      accepted: true,
      sessionId: started.session.id,
      context,
      contextTruncated: started.truncated
        || Boolean(started.context && started.context.length > recentBudget),
      recoveredCount: recovered.length,
      purgedEventCount,
      hostOutput: hostContextOutput(input, context),
      ...(drift ? { drift } : {}),
    };
  }

  if (input.event === 'turn-start') {
    // The correction signal arrives as a derived boolean -- the host hook classified the raw
    // prompt and forwarded only the verdict, so no user text reaches this layer or the rows
    // it writes. Recorded as a pending lesson either way; spoken only in enforce, riding the
    // context envelope this event was already carrying, which is the one moment the lesson
    // can be stored BEFORE the agent answers -- a correction acted on and not written down is
    // exactly the shape that gets apologised for and repeated.
    let correctionLine: string | undefined;
    if (input.payload.correctionSignal === true) {
      try {
        const eventsConfig = await loadConfig(input.projectRoot).catch(() => null);
        const eventsMode = captureEventsMode(eventsConfig ?? undefined);
        if (eventsMode !== 'off' && await recordCorrectionLesson(conversationKey(input)) && eventsMode === 'enforce') {
          correctionLine = renderCorrectionNudge();
        }
      } catch {
        // Advisory.
      }
    }
    const withCorrection = (context: string | undefined): string | undefined =>
      correctionLine ? (context ? `${correctionLine}\n\n${context}` : correctionLine) : context;

    // A new turn under a reused turn key must start its capture counters from zero. Cheap
    // enough not to gate on config: one DELETE matching zero rows when the scope was never
    // 'turn', at a turn boundary rather than on the tool path.
    await resetTurnCapture(turnCaptureKey(bindingKey(input, 'turn')));

    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    if (!sessionBinding && hostProfile(input.host).sharesSessionBinding) {
      const started = await bootstrapWithHandoff(projectId, input, 'session', true);
      await bindHostSession(bindingKey(input, 'turn'), started.session.id);
      return {
        accepted: true,
        sessionId: started.session.id,
        context: started.context,
        contextTruncated: started.truncated,
        hostOutput: hostContextOutput(input, withCorrection(started.context)),
      };
    }
    const started = await bootstrapWithHandoff(projectId, input, 'turn', !sessionBinding);
    if (!sessionBinding) await bindHostSession(bindingKey(input, 'session'), started.session.id);
    return {
      accepted: true,
      sessionId: started.session.id,
      context: started.context,
      contextTruncated: started.truncated,
      hostOutput: hostContextOutput(input, withCorrection(started.context)),
    };
  }

  if (input.event === 'agent-start') {
    // One memory session per host session, N bindings. The subagent shares the
    // parent's session_id, so it joins the parent's memory session rather than
    // creating one that would need separate finalization.
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    let memorySessionId = sessionBinding?.id;
    if (!memorySessionId) {
      // SubagentStart normally arrives after SessionStart, but an event loss must not
      // leave the subagent unbound. includeContext is false here because
      // bootstrapAgentContext below composes the subagent's own bounded context.
      const started = await bootstrapWithHandoff(projectId, input, 'session', false);
      memorySessionId = started.session.id;
      await bindHostSession(bindingKey(input, 'session'), memorySessionId);
    }

    await bindHostSession(bindingKey(input, 'turn'), memorySessionId);
    const bootstrap = await bootstrapAgentContext(projectId, input, memorySessionId);
    return {
      accepted: true,
      sessionId: memorySessionId,
      context: bootstrap.context,
      contextTruncated: bootstrap.truncated,
      hostOutput: hostContextOutput(input, bootstrap.context),
    };
  }

  if (input.event === 'agent-stop') {
    const agentKey = bindingKey(input, 'turn');
    // A subagent's turn key carries its agent id, so its counters are its own to clean up.
    await resetTurnCapture(turnCaptureKey(agentKey));
    const closed = await closeHostSessionBinding(agentKey);
    // Emits no host output: SubagentStop may block a subagent from stopping and
    // this never does.
    return { accepted: closed, ...(closed ? {} : { reason: 'event-loss' as const }) };
  }

  if (input.event === 'session-event' || input.event === 'checkpoint') {
    // Claim before DB write so concurrent hook processes cannot double-capture.
    // Debounce reduces duplicate storage work; hosts may still spawn one-shot agent-hook processes.
    if (!claimCapture(input)) {
      const existing = await findHostSession(bindingKey(input, 'turn'))
        ?? await findHostSession(bindingKey(input, 'session'));
      return { accepted: true, reason: 'debounced', sessionId: existing?.id };
    }

    try {
      const started = await startBoundSession(projectId, input, 'turn');
      const type = input.event === 'checkpoint' ? 'checkpoint' : input.type;
      if (!type) throw new Error('Normalized host session event requires a type.');
      await captureMemorySessionEvent(started.session.id, type, input.payload);
      // Write-side attribution, recorded on the event that causes it rather than recovered at
      // finalization: session event rows expire about two days out, so a count derived from them
      // later reads zero when it means "I no longer know". Keyed on the conversation and not on
      // `started.session.id`, which is turn-scoped and would scatter one conversation's writes
      // across a row per turn.
      if (isDurableWriteTool(input.knowlToolName)) {
        await recordDurableWrite(conversationKey(input));
        // A durable write settles the pending lessons that were already on the table when it
        // landed -- temporal, not blanket. Clearing everything on any write would be the same
        // flaw one level down that disarms the drift counter: unrelated activity reading as
        // the thing it is not.
        await resolveLessonsBefore(conversationKey(input), new Date().toISOString());
      }
      // One config read serves both capture features below; each is off for anyone who has
      // not turned it on, and a missing config is simply "everything off".
      const captureConfig = await loadConfig(input.projectRoot).catch(() => null);
      // Turn-scoped capture counters (capture.scope = 'turn'). Counted for checkpoint events
      // too, because hosts may report tool activity under that event -- but never for a
      // failure, which produced nothing worth storing. The updated row comes back from the
      // same write, so the slot logic below pays no second query.
      const turnOutcome = input.status !== 'failed' && captureScope(captureConfig ?? undefined) === 'turn'
        ? await recordTurnToolEvent(turnCaptureKey(bindingKey(input, 'turn')), conversationKey(input), {
          fileWrite: toolWritesFile(input),
          durableWrite: isDurableWriteTool(input.knowlToolName),
        })
        : null;
      // Runs for `checkpoint` events too -- a host that reports a tool under that event still
      // read or wrote the file it named -- but never for a failed one: a tool that failed
      // returned no contents, so a read-set row from it would record a belief the agent was
      // never given, and the certain tier would later interrupt it over text it never saw.
      // Which checkpoint window this conversation is in, or null when the feature is off.
      //
      // The read is gated on the mode so it costs nothing for anyone who has not armed it --
      // and when armed it is one primary-key lookup, unlike the turn counters above which ride
      // on a write that was happening anyway. Counted in TURNS rather than tool events, because
      // the sessions worth checkpointing are long on reasoning and short on tools, which is the
      // same reason `MIN_SUBSTANTIVE_TURNS` counts turns.
      const checkpointWindow = captureCheckpointMode(captureConfig ?? undefined) === 'ask'
        ? await readCaptureOutcome(conversationKey(input))
          .then(outcome => {
            const turns = outcome?.turns ?? 0;
            const window = Math.floor(turns / CHECKPOINT_EVERY_TURNS);
            return window >= 1 ? window : null;
          })
          .catch(() => null)
        : null;
      const impact = input.status === 'failed' ? [] : await runToolEventImpact(input, started.session.id);
      await observeToolTouch(input, projectId);
      // Adaptive continuation reminder: only nudge Claude after a run of tool calls
      // that ignored Knowl. Using a Knowl tool resets the drift counter, so an agent
      // that is querying/storing memory never sees a reminder.
      let hostOutput: Record<string, unknown> | undefined;
      let changes: ChangeSummary | undefined;
      if (input.event === 'session-event' && input.status !== 'failed') {
        const key = bindingKey(input, 'turn');
        const profile = hostProfile(input.host);
        // Event inspection, on the one path that sees command text. Recorded whatever the
        // delivery situation is -- a host with no mid-turn channel still gets the stop gate --
        // and only a successful, non-knowl command is inspected: a failed command did no
        // damage, and knowl's own tools are not the hazard. Failed detection must not fail
        // the event, so the classifier's verdict is advisory end to end.
        let lessonCard: string | undefined;
        const shellCommand = typeof input.payload.command === 'string' ? input.payload.command : '';
        if (shellCommand && !input.knowlTool) {
          try {
            const eventsMode = captureEventsMode(captureConfig ?? undefined);
            if (eventsMode !== 'off') {
              const hit = classifyDestructiveCommand(shellCommand);
              // `recordDestructiveLesson` is the once-per-class-per-conversation claim, so the
              // nudge fires exactly when the row is new -- race-safe across hook processes.
              if (hit && await recordDestructiveLesson(conversationKey(input), hit, shellCommand) && eventsMode === 'enforce') {
                lessonCard = renderLessonNudge(hit, shellCommand);
              }
            }
          } catch {
            // Advisory.
          }
        }
        // The watermark runs for every host; only delivery depends on the host having a
        // mid-turn channel, which `midTurnContext` answers by returning an envelope.
        changes = await evaluateChangeNotification(input, key);
        if (changes || impact.length > 0) {
          // Change news implies "go query", so it replaces the static drift nudge and
          // resets the counter. At most one card per tool event, never two.
          //
          // Code impact rides inside that one card rather than beside it, and resets the counter
          // on the same reasoning: it is the strongest "go re-read before you continue" signal
          // the system can send, so freezing the drift counter behind it would make the generic
          // reminder fire later for an agent that was just told something specific. When impact
          // is the only news, `summary` is undefined and the card renders from impact alone --
          // which is why the renderer takes an optional summary rather than this branch
          // synthesising an empty one, and why there is still exactly one `hostOutput` here.
          await resetHostSuccessfulToolCount(key);
          hostOutput = profile.midTurnContext(renderChangeCard(changes, impact.length > 0 ? impact : undefined));
        } else if (lessonCard && profile.midTurnContext('') !== undefined) {
          // Below the change card, above everything else in the slot: an irreversible command
          // that just ran is the one signal whose value decays with every tool call between
          // the event and the asking -- "what else matched that predicate" is only answerable
          // while the agent still remembers aiming. A "go store" signal resets the drift
          // counter on the same reasoning as the skill nudges below.
          await resetHostSuccessfulToolCount(key);
          hostOutput = profile.midTurnContext(lessonCard);
        } else if (profile.midTurnContext('') !== undefined) {
          // A change card always wins the single mid-turn slot; below it, a specific
          // capture suggestion beats the generic continuation reminder.
          const command = typeof input.payload.command === 'string' ? input.payload.command : '';
          // The event row for this command is already written above, so the count
          // includes the current invocation: the third run reports 3.
          const repeats = command ? await countCommandRepeats(started.session.id, command) : 0;

          // Looked up on every command event, not only when capture declines -- capture
          // now depends on the answer. That is affordable because `listActiveSkillItems`
          // is index-scoped to active skills instead of reading the whole knowledge table.
          const existing: SurfacedSkill | null = command
            ? matchSkillForCommand(command, toSurfacedSkills(await listActiveSkillItems()))
            : null;
          // Only a successful run advances the repeat count, so a failure arriving after
          // the nudge fired would report the same total again and fire it twice.
          const exitCode = input.payload.exitCode;
          const failed = typeof exitCode === 'number' && exitCode !== 0;

          // Retrieval sits below capture: recording a workflow the agent is actively
          // repeating is worth more than pointing at one it has already started. The one
          // exception is a workflow already saved -- asking the agent to save a skill that
          // exists is how this loop failed to close in the first place.
          // `reminders.skills`, on unless the repository turned it off. Applied to both skill
          // branches at once: they are one subsystem speaking, and a repo that does not use
          // skills pays the slot for both or neither.
          const skillNudges = areSkillNudgesEnabled(captureConfig);
          const capturing = skillNudges && Boolean(command) && !failed && !existing
            && qualifiesForSkillCapture(command, repeats);

          if (capturing) {
            // A skill nudge is a "go use memory" signal, exactly as a change card is, so it
            // resets the drift counter on the same reasoning: it replaces the static
            // continuation reminder for this event rather than freezing it.
            await resetHostSuccessfulToolCount(key);
            hostOutput = profile.midTurnContext(renderSkillCaptureNudge(command, repeats));
          } else if (skillNudges && existing) {
            await resetHostSuccessfulToolCount(key);
            hostOutput = profile.midTurnContext(renderSkillUseNudge(existing));
          } else if (shouldPromptTurnCapture(turnOutcome)
            && await claimTurnCapturePrompt(turnOutcome!.turnKey, turnOutcome!.conversation)) {
            // Above the knowl-tool branch on purpose: this is the one reminder a query must
            // not silence. The drift counter below goes quiet the moment any knowl tool runs,
            // which is exactly how the memory-active session -- the one that queried five
            // times, diagnosed the hard thing, and stored nothing -- never hears from it.
            // Only a durable write quiets this one, by zeroing the verdict itself.
            await resetHostSuccessfulToolCount(key);
            hostOutput = profile.midTurnContext(renderTurnCapturePrompt());
          } else if (checkpointWindow !== null
            && await claimAssumptionCheckpoint(conversationKey(input), checkpointWindow)) {
            // Below every observed-event branch and above the drift reminder, deliberately.
            //
            // It must not displace a change card or a destructive-command lesson: those carry
            // something that HAPPENED, while this is raised on a counter. But it is strictly
            // better than the byte-identical continuation reminder it sits above -- a specific
            // question about this session's own work against a generic nudge -- which is the
            // same trade the skill nudges already make for this slot.
            //
            // Not reset here: unlike the branches above, this is not a "go use memory" signal,
            // and zeroing the drift counter on a timer would mute the reminder for sessions
            // that genuinely are ignoring Knowl.
            hostOutput = profile.midTurnContext(renderAssumptionCheckpoint());
          } else if (input.knowlTool) {
            // Adaptive continuation reminder: only nudge after a run of tool calls that
            // ignored Knowl. Using a Knowl tool resets the drift counter, so an agent
            // that is querying/storing memory never sees a reminder.
            await resetHostSuccessfulToolCount(key);
          } else {
            // `reminders.driftEvery` (default 12, `0` off) and `reminders.driftBackoff`
            // (default on, gap doubles per delivery). The counter still advances when the
            // reminder is silent: it is shared state that the branches above reset as a "go use
            // memory" signal, and freezing it would change what THEY mean. It is also what the
            // backoff schedule is read from, so it has to keep counting to back off at all.
            const drift = await incrementHostSuccessfulToolCount(key);
            if (shouldSendDriftReminder(drift, driftReminderEvery(captureConfig), isDriftBackoffEnabled(captureConfig))) {
              hostOutput = profile.midTurnContext(KNOWL_CLAUDE_CONTINUATION_REMINDER);
            }
          }
        }
      }
      return { accepted: true, sessionId: started.session.id, hostOutput, ...(changes ? { changes } : {}) };
    } catch (error) {
      releaseCapture(input);
      throw error;
    }
  }

  if (input.event === 'turn-stop') {
    const key = bindingKey(input, 'turn');
    let session = await findHostSession(key);
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    // Hard-stop failures may arrive without a turn binding. Fall back to session binding.
    if (!session && input.status === 'failed' && sessionBinding) {
      session = sessionBinding;
    }
    if (!session) return { accepted: false, reason: 'event-loss' };

    // One assistant turn ended. Counted here rather than at session end because this is the only
    // event that fires per turn, and turns -- not tool events -- are what tell a working
    // conversation apart from a single question answered.
    await recordSessionTurn(conversationKey(input));
    // The turn is over, so its capture counters are too; the prompt ceiling lives on its own
    // row and survives this.
    await resetTurnCapture(turnCaptureKey(bindingKey(input, 'turn')));

    // gpt-5.5 often share one session binding across turns. Normal Stop only closes the turn
    // binding. Hard failures finish the session and record a host-scoped handoff.
    if (hostProfile(input.host).sharesSessionBinding && sessionBinding?.id === session.id) {
      if (input.status === 'failed') {
        const result = await finalizeFailedStop(projectId, input, session.id);
        await closeHostSessionBinding(key);
        await closeHostSessionBinding(bindingKey(input, 'session'));
        return { accepted: true, sessionId: session.id, promotion: result.promotion, handoff: result.handoff };
      }
      // The lesson gate outranks the silence nudge and suppresses it for this stop: both
      // withhold the stop, a specific reason beats a general one, and two blocks on one stop
      // is the fatigue that teaches agents to ignore the channel. The silence nudge's claim
      // is only spent on delivery, so it keeps its chance at a later stop.
      const lessonStop = await evaluatePendingLessonStop(input);
      const silence = lessonStop ? undefined : await evaluateSilenceNudge(input);
      const stopOutput = lessonStop ?? silence;
      await closeHostSessionBinding(key);
      return { accepted: true, sessionId: session.id, ...(stopOutput ? { hostOutput: stopOutput } : {}) };
    }

    if (input.status === 'failed') {
      const result = await finalizeFailedStop(projectId, input, session.id);
      await closeHostSessionBinding(key);
      return { accepted: true, sessionId: session.id, promotion: result.promotion, handoff: result.handoff };
    }

    await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
    // Reached only by a host that does *not* share one binding across turns -- the branch above
    // returns before this for the ones that do. Here the turn's memory session is finished and
    // the next turn binds a new one, so these rows can never be queried again and must not be
    // left live for other sessions' detectors to keep finding.
    await releaseSessionReadSet(session.id);
    const promotion = await finalizeMemorySession(projectId, session.id);
    // Also evaluated here, and this is the path that actually carries it for Claude. The branch
    // above needs the turn's memory session to *be* the session binding's, which only holds when
    // a turn started before anything bound the session; the ordinary `SessionStart` then
    // `UserPromptSubmit` sequence gives the turn its own, so a normal Claude stop lands here.
    // Keying the counters on the conversation rather than on either memory session is what lets
    // one verdict serve both paths.
    // Same precedence as the shared-binding path above: a specific unstored event beats the
    // generic "stored nothing" verdict, and at most one of them may withhold this stop.
    const lessonStop = await evaluatePendingLessonStop(input);
    const silence = lessonStop ? undefined : await evaluateSilenceNudge(input);
    const stopOutput = lessonStop ?? silence;
    await closeHostSessionBinding(key);
    return { accepted: true, sessionId: session.id, promotion, ...(stopOutput ? { hostOutput: stopOutput } : {}) };
  }

  const key = bindingKey(input, 'session');
  const session = await findHostSession(key);
  if (!session) {
    await closeHostSessionBindings(bindingKey(input, 'turn'));
    return { accepted: false, reason: 'event-loss' };
  }

  if (input.status === 'failed') {
    const result = await finalizeFailedStop(projectId, input, session.id);
    await closeHostSessionBinding(key);
    await closeHostSessionBindings(bindingKey(input, 'turn'));
    return { accepted: true, sessionId: session.id, promotion: result.promotion, handoff: result.handoff };
  }

  await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
  // The session is over: every belief it held is now historical, and an unreleased row here is
  // the case `read-set.ts` names -- a finished session's reads looking like live work forever.
  await releaseSessionReadSet(session.id);
  const promotion = await finalizeMemorySession(projectId, session.id);
  await closeHostSessionBinding(key);
  await closeHostSessionBindings(bindingKey(input, 'turn'));
  return { accepted: true, sessionId: session.id, promotion };
}
