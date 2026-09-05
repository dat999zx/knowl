import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knowlPlugin from '../../../integrations/openclaw/src/index.js';
import type { NormalizedHostHook } from '../../../src/core/host-hook-types.js';
import * as pluginModule from '@dat999zx/knowl/plugin';

const CLI_PATH = path.resolve('dist/index.js');

describe('OpenClaw hooks: recall card', () => {
  let scratchDir: string;
  let registeredHooks: Map<string, Array<{ handler: (...args: unknown[]) => Promise<unknown> | unknown; opts?: unknown }>>;
  let api: any;

  beforeEach(async () => {
    scratchDir = path.join(os.tmpdir(), `knowl-openclaw-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(scratchDir, { recursive: true });

    registeredHooks = new Map();
    api = {
      id: 'knowl',
      name: 'Knowl',
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      pluginConfig: {},
      on: vi.fn((hookName: string, handler: any, opts: any) => {
        if (!registeredHooks.has(hookName)) {
          registeredHooks.set(hookName, []);
        }
        registeredHooks.get(hookName)!.push({ handler, opts });
      }),
      registerAgentToolResultMiddleware: vi.fn(),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });

  it('registers before_prompt_build and asserts no secondary prompt publishers are registered', () => {
    knowlPlugin.register(api);

    expect(registeredHooks.has('before_prompt_build')).toBe(true);
    // PR #257 invariant: exactly one hook publishes prompt context
    expect(registeredHooks.has('agent_turn_prepare')).toBe(false);
    expect(registeredHooks.has('heartbeat_prompt_contribution')).toBe(false);
  });

  it('regression test for #257: two different prompts produce the identical recall card and no prompt text reaches the engine payload', async () => {
    const repo1 = path.join(scratchDir, 'repo1');
    const repo2 = path.join(scratchDir, 'repo2');
    await fs.mkdir(repo1, { recursive: true });
    await fs.mkdir(repo2, { recursive: true });

    // Initialize real knowl database in both scratch directories
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: repo1, encoding: 'utf8' });
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: repo2, encoding: 'utf8' });

    // Disable fleet roster in both repos so fleet peer banners do not differentiate the orientation cards
    const noFleetConfig = JSON.stringify({ fleet: { enabled: false } }, null, 2);
    await fs.writeFile(path.join(repo1, '.knowl', 'config.json'), noFleetConfig, 'utf8');
    await fs.writeFile(path.join(repo2, '.knowl', 'config.json'), noFleetConfig, 'utf8');

    // Spy on openProject to intercept lifecycle calls and inspect the exact hook passed to the engine
    const capturedHooks: NormalizedHostHook[] = [];
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      const origLifecycle = handle.lifecycle.bind(handle);
      handle.lifecycle = async (hook: NormalizedHostHook) => {
        capturedHooks.push(hook);
        return await origLifecycle(hook);
      };
      return handle;
    });

    knowlPlugin.register(api);

    const promptHook = registeredHooks.get('before_prompt_build')?.[0]?.handler;
    expect(promptHook).toBeDefined();

    const promptA = 'Can you describe the architectural layers and memory layout of this system?';
    const promptB = 'What is the population of Tokyo in 2026?';

    const ctxSession1 = {
      workspaceDir: repo1,
      sessionId: 'openclaw-session-1',
      sessionKey: 'main',
    };

    const ctxSession2 = {
      workspaceDir: repo2,
      sessionId: 'openclaw-session-2',
      sessionKey: 'main',
    };

    // Prompt A in Repo 1
    const resultA = (await promptHook!({ prompt: promptA }, ctxSession1)) as { prependContext?: string } | undefined;
    expect(resultA).toBeDefined();
    expect(resultA?.prependContext).toBeDefined();
    expect(resultA?.prependContext?.length).toBeGreaterThan(0);

    // Prompt B in Repo 2
    const resultB = (await promptHook!({ prompt: promptB }, ctxSession2)) as { prependContext?: string } | undefined;
    expect(resultB).toBeDefined();
    expect(resultB?.prependContext).toBeDefined();

    // Invariant 1 (regression test for #257): Two different prompts produce the IDENTICAL orientation card
    expect(resultA?.prependContext).toBe(resultB?.prependContext);

    // Subsequent prompt in Session 1 delivers context once per session (not duplicated)
    const resultA2 = (await promptHook!({ prompt: 'Another follow-up message' }, ctxSession1)) as { prependContext?: string } | undefined;
    expect(resultA2).toBeUndefined();

    // Invariant 2: Assert no prompt substring reaches the engine payload
    expect(capturedHooks.length).toBe(3);
    for (const hook of capturedHooks) {
      expect(hook.event).toBe('turn-start');
      expect(hook.payload).not.toHaveProperty('prompt');

      const payloadStr = JSON.stringify(hook.payload);
      expect(payloadStr).not.toContain('architectural layers');
      expect(payloadStr).not.toContain('population of Tokyo');
      expect(payloadStr).not.toContain('Another follow-up message');
    }
  });

  it('returns undefined cleanly when run outside a knowl project directory', async () => {
    knowlPlugin.register(api);

    const promptHook = registeredHooks.get('before_prompt_build')?.[0]?.handler;
    expect(promptHook).toBeDefined();

    const result = await promptHook!(
      { prompt: 'Some prompt' },
      { workspaceDir: scratchDir, sessionId: 's1' },
    );

    expect(result).toBeUndefined();
  });
});
