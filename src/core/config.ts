import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectConfig } from './types.js';
import { ConfigError, ProjectNotFoundError } from './errors.js';
import { DEFAULT_PRESET_ID } from './vector-profile.js';
import { writeFileAtomic } from './atomic-write.js';

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  security: {
    rejectSecrets: true,
    secretPatterns: [
      'password',
      'api_key',
      'token',
      'secret',
      'private_key',
      'credential',
      'db_password',
    ],
  },
  search: {
    vector: {
      enabled: true,
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    },
  },
  updateCheck: {
    enabled: true,
  },
};

/**
 * What `knowl init` writes, and what `knowl config reset` restores.
 *
 * Deliberately separate from DEFAULT_CONFIG. That one is the merge baseline for
 * `upgradeConfigDefaults`, which fills in every key an existing config lacks --
 * so a `preset` placed there would be injected into every repository on upgrade
 * and silently move it to a different embedding model.
 */
export const NEW_PROJECT_CONFIG: ProjectConfig = {
  ...DEFAULT_CONFIG,
  search: {
    ...DEFAULT_CONFIG.search,
    vector: {
      ...DEFAULT_CONFIG.search?.vector,
      preset: DEFAULT_PRESET_ID,
    },
  },
} as ProjectConfig;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfigDefaults<T extends Record<string, any>>(
  config: T,
  defaults: Record<string, any> = DEFAULT_CONFIG
): T {
  const merged: Record<string, any> = { ...config };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const currentValue = merged[key];
    if (currentValue === undefined) {
      merged[key] = defaultValue;
      continue;
    }

    if (isPlainObject(currentValue) && isPlainObject(defaultValue)) {
      merged[key] = mergeConfigDefaults(currentValue, defaultValue);
    }
  }

  return merged as T;
}

function stripDeprecatedConfigFields(config: ProjectConfig): ProjectConfig {
  const normalized = { ...config } as Record<string, any>;
  delete normalized.project;
  return normalized as ProjectConfig;
}

/**
 * Whether this directory is the root of a Knowl project.
 *
 * The marker is `.knowl/config.json`, not the `.knowl` directory. Machine-local Knowl state
 * -- workspace manifests, the known-repository registry, the resume store, diagnostics --
 * lives in a directory that is also called `.knowl`, under the user's home. A predicate that
 * asked only whether `.knowl` existed therefore answered yes for `$HOME`, and every walk up
 * from a directory beneath it terminated there.
 *
 * Reproduced during the 2026-08-04 audit: one `agent-hook` call made from a scratch directory
 * under `C:\Users\Admin` resolved the project root to `C:\Users\Admin` and bootstrapped a
 * fresh, empty knowledge database inside the real `~/.knowl`. Nothing reported it, because
 * from the inside that is indistinguishable from a first run in a new repository.
 *
 * `knowl init` writes config.json before it opens the database, so an initialized repository
 * always has one, and a home directory never does. This is also what lets a *missing*
 * database be recognised as missing rather than as "never initialized" -- see
 * `assertKnowledgeDatabasePresent`.
 */
export async function isProjectRoot(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(candidate, '.knowl', 'config.json'));
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Traverses up from `startPath` looking for the marker. Null when no ancestor carries one. */
async function walkForProjectRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (await isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Check root directory itself
  if (await isProjectRoot(current)) return current;

  return null;
}

/**
 * The main checkout of the repository `startPath` belongs to, or null when that is not a
 * question with an answer here.
 *
 * `git rev-parse --git-common-dir` names the *shared* git directory, which is what separates a
 * linked worktree from the checkout it was made from. Measured output, which is why the single
 * `path.resolve` below is enough for all of it:
 *
 * | run from                  | prints                   |
 * |---------------------------|--------------------------|
 * | main checkout root        | `.git`                   |
 * | subdirectory of main      | `../../.git`             |
 * | linked worktree root      | `C:/repo/.git` (absolute)|
 * | subdirectory of a worktree| `C:/repo/.git` (absolute)|
 * | outside any repository    | exits non-zero           |
 *
 * Relative in the first two cases and absolute in the next two, so resolving against
 * `startPath` normalises every one of them to the same shared `.git`, whose parent is the main
 * checkout.
 *
 * Only a directory literally named `.git` is accepted. A submodule reports
 * `.git/modules/<name>`, and a bare or otherwise unusual layout reports something else again;
 * in those the parent is not a checkout and guessing would hand back a directory that merely
 * looks like one. Refusing is the safe answer because every caller treats null as "no extra
 * information", never as "no project".
 *
 * Returns null when git is absent or the path is not in a repository. This is a best-effort
 * widening of a lookup that already failed, so it must not turn a missing git binary into an
 * error the caller did not have before.
 *
 * git is asked at all only when `insideLinkedWorktree` finds the marker, and it is asked with
 * `GIT_DIR` and friends stripped -- see those two helpers for why each is load-bearing.
 */
export function mainWorktreeRoot(startPath: string): string | null {
  if (!insideLinkedWorktree(startPath)) return null;

  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: startPath, encoding: 'utf8', env: gitEnvWithoutRepoOverrides(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;

  const commonDir = result.stdout.trim();
  if (!commonDir) return null;

  const resolved = path.resolve(startPath, commonDir);
  if (path.basename(resolved) !== '.git') return null;
  return path.dirname(resolved);
}

/**
 * Is `startPath` inside a LINKED worktree -- the only shape the resolution above can answer for?
 *
 * `git worktree add` writes `.git` as a FILE holding `gitdir: <path>`, where a main checkout has
 * `.git` as a DIRECTORY. That one bit is the whole test, and it costs a `stat` per ancestor.
 *
 * It is a gate rather than an optimisation, for two separate reasons.
 *
 * **The miss branch is a hot path.** `src/cli/agent-hook.ts` runs once per agent tool call as a
 * fresh process -- "its cost is paid hundreds of times a session ... the only Knowl command with
 * that property" -- and its own comment names `ProjectNotFoundError` as the ORDINARY case,
 * because the hook fires in every directory the agent visits and most are not Knowl
 * repositories. A `git` spawn measures ~22ms here, which is ~13% of the 175ms that bundling the
 * hook bought, and it cannot be amortised because the process is new every time. Ordinary CLI
 * commands would pay it twice, once in the `preAction` guard and once in the command body.
 *
 * **`GIT_DIR` outranks `cwd`.** `git rev-parse` honours `GIT_DIR`/`GIT_COMMON_DIR` over the
 * working directory, and git exports them into every hook it runs, so any subprocess of
 * `git commit` inherits them. Without this gate a directory with no relationship to that
 * repository resolved to it and silently read and wrote its memory. Stripping the variables
 * (below) is the direct fix; refusing to ask at all unless a linked-worktree marker is actually
 * present is the one that does not depend on knowing every variable git consults.
 */
function insideLinkedWorktree(startPath: string): boolean {
  let current = path.resolve(startPath);
  for (;;) {
    try {
      if (statSync(path.join(current, '.git')).isFile()) return true;
    } catch {
      // Absent or unreadable: neither is an answer, so keep climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * `process.env` with the variables that would make git answer about a different repository
 * removed. `cwd` is the question being asked; these would override it.
 */
function gitEnvWithoutRepoOverrides(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Traverses up from the starting path to find the root of the enclosing Knowl project.
 *
 * When the walk finds nothing, one widening is tried: `.knowl/` is gitignored and
 * `git worktree add` materialises tracked files only, so a linked worktree is a checkout of an
 * initialized repository that carries no marker anywhere inside it. Placed outside the main
 * checkout -- which is where orchestrators put them -- the walk has nothing to reach and every
 * command failed with `No Knowl project found`. Resolving the shared git directory recovers the
 * main checkout, and the walk is run again from there so the same marker rule decides.
 *
 * The widening is deliberately a FALLBACK rather than a first step. A Knowl project nested
 * inside a larger git repository must keep resolving to itself, and it does, because the
 * ordinary walk reaches its marker before this runs (K-09). It also cannot invent a project:
 * the second walk applies `isProjectRoot` exactly as the first did, so a repository whose main
 * checkout was never initialized still throws.
 */
export async function findProjectRoot(startPath: string = process.cwd()): Promise<string> {
  const direct = await walkForProjectRoot(startPath);
  if (direct) return direct;

  const main = mainWorktreeRoot(startPath);
  if (main && path.resolve(main) !== path.resolve(startPath)) {
    const fromMain = await walkForProjectRoot(main);
    if (fromMain) return fromMain;
  }

  throw new ProjectNotFoundError(startPath);
}

/** `${SOME_VAR}` and nothing else; the name is group 1. */
const ENV_REFERENCE = /^\$\{([^}]+)\}$/;

function envReferenceName(value: unknown): string | null {
  return typeof value === 'string' ? value.match(ENV_REFERENCE)?.[1] ?? null : null;
}

/**
 * Loads the project configuration from the specified project root.
 *
 * `ai.apiKey` may be written as `${SOME_VAR}`, and is resolved here so consumers never think
 * about it. The object this returns therefore holds a real secret -- see `saveConfig`, which
 * is the other half of that bargain.
 */
export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = path.join(projectRoot, '.knowl', 'config.json');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(content) as ProjectConfig;

    const envVarName = envReferenceName(parsed.ai?.apiKey);
    if (envVarName && parsed.ai) parsed.ai.apiKey = process.env[envVarName] || '';

    return stripDeprecatedConfigFields(parsed);
  } catch (error: any) {
    throw new ConfigError(`Failed to load config from "${configPath}": ${error.message}`);
  }
}

/**
 * Put back any `${ENV_VAR}` reference the caller is about to overwrite with its own value.
 *
 * `loadConfig` returns an object with the secret resolved, and that object looks exactly
 * like a config anyone may modify and save. `workspace add`, `workspace join` and
 * `workspace remove` each read it, add or drop one field and write it back -- and wrote the
 * real API key into `.knowl/config.json`, a file that lives in the repository and that
 * people do commit. The reference exists precisely so the key does not live there.
 *
 * Fixed at the boundary rather than at those three call sites: "the object loadConfig hands
 * you must not be saved" is a rule every future caller would have to be told, and the one
 * who is not told writes the secret.
 *
 * The test is exact rather than heuristic -- the incoming value has to *be* the substitution
 * the reference currently resolves to. So `knowl config set ai.apiKey sk-...`, which reads
 * the raw file and means to write a literal, still writes it.
 */
async function preserveEnvReferences(configPath: string, next: ProjectConfig): Promise<ProjectConfig> {
  let onDisk: ProjectConfig;
  try {
    onDisk = JSON.parse(await fs.readFile(configPath, 'utf8')) as ProjectConfig;
  } catch {
    return next; // No previous file, so nothing was resolved from one.
  }

  const reference = onDisk.ai?.apiKey;
  const envVarName = envReferenceName(reference);
  if (!envVarName || !next.ai || typeof next.ai.apiKey !== 'string') return next;
  if (next.ai.apiKey !== (process.env[envVarName] || '')) return next;

  return { ...next, ai: { ...next.ai, apiKey: reference } };
}

/**
 * Saves the configuration to the specified project root.
 */
export async function saveConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
  const configDir = path.join(projectRoot, '.knowl');
  const configPath = path.join(configDir, 'config.json');
  const normalized = stripDeprecatedConfigFields(await preserveEnvReferences(configPath, config));

  try {
    await fs.mkdir(configDir, { recursive: true });
    // 0600: this file can still hold a literal `ai.apiKey`, and its mode should not depend on
    // the user's umask. A no-op on Windows, where ACLs govern instead.
    await writeFileAtomic(configPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  } catch (error: any) {
    throw new ConfigError(`Failed to save config to "${configPath}": ${error.message}`);
  }
}

export async function upgradeConfigDefaults(projectRoot: string): Promise<'updated' | 'unchanged'> {
  const configPath = path.join(projectRoot, '.knowl', 'config.json');
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as ProjectConfig;
  const upgraded = stripDeprecatedConfigFields(mergeConfigDefaults(raw as Record<string, any>) as ProjectConfig);

  if (JSON.stringify(raw) === JSON.stringify(upgraded)) {
    return 'unchanged';
  }

  await saveConfig(projectRoot, upgraded);
  return 'updated';
}

/**
 * Whether this repository has asked for the AI pipeline.
 *
 * This is the gate on billable work, not a capability probe. `recordDecisionDirect` runs
 * `runDeriveTruth` behind it, so the answer decides whether `knowl decide` records a
 * decision deterministically or makes provider calls on every write.
 *
 * It used to answer yes for `provider: 'anthropic'` with no key in the config at all, as
 * long as `ANTHROPIC_API_KEY` happened to be exported -- which on a machine running Claude
 * Code is a variable set for something else entirely. Nothing in the repository said the AI
 * path was on, and nothing marked the moment it turned on: exporting a variable in a shell
 * profile, for an unrelated tool, silently changed what writing a decision costs.
 *
 * So configuration has to be in the configuration. Using the environment is still supported
 * and is one line -- `"apiKey": "${ANTHROPIC_API_KEY}"` -- which says so in the file, and is
 * safe to write there now that `saveConfig` stops resolving it in place.
 */
export function hasAiConfigured(config?: ProjectConfig): boolean {
  if (!config?.ai?.provider || !config.ai.model) return false;
  // Ollama is local and keyless; naming it is the whole opt-in.
  if (config.ai.provider === 'ollama') return true;
  return Boolean(config.ai.apiKey);
}

/**
 * Whether transcript search is on for this repo.
 *
 * A three-line predicate over `ProjectConfig`, which is itself a core type — so it reads
 * nothing the transcripts feature owns. It lived in `transcripts/config.ts` beside its first
 * caller, which made `core/knowl-guidance.ts` import upward into a feature module. `core` is
 * the bottom of the graph and must not depend on anything above it; `transcripts/config.ts`
 * re-exports this so the feature's own callers are unchanged.
 */
export function isTranscriptSearchEnabled(config: ProjectConfig): boolean {
  return config.search?.transcripts?.enabled === true;
}
