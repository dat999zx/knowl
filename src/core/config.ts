import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectConfig } from './types.js';
import { ConfigError, ProjectNotFoundError } from './errors.js';

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
      enabled: false,
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    },
  },
};

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
 * Traverses up from the starting path to find the directory containing `.knowl` directory.
 */
export async function findProjectRoot(startPath: string = process.cwd()): Promise<string> {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    const knowlPath = path.join(current, '.knowl');
    try {
      const stat = await fs.stat(knowlPath);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // Ignored: directory does not exist, keep traversing up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Check root directory itself
  const knowlPath = path.join(current, '.knowl');
  try {
    const stat = await fs.stat(knowlPath);
    if (stat.isDirectory()) {
      return current;
    }
  } catch {
    // Ignored
  }

  throw new ProjectNotFoundError(startPath);
}

/**
 * Loads the project configuration from the specified project root.
 */
export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = path.join(projectRoot, '.knowl', 'config.json');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(content) as ProjectConfig;
    
    // Resolve env variables if present in API keys or other settings
    if (parsed.ai?.apiKey && parsed.ai.apiKey.startsWith('${') && parsed.ai.apiKey.endsWith('}')) {
      const envVarName = parsed.ai.apiKey.substring(2, parsed.ai.apiKey.length - 1);
      parsed.ai.apiKey = process.env[envVarName] || '';
    }

    return stripDeprecatedConfigFields(parsed);
  } catch (error: any) {
    throw new ConfigError(`Failed to load config from "${configPath}": ${error.message}`);
  }
}

/**
 * Saves the configuration to the specified project root.
 */
export async function saveConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
  const configDir = path.join(projectRoot, '.knowl');
  const configPath = path.join(configDir, 'config.json');
  const normalized = stripDeprecatedConfigFields(config);
  
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
 * Checks whether AI is configured via project config or environment variables.
 */
export function hasAiConfigured(config?: ProjectConfig): boolean {
  if (!config?.ai?.provider || !config.ai.model) return false;
  if (config.ai.provider === 'ollama') return true;
  if (config.ai.apiKey) return true;
  if (config.ai.provider === 'openai' && process.env.OPENAI_API_KEY) return true;
  if (config.ai.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) return true;
  return false;
}
