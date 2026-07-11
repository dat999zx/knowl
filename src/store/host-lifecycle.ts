import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { captureMemorySessionEvent } from './session-capture.js';
import { finalizeMemorySession } from './session-finalizer.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions } from './session-repository.js';
import {
  closeHostSessionBinding,
  closeHostSessionBindings,
  findHostSession,
  getOrCreateHostSession,
  HostSessionKey,
} from './host-session-bindings.js';

export type HostLifecycleResult = {
  accepted: boolean;
  reason?: 'event-loss';
  sessionId?: string;
  context?: string;
  contextTruncated?: boolean;
  recoveredCount?: number;
  purgedEventCount?: number;
  promotion?: Awaited<ReturnType<typeof finalizeMemorySession>>;
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

function hostContextOutput(input: NormalizedHostHook, context: string): Record<string, unknown> | undefined {
  if (input.host !== 'codex' && input.host !== 'claude') return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: input.event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

async function startBoundSession(projectId: string, input: NormalizedHostHook, scope: 'session' | 'turn') {
  return getOrCreateHostSession({
    projectId,
    ...bindingKey(input, scope),
    title: input.title ?? (scope === 'session' ? 'Agent session' : 'Agent turn'),
  });
}

export async function handleHostLifecycleEvent(projectId: string, input: NormalizedHostHook): Promise<HostLifecycleResult> {
  if (input.event === 'session-start') {
    const recovered = await recoverAbandonedSessions();
    const purgedEventCount = await purgeExpiredSessionEvents();
    const started = await startBoundSession(projectId, input, 'session');
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
    const started = await startBoundSession(projectId, input, 'turn');
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
    const session = await findHostSession(key);
    if (!session) return { accepted: false, reason: 'event-loss' };
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
  await finishMemorySession(session.id, input.status ?? 'finished', typeof input.payload.summary === 'string' ? input.payload.summary : undefined);
  const promotion = await finalizeMemorySession(projectId, session.id);
  await closeHostSessionBinding(key);
  await closeHostSessionBindings(bindingKey(input, 'turn'));
  return { accepted: true, sessionId: session.id, promotion };
}
