import { withRepoRoot } from '../store/database.js';
import { runAsAuthor } from '../store/write-ownership.js';
import type { ActiveWorkspace } from './resolve.js';

/**
 * Doing another linked repo's work, from here.
 *
 * The CLI has always been able to: `cd` into the sibling and every command applies to it, because
 * standing somewhere is what the ownership guard checks. `assertOwnedItem` is not bypassed by
 * that -- it is *satisfied*, since the item really is local to where the process is standing.
 *
 * An MCP server cannot `cd`. It is bound to the directory it was launched in for its whole life,
 * so an agent was denied a capability the human running the same tools already had, and the
 * workaround was to shell out and run the CLI -- which works, unstamped and undocumented, and is
 * the worst of both.
 *
 * This is that `cd`, made explicit. It is deliberately full-rights: acting as a repo means acting
 * as it, including retiring its knowledge, because the alternative -- an additive-only rebind --
 * would leave the destructive half of "finish the other repo's task" still only reachable by
 * shelling out.
 *
 * What keeps it safe is not a narrower grant. It is that the target is named, resolved through
 * the workspace manifest rather than as a path, and that the swap moves the whole context at once
 * so nothing downstream can end up half-rebound.
 */

export class NotInWorkspaceError extends Error {
  constructor(repoName: string) {
    super(
      `Cannot act as "${repoName}": this repo is not in a workspace, so there are no linked repos ` +
      'to act as. Link them with `knowl workspace add`.',
    );
    this.name = 'NotInWorkspaceError';
  }
}

export class UnknownRepoError extends Error {
  constructor(repoName: string, known: string[]) {
    super(
      `No repo named "${repoName}" in this workspace. Linked: ${known.map(name => `"${name}"`).join(', ')}. ` +
      'The target is resolved through the workspace manifest, so a repo has to be linked before ' +
      'it can be acted as -- a path is never accepted.',
    );
    this.name = 'UnknownRepoError';
  }
}

export class RepoNotPresentError extends Error {
  constructor(repoName: string) {
    super(
      `Repo "${repoName}" is linked to this workspace but is not checked out on this machine, so ` +
      'there is no working tree to act in. Clone it, or run this from a machine that has it.',
    );
    this.name = 'RepoNotPresentError';
  }
}

/**
 * Run `run` as the named linked repo.
 *
 * Acting as yourself is allowed and is a plain no-op, so a caller that passes whatever repo it
 * happens to be looking at needs no special case of its own.
 */
export async function withRepoContext<T>(
  repoName: string,
  workspace: ActiveWorkspace | null,
  run: () => Promise<T>,
): Promise<T> {
  if (!workspace) throw new NotInWorkspaceError(repoName);
  if (repoName === workspace.repo) return run();

  const peer = workspace.peers.find(entry => entry.name === repoName);
  if (!peer) {
    throw new UnknownRepoError(repoName, [workspace.repo, ...workspace.peers.map(entry => entry.name)]);
  }
  // Present is about a working tree, not about a database. Acting as a repo means its evidence
  // paths and its git state resolve, and neither does without a checkout -- so this refuses
  // rather than writing knowledge whose `affectedPaths` point at nothing on this machine.
  if (!peer.present) throw new RepoNotPresentError(repoName);

  // The caller's name rides alongside the context swap, because the swap is what destroys the
  // ability to derive it: everything downstream reads the ambient context, and after the hop
  // that context IS the target. Acting as a repo makes the atom the target's, which is right --
  // it governs that repo and is promoted and retired by it. It should not also erase the fact
  // that another repo's session did the work.
  //
  // Outside the swap on purpose. `withRepoRoot` is reachable from other callers with other
  // reasons to point at another database, and only THIS one -- a named repo doing another
  // repo's work -- has an author to record.
  return runAsAuthor(workspace.repo, () => withRepoRoot(peer.root, run));
}
