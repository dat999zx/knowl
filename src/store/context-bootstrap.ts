import { formatRecentContextToMarkdown, type WorkspaceContext } from '../core/format.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from '../core/token-budget.js';
import { heartbeatMemorySession, startMemorySession } from './session-repository.js';
import { getRecentContext } from './recent-context.js';
import { listActiveSkillItems } from './repository.js';
import type { PeerSkillItem } from '../workspace/peer-skills.js';

export type AgentBootstrapInput = {
  projectId: string;
  title: string;
  query?: string;
  agent?: string;
  sessionId?: string;
};

/**
 * The active workspace, shaped for the context block, plus the skills its peers share.
 *
 * Resolved from the open store's root rather than a passed-in path, because bootstrap is
 * given a project id and the root is what `resolveWorkspace` needs. Never fatal: a workspace
 * that cannot be read degrades to no section, exactly as an unlinked repo does.
 *
 * Both answers come from one resolve because they come from one workspace, and resolving twice
 * would open every peer's manifest twice on a path that runs at the start of every session.
 */
async function workspaceContext(): Promise<{ workspace?: WorkspaceContext; peerSkills: PeerSkillItem[] }> {
  try {
    const { getConfigRoot } = await import('./database.js');
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { repoEntry } = await import('../workspace/repo-settings.js');
    const { listPeerSkillItems } = await import('../workspace/peer-skills.js');
    const active = await resolveWorkspace(getConfigRoot());
    if (!active) return { peerSkills: [] };

    const self = repoEntry(active.manifest, active.repo);
    return {
      workspace: {
        name: active.name,
        repo: active.repo,
        selfRole: self?.role,
        selfDefaultVisibility: self?.defaultVisibility,
        peers: active.peers.map(peer => ({
          name: peer.name, role: peer.role, kin: peer.kin, defaultVisibility: peer.defaultVisibility,
        })),
      },
      peerSkills: await listPeerSkillItems(active),
    };
  } catch {
    return { peerSkills: [] };
  }
}

/**
 * `agentCap` composes the card FOR a subagent's budget instead of tail-cutting the parent's.
 *
 * The blind slice was measured dropping everything that matters: on a four-repo workspace the
 * rendered card reaches the skills heading only at character 1,163 and recent knowledge at 1,888,
 * while a subagent is cut at 853 -- so it received a half-finished repo list and nothing else. No
 * skills, no knowledge. Skills are the half that cannot be recovered, since `getRecentContext`
 * returns three items of any category and a peer repo's shared skill is findable only by an agent
 * who already knows it exists. Unlinked projects never hit this: `workspaceSection` is absent and
 * the header alone leaves the skills section room.
 */
export async function bootstrapAgentSession(input: AgentBootstrapInput, options: { includeContext?: boolean; contextCap?: number; agentCard?: boolean } = {}) {
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
  // Skills are surfaced regardless of recency: getRecentContext returns only the three
  // most recent items of any category, so a skill created last month would never appear.
  const skills = await listActiveSkillItems();
  // Workspace visibility governed query reach but not ambient reach: a sibling repo's shared
  // skill could be found only by an agent who already knew to ask for it, which is exactly the
  // agent who does not know the tooling exists. Peers ride the same card, as pointers.
  const { workspace, peerSkills } = await workspaceContext();
  if (options.contextCap !== undefined) {
    // Rendered straight to the cap so the formatter's own budgeting applies -- the skills clamp
    // and the section ordering only mean anything when it knows the real ceiling. Rendering wide
    // and slicing afterwards is the defect this replaces, and it is not the same operation.
    //
    // `agentCard` is the CONTENT policy and is deliberately separate from the cap. A subagent
    // gets the compact workspace and the knowledge pointer because both were measured on
    // subagents; a parent gets neither, because nothing measured says that result transfers and
    // the parent card is charged to every session of every user.
    const context = formatRecentContextToMarkdown({ ...recent, skills, peerSkills }, {
      maxChars: options.contextCap,
      workspace,
      compactWorkspace: options.agentCard === true,
      knowledgeAsPointer: options.agentCard === true,
    });
    return { session, context, truncated: context.endsWith('[Context truncated]') };
  }
  const fallback = formatRecentContextToMarkdown({ ...recent, skills, peerSkills }, {
    maxChars: Number.MAX_SAFE_INTEGER,
    workspace,
  });
  const truncated = fallback.length > DEFAULT_CONTEXT_MAX_CHARS;
  return {
    session,
    context: truncated ? `${fallback.slice(0, DEFAULT_CONTEXT_MAX_CHARS - 24)}\n\n[Context truncated]` : fallback,
    truncated,
  };
}
