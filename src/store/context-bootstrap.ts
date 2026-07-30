import { formatRecentContextToMarkdown, type WorkspaceContext } from '../core/format.js';
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

/**
 * The active workspace, shaped for the context block, or undefined.
 *
 * Resolved from the open store's root rather than a passed-in path, because bootstrap is
 * given a project id and the root is what `resolveWorkspace` needs. Never fatal: a workspace
 * that cannot be read degrades to no section, exactly as an unlinked repo does.
 */
async function workspaceContext(): Promise<WorkspaceContext | undefined> {
  try {
    const { getConfigRoot } = await import('./database.js');
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { repoEntry } = await import('../workspace/repo-settings.js');
    const active = await resolveWorkspace(getConfigRoot());
    if (!active) return undefined;

    const self = repoEntry(active.manifest, active.repo);
    return {
      name: active.name,
      repo: active.repo,
      selfRole: self?.role,
      selfDefaultVisibility: self?.defaultVisibility,
      peers: active.peers.map(peer => ({
        name: peer.name, role: peer.role, kin: peer.kin, defaultVisibility: peer.defaultVisibility,
      })),
    };
  } catch {
    return undefined;
  }
}

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
  const fallback = formatRecentContextToMarkdown(recent, {
    maxChars: Number.MAX_SAFE_INTEGER,
    workspace: await workspaceContext(),
  });
  const truncated = fallback.length > DEFAULT_CONTEXT_MAX_CHARS;
  return {
    session,
    context: truncated ? `${fallback.slice(0, DEFAULT_CONTEXT_MAX_CHARS - 24)}\n\n[Context truncated]` : fallback,
    truncated,
  };
}
