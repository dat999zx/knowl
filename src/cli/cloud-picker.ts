import type { CloudWorkspace } from '../cloud/api-client.js';

/**
 * Choose a workspace from the list `runConnect` already fetched.
 *
 * Returns null rather than throwing on both "no TTY" and "cancelled", because the caller's
 * remedy is the same in both cases: print the list and exit non-zero, which is exactly what
 * `connect` did before this existed. A picker that blocked in CI would be worse than the error
 * it replaces.
 *
 * The role rides along as a hint. A reader who picks a workspace they cannot publish to would
 * otherwise discover it at the first refused push, several commands later.
 */
export async function pickWorkspace(
  workspaces: CloudWorkspace[],
  io: { isTTY?: boolean } = {},
): Promise<string | null> {
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return null;

  // Lazily, matching `src/cli/config/ui.ts` -- the prompt library is only reachable from
  // interactive paths and must not be paid for by `knowl serve`.
  const clack = await import('@clack/prompts');
  const chosen = await clack.select({
    message: 'Which workspace should this repository publish to?',
    options: workspaces.map(workspace => ({
      value: workspace.id,
      label: workspace.name,
      hint: workspace.role,
    })),
  });

  return clack.isCancel(chosen) ? null : String(chosen);
}
