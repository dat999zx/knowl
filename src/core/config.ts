import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectConfig } from './types.js';
import { ConfigError, ProjectNotFoundError } from './errors.js';

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  project: {
    name: 'new-knowl-project',
    description: 'A Knowledge Operating System project',
  },
  ai: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.1,
  },
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
};

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

    return parsed;
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
  
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (error: any) {
    throw new ConfigError(`Failed to save config to "${configPath}": ${error.message}`);
  }
}

/**
 * Checks whether AI is configured via project config or environment variables.
 */
export function hasAiConfigured(config?: ProjectConfig): boolean {
  return !!(
    config?.ai?.apiKey ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    config?.ai?.provider === 'ollama'
  );
}
