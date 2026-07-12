import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { captureMemorySessionEvent } from './session-capture.js';
import { finalizeMemorySession } from './session-finalizer.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions } from './session-repository.js';
import {
  closeHostSessionBinding,
  closeHostSessionBindings,
  closeInactiveHostSessionBindings,
  bindHostSession,
  findHostSession,
  getOrCreateHostSession,
  HostSessionKey,
} from './host-session-bindings.js';
import { consumePendingSessionHandoff, recordPendingSessionHandoff } from './session-handoff.js';
import { DEFAULT_CONTEXT_MAX_CHARS, truncateText } from '../core/token-budget.js';

export type HostLifecycleResult = {
  accepted: boolean;
  reason?: 'event-loss';
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
    externalTurnId: scope === 'session' ? '__session__' : input.externalTurnId ?? '__turn__',
  };
}

function hostContextOutput(input: NormalizedHostHook, context: string | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  if (input.host !== 'codex' && input.host !== 'claude') return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: input.event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

function mergeBootstrapContext(handoffContext: string | undefined, recentContext: string | undefined): { context?: string; truncated: boolean } {
  if (!handoffContext && !recentContext) return { context: undefined, truncated: false };
  if (!handoffContext) {
    return {
      context: recentContext,
      truncated: Boolean(recentContext && recentContext.length > DEFAULT_CONTEXT_MAX_CHARS),
    };
  }
  if (!recentContext) {
    return {
      context: handoffContext,
      truncated: handoffContext.length > DEFAULT_CONTEXT_MAX_CHARS,
    };
  }
  const combined = `${handoffContext}\n\n${recentContext}`;
  const truncated = combined.length > DEFAULT_CONTEXT_MAX_CHARS;
  return {
    context: truncated ? truncateText(combined, DEFAULT_CONTEXT_MAX_CHARS, '\n\n[Context truncated]') : combined,
    truncated,
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

  const handoff = await consumePendingSessionHandoff(projectId);
  const merged = mergeBootstrapContext(handoff?.context, started.context);
  return {
    ...started,
    context: merged.context,
    truncated: merged.truncated,
    handoff,
  };
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

  if (input.event === 'session-event' || input.event === 'checkpoint') {
    const started = await startBoundSession(projectId, input, 'turn');
    const type = input.event === 'checkpoint' ? 'checkpoint' : input.type;
    if (!type) throw new Error('Normalized host session event requires a type.');
    await captureMemorySessionEvent(started.session.id, type, input.payload);
    return { accepted: true, sessionId: started.session.id };
  }

  if (input.event === 'turn-stop') {
    const key = bindingKey(input, 'turn');
    let session = await findHostSession(key);
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    // gpt-5.5 StopFailure may arrive without a turn binding. Fall back to the session binding
    // so rate-limit handoffs still persist when only SessionStart existed.
    if (!session && input.status === 'failed' && sessionBinding) {
      session = sessionBinding;
    }
    if (!session) return { accepted: false, reason: 'event-loss' };
    if ((input.host === 'codex' || input.host === 'claude') && sessionBinding?.id === session.id) {
      const handoff = await recordPendingSessionHandoff(projectId, input, { memorySessionId: session.id });
      await closeHostSessionBinding(key);
      return { accepted: true, sessionId: session.id, handoff };
    }
    await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
    const promotion = await finalizeMemorySession(projectId, session.id);
    const handoff = await recordPendingSessionHandoff(projectId, input, { memorySessionId: session.id });
    await closeHostSessionBinding(key);
    return { accepted: true, sessionId: session.id, promotion, handoff };
  }

  const key = bindingKey(input, 'session');
  const session = await findHostSession(key);
  if (!session) {
    await closeHostSessionBindings(bindingKey(input, 'turn'));
    return { accepted: false, reason: 'event-loss' };
  }
  await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
  const promotion = await finalizeMemorySession(projectId, session.id);
  const handoff = await recordPendingSessionHandoff(projectId, input, { memorySessionId: session.id });
  await closeHostSessionBinding(key);
  await closeHostSessionBindings(bindingKey(input, 'turn'));
  return { accepted: true, sessionId: session.id, promotion, handoff };
}
