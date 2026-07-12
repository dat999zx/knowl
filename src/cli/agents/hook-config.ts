import { readTextIfExists, MergeStatus, writeWithBackup } from './files.js';
import { HookHost } from './host-hook.js';

type NestedHook = { type: 'command'; command: string; timeout: number; statusMessage: string };
type NestedEntry = { matcher: string; hooks: NestedHook[] };
type CursorEntry = { command: string; timeout: number };

export const CODEX_HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'Stop'] as const;
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'Stop', 'StopFailure', 'SessionEnd'] as const;
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'afterShellExecution', 'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'preCompact', 'stop', 'sessionEnd'] as const;
const RETIRED_NESTED_EVENTS = ['UserPromptSubmit'];
const RETIRED_CURSOR_EVENTS = ['beforeSubmitPrompt'];

export function knowlHookCommand(platform: NodeJS.Platform, host: HookHost, event: string) {
  const executable = platform === 'win32' ? 'knowl.cmd' : 'knowl';
  return `${executable} agent-hook ${host} ${event} --json`;
}

const ownsCommand = (value: unknown, host: HookHost) =>
  typeof value === 'string' && value.includes(` agent-hook ${host} `);

const ownsNestedEntry = (entry: Record<string, unknown>, host: 'codex' | 'claude') =>
  Array.isArray(entry.hooks) && (entry.hooks as Record<string, unknown>[]).some(hook => ownsCommand(hook.command, host));

function nestedEntry(platform: NodeJS.Platform, host: 'codex' | 'claude', event: string): NestedEntry {
  return {
    matcher: '.*',
    hooks: [{
      type: 'command',
      command: knowlHookCommand(platform, host, event),
      timeout: 30,
      statusMessage: 'Updating Knowl memory',
    }],
  };
}

const cursorEntry = (platform: NodeJS.Platform, event: string): CursorEntry => ({
  command: knowlHookCommand(platform, 'cursor', event),
  timeout: 30,
});

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function mergeNestedHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: 'codex' | 'claude',
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Record<string, unknown>
    : {};
  const events = host === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS;
  let hadOwnEntry = false;
  const nextHooks = { ...hooks };
  for (const event of RETIRED_NESTED_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => !ownsNestedEntry(entry, host));
    hadOwnEntry ||= retained.length !== current.length;
    if (retained.length > 0) nextHooks[event] = retained;
    else delete nextHooks[event];
  }
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => {
      const owned = ownsNestedEntry(entry, host);
      hadOwnEntry ||= owned;
      return !owned;
    });
    nextHooks[event] = [...retained, nestedEntry(platform, host, event)];
  }
  const next = { ...config, hooks: nextHooks };
  if (existing !== undefined && equal(config, next)) return 'unchanged';
  await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, existing);
  return hadOwnEntry ? 'updated' : 'configured';
}

export async function verifyNestedHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: 'codex' | 'claude',
): Promise<boolean> {
  try {
    const config = JSON.parse(await readTextIfExists(configPath) ?? '{}') as Record<string, any>;
    const events = host === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS;
    return RETIRED_NESTED_EVENTS.every(event => !(config.hooks?.[event] as unknown[] | undefined)?.some(entry => ownsNestedEntry(entry as Record<string, unknown>, host)))
      && events.every(event => Array.isArray(config.hooks?.[event])
      && config.hooks[event].some((entry: unknown) => equal(entry, nestedEntry(platform, host, event))));
  } catch {
    return false;
  }
}

export async function mergeCursorHookConfig(configPath: string, platform: NodeJS.Platform): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Record<string, unknown>
    : {};
  let hadOwnEntry = false;
  const nextHooks = { ...hooks };
  for (const event of RETIRED_CURSOR_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => !ownsCommand(entry.command, 'cursor'));
    hadOwnEntry ||= retained.length !== current.length;
    if (retained.length > 0) nextHooks[event] = retained;
    else delete nextHooks[event];
  }
  for (const event of CURSOR_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => {
      const owned = ownsCommand(entry.command, 'cursor');
      hadOwnEntry ||= owned;
      return !owned;
    });
    nextHooks[event] = [...retained, cursorEntry(platform, event)];
  }
  const next = { ...config, version: 1, hooks: nextHooks };
  if (existing !== undefined && equal(config, next)) return 'unchanged';
  await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, existing);
  return hadOwnEntry ? 'updated' : 'configured';
}

export async function verifyCursorHookConfig(configPath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const config = JSON.parse(await readTextIfExists(configPath) ?? '{}') as Record<string, any>;
    return config.version === 1 && RETIRED_CURSOR_EVENTS.every(event => !(config.hooks?.[event] as unknown[] | undefined)?.some(entry => ownsCommand((entry as Record<string, unknown>).command, 'cursor')))
      && CURSOR_HOOK_EVENTS.every(event => Array.isArray(config.hooks?.[event])
      && config.hooks[event].some((entry: unknown) => equal(entry, cursorEntry(platform, event))));
  } catch {
    return false;
  }
}
