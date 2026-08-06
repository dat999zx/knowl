import { NormalizedHostHook } from '../core/host-hook-types.js';
import { renderChangeCard } from './change-card.js';
import { hostProfile } from './hosts/index.js';
import { KNOWL_CLAUDE_CONTINUATION_REMINDER, KNOWL_SUBAGENT_BOOTSTRAP_CARD } from '../core/knowl-guidance.js';
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

// Emit the mid-turn continuation reminder after this many consecutive non-Knowl
// tool calls; any Knowl tool call resets the counter to zero.
const KNOWL_REMINDER_DRIFT = 12;

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

async function finalizeFailedStop(projectId: string, input: NormalizedHostHook, sessionId: string) {
  await finishMemorySession(
    sessionId,
    'failed',
    typeof input.payload.summary === 'string' ? input.payload.summary : undefined,
  );
  const promotion = await finalizeMemorySession(projectId, sessionId);
  const handoff = await recordPendingSessionHandoff(projectId, input, { memorySessionId: sessionId });
  return { promotion, handoff };
}

export async function handleHostLifecycleEvent(projectId: string, input: NormalizedHostHook): Promise<HostLifecycleResult> {
  if (input.event === 'session-start') {
    const recovered = await recoverAbandonedSessions();
    const purgedEventCount = await purgeExpiredSessionEvents();
    await closeInactiveHostSessionBindings();
    // Detection only: names what moved and the command to review it, mutating nothing.
    const drift = await runAutoDriftCheckBestEffort(projectId, input.projectRoot);
    const started = await bootstrapWithHandoff(projectId, input, 'session', true);
    // The warning is charged against the cap first — the same rule the subagent card
    // follows. Prepending it to an already-budgeted block pushed the session past the size
    // the host was promised, and the warning is the part that must survive: the watermark
    // has already advanced, so this line is the only record of the window.
    const warning = truncateText(describeAutoDrift(drift) ?? '', DEFAULT_CONTEXT_MAX_CHARS);
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
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    if (!sessionBinding && hostProfile(input.host).sharesSessionBinding) {
      const started = await bootstrapWithHandoff(projectId, input, 'session', true);
      await bindHostSession(bindingKey(input, 'turn'), started.session.id);
      return {
        accepted: true,
        sessionId: started.session.id,
        context: started.context,
        contextTruncated: started.truncated,
        hostOutput: hostContextOutput(input, started.context),
      };
    }
    const started = await bootstrapWithHandoff(projectId, input, 'turn', !sessionBinding);
    if (!sessionBinding) await bindHostSession(bindingKey(input, 'session'), started.session.id);
    return {
      accepted: true,
      sessionId: started.session.id,
      context: started.context,
      contextTruncated: started.truncated,
      hostOutput: hostContextOutput(input, started.context),
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
      // Adaptive continuation reminder: only nudge Claude after a run of tool calls
      // that ignored Knowl. Using a Knowl tool resets the drift counter, so an agent
      // that is querying/storing memory never sees a reminder.
      let hostOutput: Record<string, unknown> | undefined;
      let changes: ChangeSummary | undefined;
      if (input.event === 'session-event' && input.status !== 'failed') {
        const key = bindingKey(input, 'turn');
        const profile = hostProfile(input.host);
        // The watermark runs for every host; only delivery depends on the host having a
        // mid-turn channel, which `midTurnContext` answers by returning an envelope.
        changes = await evaluateChangeNotification(input, key);
        if (changes) {
          // Change news implies "go query", so it replaces the static drift nudge and
          // resets the counter. At most one card per tool event, never two.
          await resetHostSuccessfulToolCount(key);
          hostOutput = profile.midTurnContext(renderChangeCard(changes));
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
          const capturing = Boolean(command) && !failed && !existing
            && qualifiesForSkillCapture(command, repeats);

          if (capturing) {
            // A skill nudge is a "go use memory" signal, exactly as a change card is, so it
            // resets the drift counter on the same reasoning: it replaces the static
            // continuation reminder for this event rather than freezing it.
            await resetHostSuccessfulToolCount(key);
            hostOutput = profile.midTurnContext(renderSkillCaptureNudge(command, repeats));
          } else if (existing) {
            await resetHostSuccessfulToolCount(key);
            hostOutput = profile.midTurnContext(renderSkillUseNudge(existing));
          } else if (input.knowlTool) {
            // Adaptive continuation reminder: only nudge after a run of tool calls that
            // ignored Knowl. Using a Knowl tool resets the drift counter, so an agent
            // that is querying/storing memory never sees a reminder.
            await resetHostSuccessfulToolCount(key);
          } else {
            const drift = await incrementHostSuccessfulToolCount(key);
            if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) {
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

    // gpt-5.5 often share one session binding across turns. Normal Stop only closes the turn
    // binding. Hard failures finish the session and record a host-scoped handoff.
    if (hostProfile(input.host).sharesSessionBinding && sessionBinding?.id === session.id) {
      if (input.status === 'failed') {
        const result = await finalizeFailedStop(projectId, input, session.id);
        await closeHostSessionBinding(key);
        await closeHostSessionBinding(bindingKey(input, 'session'));
        return { accepted: true, sessionId: session.id, promotion: result.promotion, handoff: result.handoff };
      }
      await closeHostSessionBinding(key);
      return { accepted: true, sessionId: session.id };
    }

    if (input.status === 'failed') {
      const result = await finalizeFailedStop(projectId, input, session.id);
      await closeHostSessionBinding(key);
      return { accepted: true, sessionId: session.id, promotion: result.promotion, handoff: result.handoff };
    }

    await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
    const promotion = await finalizeMemorySession(projectId, session.id);
    await closeHostSessionBinding(key);
    return { accepted: true, sessionId: session.id, promotion };
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
  const promotion = await finalizeMemorySession(projectId, session.id);
  await closeHostSessionBinding(key);
  await closeHostSessionBindings(bindingKey(input, 'turn'));
  return { accepted: true, sessionId: session.id, promotion };
}
