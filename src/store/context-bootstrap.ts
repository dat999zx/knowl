import { formatRecentContextToMarkdown } from '../core/format.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from '../core/token-budget.js';
import { heartbeatMemorySession, startMemorySession } from './session-repository.js';
import { getRecentContext } from './recent-context.js';

export type AgentBootstrapInput = {
  projectId: string;
  title: string;
  query?: string;
  agent?: string;
  sessionId?: string;
};

export async function bootstrapAgentSession(input: AgentBootstrapInput, options: { includeContext?: boolean } = {}) {
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

  if (options.includeContext === false) return { session, context: undefined, truncated: false };
  const recent = await getRecentContext(input.projectId);
  const fallback = formatRecentContextToMarkdown(recent, { maxChars: Number.MAX_SAFE_INTEGER });
  const truncated = fallback.length > DEFAULT_CONTEXT_MAX_CHARS;
  return {
    session,
    context: truncated ? `${fallback.slice(0, DEFAULT_CONTEXT_MAX_CHARS - 24)}\n\n[Context truncated]` : fallback,
    truncated,
  };
}
