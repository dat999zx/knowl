import fsSync from 'node:fs';
import path from 'node:path';
import { MergeStatus, readTextIfExists, writeWithBackup } from './files.js';
import {
  AgentAdapter,
  AgentDetection,
  AgentEnvironment,
  AgentIntegrationResult,
  IntegrationScope,
} from './types.js';

/**
 * Resolves the configuration path for OpenClaw.
 * Priority:
 * 1. OPENCLAW_CONFIG_PATH environment variable override.
 * 2. Project-scoped `openclaw.json` if it exists in projectRoot.
 * 3. Global `~/.openclaw/openclaw.json`.
 */
export function openclawConfigPath(environment: AgentEnvironment, projectRoot?: string): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return process.env.OPENCLAW_CONFIG_PATH;
  }
  if (projectRoot && fsSync.existsSync(path.join(projectRoot, 'openclaw.json'))) {
    return path.join(projectRoot, 'openclaw.json');
  }
  return path.join(environment.homeDir, '.openclaw', 'openclaw.json');
}

export function openclawConfigScope(configPath: string, projectRoot?: string): IntegrationScope {
  if (projectRoot && path.resolve(configPath) === path.resolve(projectRoot, 'openclaw.json')) {
    return 'project';
  }
  return 'global';
}

/**
 * Checks whether the OpenClaw configuration has the Knowl plugin enabled with:
 * - `enabled: true`
 * - `allowConversationAccess: true`
 * - `allowPromptInjection: true`
 * - explicit `timeouts.before_tool_call: 5000` (ms)
 */
export function isOpenClawConfigured(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const config = data as Record<string, any>;
  const knowl = config.plugins?.entries?.knowl;
  if (!knowl || typeof knowl !== 'object' || Array.isArray(knowl)) return false;
  if (knowl.enabled !== true) return false;
  const hooks = knowl.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  if (hooks.allowConversationAccess !== true) return false;
  if (hooks.allowPromptInjection !== true) return false;
  if (hooks.timeouts?.before_tool_call !== 5000) return false;
  return true;
}

/**
 * Mutates an OpenClaw config object in-place to ensure Knowl plugin configuration,
 * preserving all unrelated user keys across top-level, plugins, entries, and hooks.
 */
export function mutateOpenClawConfig(data: Record<string, unknown>): { changed: boolean; status: MergeStatus } {
  if (isOpenClawConfigured(data)) {
    return { changed: false, status: 'unchanged' };
  }

  const hadKnowl = typeof (data as any)?.plugins?.entries?.knowl === 'object'
    && (data as any)?.plugins?.entries?.knowl !== null;
  const status: MergeStatus = hadKnowl ? 'updated' : 'configured';

  if (!data.plugins || typeof data.plugins !== 'object' || Array.isArray(data.plugins)) {
    data.plugins = {};
  }
  const plugins = data.plugins as Record<string, unknown>;

  if (!plugins.entries || typeof plugins.entries !== 'object' || Array.isArray(plugins.entries)) {
    plugins.entries = {};
  }
  const entries = plugins.entries as Record<string, unknown>;

  const existingKnowl = entries.knowl && typeof entries.knowl === 'object' && !Array.isArray(entries.knowl)
    ? (entries.knowl as Record<string, unknown>)
    : {};

  const existingHooks = existingKnowl.hooks && typeof existingKnowl.hooks === 'object' && !Array.isArray(existingKnowl.hooks)
    ? (existingKnowl.hooks as Record<string, unknown>)
    : {};

  const existingTimeouts = existingHooks.timeouts && typeof existingHooks.timeouts === 'object' && !Array.isArray(existingHooks.timeouts)
    ? (existingHooks.timeouts as Record<string, unknown>)
    : {};

  entries.knowl = {
    ...existingKnowl,
    enabled: true,
    hooks: {
      ...existingHooks,
      allowConversationAccess: true,
      allowPromptInjection: true,
      timeouts: {
        ...existingTimeouts,
        before_tool_call: 5000,
      },
    },
  };

  return { changed: true, status };
}

/**
 * Merges OpenClaw plugin configuration into `openclaw.json`.
 * Never overwrites unrelated keys. If the file is unparseable JSON, throws an error
 * leaving the file untouched.
 */
export async function mergeOpenClawConfig(configPath: string): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  let config: Record<string, unknown>;
  if (existing === undefined || existing.trim() === '') {
    config = {};
  } else {
    try {
      config = JSON.parse(existing);
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('Config root is not an object');
      }
    } catch (error: any) {
      throw new Error(`Could not parse ${configPath}: ${error.message}`, { cause: error });
    }
  }

  const { changed, status } = mutateOpenClawConfig(config);
  if (!changed) {
    return 'unchanged';
  }

  const json = `${JSON.stringify(config, null, 2)}\n`;
  const output = existing?.includes('\r\n') ? json.replace(/\n/g, '\r\n') : json;
  await writeWithBackup(configPath, output, existing);
  return status;
}

export function createOpenClawAdapter(environment: AgentEnvironment): AgentAdapter {
  return {
    name: 'openclaw',
    label: 'OpenClaw',
    async detect(root: string): Promise<AgentDetection> {
      const pathname = openclawConfigPath(environment, root);
      const scope = openclawConfigScope(pathname, root);
      const configured = await this.verify(root);
      return {
        installed: await environment.commandExists('openclaw'),
        configured,
        scope,
        configPath: pathname,
      };
    },
    async configure(root: string): Promise<AgentIntegrationResult> {
      const pathname = openclawConfigPath(environment, root);
      const scope = openclawConfigScope(pathname, root);
      try {
        const status = await mergeOpenClawConfig(pathname);
        return {
          agent: 'openclaw',
          status,
          scope,
          configPath: pathname,
          message: 'OpenClaw plugin enabled with required hook permissions and timeout.',
        };
      } catch (error: any) {
        return {
          agent: 'openclaw',
          status: 'failed',
          scope,
          configPath: pathname,
          message: `Could not configure ${pathname}: ${error.message}`,
        };
      }
    },
    async verify(root: string): Promise<boolean> {
      const pathname = openclawConfigPath(environment, root);
      try {
        const text = await readTextIfExists(pathname);
        if (!text || text.trim() === '') return false;
        return isOpenClawConfigured(JSON.parse(text));
      } catch {
        return false;
      }
    },
    async lifecycleCapability() {
      return 'supported';
    },
    async configureLifecycle(root: string): Promise<AgentIntegrationResult> {
      const pathname = openclawConfigPath(environment, root);
      const scope = openclawConfigScope(pathname, root);
      const isConfigured = await this.verify(root);
      return {
        agent: 'openclaw',
        status: isConfigured ? 'unchanged' : 'failed',
        scope,
        configPath: pathname,
        message: isConfigured
          ? 'Lifecycle runs through the in-process plugin.'
          : 'OpenClaw plugin is not configured in openclaw.json.',
      };
    },
    async verifyLifecycle(root: string): Promise<boolean> {
      return this.verify(root);
    },
  };
}
