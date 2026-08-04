import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectConfig } from './types.js';
import { ConfigError, ProjectNotFoundError } from './errors.js';
import { DEFAULT_PRESET_ID } from './vector-profile.js';

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

/**
 * Traverses up from the starting path to find the root of the enclosing Knowl project.
 */
export async function findProjectRoot(startPath: string = process.cwd()): Promise<string> {
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
    await fs.writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf8');
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
