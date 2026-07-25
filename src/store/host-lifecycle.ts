import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { createClaudePostToolReminderOutput } from '../cli/agents/reminder.js';
import { captureMemorySessionEvent } from './session-capture.js';
import { finalizeMemorySession } from './session-finalizer.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions } from './session-repository.js';
import { claimCapture, releaseCapture } from './hook-debounce.js';
import {
  closeHostSessionBinding,
  closeHostSessionBindings,
  closeInactiveHostSessionBindings,
  bindHostSession,
  findHostSession,
  getOrCreateHostSession,
  HostSessionKey,
  incrementHostSuccessfulToolCount,
  resetHostSuccessfulToolCount,
} from './host-session-bindings.js';
import { bootstrapAgentSession } from './context-bootstrap.js';
import { consumePendingSessionHandoff, recordPendingSessionHandoff } from './session-handoff.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';

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
  if (input.host === 'codex' || input.host === 'claude') {
    const hookEventName = input.event === 'session-start'
      ? 'SessionStart'
      : input.event === 'agent-start'
        ? 'SubagentStart'
        : 'UserPromptSubmit';
    return { hookSpecificOutput: { hookEventName, additionalContext: context } };
  }
  if (input.host === 'cursor') {
    return {
      additional_context: context,
      sessionStart: true,
    };
  }
  // `generic` has no host-native protocol: emitting a host-output object here would
  // replace the host-neutral lifecycle result ({ accepted, sessionId, context, ... })
  // that generic integrations consume, so it deliberately returns nothing.
  return undefined;
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
// whatever a subagent costs. The operational card is retained, because it is unverified
// whether MCP instructions reach subagents and a wrong bet there silently disables the
// workflow, while a wrong bet the other way only costs tokens.
async function bootstrapAgentContext(projectId: string, input: NormalizedHostHook, sessionId: string) {
  const bootstrap = await bootstrapAgentSession({
    projectId,
    title: input.title ?? 'Agent session (subagent)',
    agent: String(input.host),
    sessionId,
  }, { includeContext: true });
  const cap = Math.floor(DEFAULT_CONTEXT_MAX_CHARS / 2);
  const context = bootstrap.context ? truncateText(bootstrap.context, cap) : undefined;
  return { context, truncated: Boolean(bootstrap.context && bootstrap.context.length > cap) };
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
    const started = await bootstrapWithHandoff(projectId, input, 'session', true);
    return {
      accepted: true,
      sessionId: started.session.id,
      context: started.context,
      contextTruncated: started.truncated,
      recoveredCount: recovered.length,
      purgedEventCount,
      hostOutput: hostContextOutput(input, started.context),
    };
  }

  if (input.event === 'turn-start') {
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    if (!sessionBinding && (input.host === 'codex' || input.host === 'claude')) {
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
      if (input.host === 'claude' && input.event === 'session-event' && input.status !== 'failed') {
        if (input.knowlTool) {
          await resetHostSuccessfulToolCount(bindingKey(input, 'turn'));
        } else {
          const drift = await incrementHostSuccessfulToolCount(bindingKey(input, 'turn'));
          if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) hostOutput = createClaudePostToolReminderOutput();
        }
      }
      return { accepted: true, sessionId: started.session.id, hostOutput };
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
    if ((input.host === 'codex' || input.host === 'claude') && sessionBinding?.id === session.id) {
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
