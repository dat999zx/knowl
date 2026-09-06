import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MergeStatus, packageRootDir, readTextIfExists, writeWithBackup } from './files.js';
import {
  AgentAdapter,
  AgentDetection,
  AgentEnvironment,
  AgentIntegrationResult,
  IntegrationScope,
} from './types.js';

/** Where this package keeps the plugin it ships, the way Hermes' adapter reads its own. */
export function openclawPluginSourceDir(): string {
  return path.join(packageRootDir(), 'integrations', 'openclaw');
}

/** Where the plugin is copied to, so OpenClaw can link a directory this package does not own. */
export function openclawPluginTargetDir(environment: AgentEnvironment): string {
  return path.join(environment.homeDir, '.openclaw', 'knowl-plugin');
}

/**
 * The files that make a loadable plugin: manifest, package manifest, and the TypeScript entry.
 *
 * TypeScript, deliberately, and it is not an oversight that nothing is compiled. OpenClaw
 * refuses a `.ts` entry on the MANAGED npm path (`plugins install npm-pack:…` wants
 * `./dist/index.js`), but a **link** install of a local directory loads the source directly --
 * its own error text says the source fallback exists for "source checkouts and local
 * development paths". Copying source is therefore the same shape `knowl init hermes` already
 * uses for its Python plugin, and it keeps Knowl to one published package rather than a second
 * one that would have to be released before this one could depend on it.
 */
const PLUGIN_FILES = [
  'openclaw.plugin.json',
  'package.json',
  path.join('src', 'index.ts'),
  path.join('src', 'engine.ts'),
];

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

/** Every plugin file present at the target. Config alone is not an installed plugin. */
export async function openclawPluginInstalled(environment: AgentEnvironment): Promise<boolean> {
  const target = openclawPluginTargetDir(environment);
  try {
    await Promise.all(PLUGIN_FILES.map(file => fs.access(path.join(target, file))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the plugin out of this package and into a directory OpenClaw can link.
 *
 * Copied rather than linked straight at `node_modules/@dat999zx/knowl/integrations/openclaw`
 * for the reason the Hermes adapter gives: npm may replace that tree on any update, and a
 * plugin registered at a path npm owns is a plugin that disappears. Only the files Knowl ships
 * are written; anything else in the target is left alone.
 */
export async function installOpenClawPlugin(environment: AgentEnvironment): Promise<string> {
  const source = openclawPluginSourceDir();
  const target = openclawPluginTargetDir(environment);
  await fs.mkdir(path.join(target, 'src'), { recursive: true });
  for (const file of PLUGIN_FILES) {
    await fs.copyFile(path.join(source, file), path.join(target, file));
  }
  return target;
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
        // Config alone enables a plugin OpenClaw has never been told about. The files have to
        // land somewhere linkable first, exactly as the Hermes adapter copies its plugin before
        // the config that references it means anything.
        const target = await installOpenClawPlugin(environment);
        return {
          agent: 'openclaw',
          status,
          scope,
          configPath: pathname,
          message: `Plugin copied to ${target}. Two steps remain, both once:\n`
            + `  cd "${target}" && npm install @dat999zx/knowl @libsql/client --install-links\n`
            + `  openclaw plugins install --link "${target}" --force --accept-capabilities\n`
            + 'then restart the gateway. None of that is optional. A linked directory resolves its '
            + 'own imports and libsql stays external to the Knowl bundle, so without the install '
            + 'the plugin loads to "Cannot find module". --install-links is required because '
            + "OpenClaw's safety scan refuses a plugin whose node_modules symlinks outside the "
            + 'install root, which is exactly what a plain `npm link` produces. --force covers the '
            + 'directory being outside ClawHub trust metadata, and --accept-capabilities covers '
            + 'the declared tool-result middleware.',
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
        if (!isOpenClawConfigured(JSON.parse(text))) return false;
        return await openclawPluginInstalled(environment);
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
