import fs from 'node:fs/promises';
import path from 'node:path';
import { NEW_PROJECT_CONFIG, isProjectRoot, mainWorktreeRoot, saveConfig } from '../core/config.js';
import { knowlHome } from '../core/paths.js';
import { initDb } from '../store/database.js';
import type { Project } from '../core/types.js';
import { getProjectByRootPath } from '../store/repository.js';
import { recordKnownRepo } from '../core/repo-registry.js';

/**
 * `knowl serve` in a directory nobody initialized: the catalog-install case.
 *
 * Marketplace installs (OpenHands, the Claude Code directory, every MCP catalog) launch `serve`
 * with no step that could ever run `knowl init` -- so an uninitialized project must be a state
 * serve can leave, not an error it reports from all 27 tools (OpenHands/extensions#486 was
 * closed over exactly this). Opt out with KNOWL_DISABLE_SERVE_AUTO_INIT=1, named and read the
 * way KNOWL_DISABLE_STARTUP_TRACE is.
 *
 * Deliberately narrower than `knowl init` -- no guidance files, no agent-config flow, no
 * embedding-model download -- and deliberately NOT an extraction of init's create path. Init
 * owns the interactive contract (guidance, agent files, the warm) and this owns the guest
 * contract; sharing a helper would couple the two at exactly the seam where they must differ.
 * The honest cost of skipping the warm: write-time embedding never downloads
 * (`src/store/write-embedding.ts`), so anything stored before the first query lands without a
 * vector and stays out of semantic search until a reindex. A store born empty holds that
 * exposure to the first minutes of the first session, which is the trade a silent guest
 * process should make -- init keeps warming precisely because an upgraded repo is NOT empty.
 *
 * Split in two along the startup's own seam (see `server.ts` on the 30s connect deadline):
 * `scaffoldProject` is filesystem-only and runs before the handshake, because the config it
 * writes is what the `instructions` card needs at server construction; `adoptProject` opens
 * the database and runs behind the handshake inside `ready`, on the tool-call clock.
 */
export function serveAutoInitAllowed(): boolean {
  return process.env.KNOWL_DISABLE_SERVE_AUTO_INIT !== '1';
}

/**
 * Where auto-init may create a store, or null when it may not.
 *
 * **A bare cwd is not an anchor.** Hosts launch stdio servers from wherever they happen to be
 * -- a home directory, an app install dir -- and a store created there is permanent, silent
 * state the user never asked for. The K-51 incident is the local record of exactly that: one
 * hook call from a scratch directory bootstrapped an empty database inside the real `~/.knowl`,
 * and from then on every command under the home directory resolved to it. The reference MCP
 * servers agree from the outside: none derives a write target from bare cwd, and the official
 * filesystem server refuses to start without an explicit directory.
 *
 * So the anchor is the git repository: the nearest ancestor carrying a `.git` entry. A linked
 * worktree (`.git` as a file) resolves through `mainWorktreeRoot` to the main checkout, which
 * is where this repo's own `findProjectRoot` looks for the store. A directory with no
 * repository gets no store -- serve falls back to the ordinary "run knowl init" refusal,
 * which is correct for a directory whose owner has expressed no intent at all.
 *
 * The `knowlHome` check is `knowl init`'s own guard (`src/cli/program.ts`), kept even though
 * the git anchor already makes it unlikely: a home directory under version control is exactly
 * the kind of setup (dotfiles repos) that would otherwise walk straight back into K-51.
 */
export async function scaffoldTarget(cwd: string): Promise<string | null> {
  let candidate = path.resolve(cwd);
  for (;;) {
    try {
      await fs.stat(path.join(candidate, '.git'));
      break;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
  const root = mainWorktreeRoot(candidate) ?? candidate;
  if (path.resolve(path.join(root, '.knowl')) === path.resolve(knowlHome())) return null;

  // A repository that ships `.knowl/skill-trust.json` is asserting its own skills are
  // approved -- and it is the only artifact that says so, because the trust record and the
  // bytes it vouches for both live in the repo (`src/skills/trust.ts`). `knowl init` is a
  // human electing to trust a checkout; auto-init is a host process that elected nothing, so
  // it must not be the step that turns a planted `.knowl/skills/` into a runnable one. Left
  // to the ordinary "run knowl init" refusal: a store born here is exactly what we decline.
  try {
    await fs.stat(path.join(root, '.knowl', 'skill-trust.json'));
    return null;
  } catch {
    // Absent, which is the normal case and the only one that may proceed.
  }
  return root;
}

/** The pre-handshake half: directories and a default config. No database, idempotent. */
export async function scaffoldProject(root: string): Promise<void> {
  if (await isProjectRoot(root)) return;
  await fs.mkdir(path.join(root, '.knowl', 'skills'), { recursive: true });
  await saveConfig(root, structuredClone(NEW_PROJECT_CONFIG));
}

/**
 * The post-handshake half: database, machine registry, and the store's own ignore file.
 *
 * No project row is created, because none is read: `getProjectByRootPath` synthesizes the
 * `local` project for whatever root it is asked about (`src/store/repository.ts:41-51`), so a
 * scaffolded root is already a project the moment its database opens.
 *
 * The ignore entry goes INSIDE `.knowl/` rather than into the repository's `.gitignore`,
 * which is where `knowl init` puts it. venv is the precedent: a `.gitignore` containing `*`
 * inside the created directory ignores the whole directory without editing a file the user
 * owns -- and a guest process editing the user's `.gitignore` is a diff they never authored
 * showing up in their own `git status`. Init keeps the root entry because init is the user
 * acting on their own repository; serve is not.
 */
export async function adoptProject(projectRoot: string): Promise<Project | null> {
  await initDb(projectRoot);
  await recordKnownRepo(projectRoot);
  await fs.writeFile(
    path.join(projectRoot, '.knowl', '.gitignore'),
    '# Created by knowl serve auto-init. Ignores the whole store.\n*\n',
    { flag: 'w' },
  );
  return getProjectByRootPath(projectRoot);
}
