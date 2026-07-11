import { formatRecentContextToMarkdown } from '../core/format.js';
import { heartbeatMemorySession, startMemorySession } from './session-repository.js';
import { getRecentContext } from './recent-context.js';

const MAX_CONTEXT_LENGTH = 6_000;

export type AgentBootstrapInput = {
  projectId: string;
  title: string;
  query?: string;
  agent?: string;
  sessionId?: string;
};

export async function bootstrapAgentSession(input: AgentBootstrapInput) {
  let session;
  if (input.sessionId) {
    try {
      session = await heartbeatMemorySession(input.sessionId);
    } catch {
      session = await startMemorySession(input);
    }
  } else {
    session = await startMemorySession(input);
  }

  const recent = await getRecentContext(input.projectId);
  const fallback = formatRecentContextToMarkdown(recent);
  const truncated = fallback.length > MAX_CONTEXT_LENGTH;
  return {
    session,
    context: truncated ? `${fallback.slice(0, MAX_CONTEXT_LENGTH - 24)}\n\n[Context truncated]` : fallback,
    truncated,
  };
}
