import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knowlPlugin, { resetImpactSeenForTest } from '../../../integrations/openclaw/src/index.js';
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

describe('OpenClaw hooks: write gate', () => {
  let scratchDir: string;
  let registeredHooks: Map<string, Array<{ handler: (...args: unknown[]) => Promise<unknown> | unknown; opts?: unknown }>>;
  let api: any;

  beforeEach(async () => {
    scratchDir = path.join(os.tmpdir(), `knowl-openclaw-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('registers before_tool_call with canonical write tool matcher', () => {
    knowlPlugin.register(api);

    const gateEntries = registeredHooks.get('before_tool_call');
    expect(gateEntries).toBeDefined();
    expect(gateEntries?.length).toBe(1);

    const opts = gateEntries![0].opts as { matcher: string[] };
    expect(opts).toBeDefined();
    expect(opts.matcher).toEqual(['exec', 'apply_patch', 'spawn_agent']);
  });

  it('allows write when engine has no objection (returns undefined, never params or block: false)', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    knowlPlugin.register(api);
    const gateHook = registeredHooks.get('before_tool_call')?.[0]?.handler;
    expect(gateHook).toBeDefined();

    const event = {
      toolName: 'apply_patch',
      params: { patch: '*** test patch ***', path: 'src/index.ts' },
      derivedPaths: ['src/index.ts'],
    };
    const ctx = {
      workspaceDir: scratchDir,
      sessionId: 'gate-session-1',
    };

    const result = (await gateHook!(event, ctx)) as any;
    // Decision is abstain (undefined) so host allows the write
    expect(result).toBeUndefined();
    expect(result?.params).toBeUndefined();
    expect(result?.block).toBeUndefined();
  });

  it('blocks write when engine lifecycle refuses, returning blockReason and never params', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    // Mock lifecycle to return a refusal
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.lifecycle = async () => ({
        accepted: true,
        hostOutput: {
          block: true,
          blockReason: 'Modifying src/core.ts contradicts a verified invariant from Task 2.',
        },
      });
      return handle;
    });

    knowlPlugin.register(api);
    const gateHook = registeredHooks.get('before_tool_call')?.[0]?.handler;

    const event = {
      toolName: 'apply_patch',
      params: { patch: '*** bad patch ***', path: 'src/core.ts' },
      derivedPaths: ['src/core.ts'],
    };
    const ctx = {
      workspaceDir: scratchDir,
      sessionId: 'gate-session-refusal',
    };

    const result = (await gateHook!(event, ctx)) as any;
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe('Modifying src/core.ts contradicts a verified invariant from Task 2.');
    // Invariant: Codex relays reject rewrites and fail closed, so never return params
    expect(result?.params).toBeUndefined();
  });

  it('Step 5: test that a stalled engine accepts — deadline fires, returns accept, write proceeds', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    // Configure a short gate deadline to test deadline expiry
    api.pluginConfig = { gateDeadlineMs: 40 };

    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      // Stalled engine: simulates a hung sqlite query or blocked native worker
      handle.lifecycle = async () => new Promise<any>(() => {});
      return handle;
    });

    knowlPlugin.register(api);
    const gateHook = registeredHooks.get('before_tool_call')?.[0]?.handler;

    const start = Date.now();
    const event = {
      toolName: 'exec',
      params: { command: 'rm -rf /tmp/data' },
    };
    const ctx = {
      workspaceDir: scratchDir,
      sessionId: 'gate-session-stall',
    };

    const result = (await gateHook!(event, ctx)) as any;
    const elapsed = Date.now() - start;

    // The gate must resolve well under the host's 15s budget (here in ~40-150ms)
    expect(elapsed).toBeLessThan(1_000);
    // On timeout, gate abstains / accepts rather than failing closed
    expect(result).toBeUndefined();
  });

  it('throwing engine safely accepts the write without crashing the gateway', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.lifecycle = async () => {
        throw new Error('Native LibSQL crash or disk corruption');
      };
      return handle;
    });

    knowlPlugin.register(api);
    const gateHook = registeredHooks.get('before_tool_call')?.[0]?.handler;

    const result = (await gateHook!(
      { toolName: 'spawn_agent', params: { task: 'run' } },
      { workspaceDir: scratchDir, sessionId: 's-err' },
    )) as any;

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Swallowed engine failure: Native LibSQL crash or disk corruption'),
      expect.any(Error),
    );
  });
});

describe('OpenClaw hooks: impact card and capture (Task 9)', () => {
  let scratchDir: string;
  let registeredHooks: Map<string, Array<{ handler: (...args: unknown[]) => Promise<unknown> | unknown; opts?: unknown }>>;
  let registeredMiddleware: Array<{ handler: (...args: unknown[]) => Promise<unknown> | unknown; opts?: unknown }>;
  let api: any;

  beforeEach(async () => {
    resetImpactSeenForTest();
    scratchDir = path.join(os.tmpdir(), `knowl-openclaw-impact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(scratchDir, { recursive: true });

    registeredHooks = new Map();
    registeredMiddleware = [];
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
      registerAgentToolResultMiddleware: vi.fn((handler: any, opts: any) => {
        registeredMiddleware.push({ handler, opts });
      }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Step 1: registers agent tool result middleware with write tool matcher and runtimes', () => {
    knowlPlugin.register(api);

    expect(registeredMiddleware.length).toBe(1);
    const { opts } = registeredMiddleware[0];
    expect(opts).toEqual({
      matcher: ['exec', 'apply_patch', 'spawn_agent'],
      runtimes: ['openclaw', 'codex'],
    });
  });

  it('Step 2: appends impact card to result.content (never only details) and cards once per (session, file)', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    // Store an atom whose affectedPaths covers src/core.ts
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.query = async () => [
        {
          id: 'atom-core-invariant',
          title: 'Database connection pooling invariant',
          category: 'architecture',
          affectedPaths: ['src/core.ts'],
          scope: 'project',
          confidence: 0.95,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          source: 'test',
          content: 'Details here',
        } as any,
      ];
      return handle;
    });

    knowlPlugin.register(api);
    const middleware = registeredMiddleware[0]?.handler;
    expect(middleware).toBeDefined();

    const event = {
      toolName: 'apply_patch',
      args: { patch: '*** Update File: src/core.ts\n@@\n+const x = 1;', path: 'src/core.ts' },
      cwd: scratchDir,
      result: {
        content: [{ type: 'text', text: 'Patch applied successfully' }],
        details: { exitCode: 0, appliedFiles: ['src/core.ts'] },
      },
      toolCallId: 'call-1',
    };
    const ctx = {
      runtime: 'openclaw',
      sessionId: 'sess-impact-1',
    };

    const firstRun = (await middleware!(event, ctx)) as any;
    expect(firstRun).toBeDefined();
    expect(firstRun?.result).toBeDefined();

    // Step 2 invariant: Card text goes in content, never only details
    const content = firstRun.result.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Patch applied successfully' });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('[Knowl] 1 stored item(s) depend on src/core.ts');
    expect(content[1].text).toContain('Database connection pooling invariant');

    // Details is preserved, not replaced
    expect(firstRun.result.details).toEqual({ exitCode: 0, appliedFiles: ['src/core.ts'] });

    // Second call in the same session for the same file: returns undefined (no duplicate card)
    const secondRun = (await middleware!(event, ctx)) as any;
    expect(secondRun).toBeUndefined();
  });

  it('impact card returns undefined when no stored items cover the file', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.query = async () => [
        {
          id: 'atom-unrelated',
          title: 'Unrelated fact',
          category: 'fact',
          affectedPaths: ['docs/other.md'],
        } as any,
      ];
      return handle;
    });

    knowlPlugin.register(api);
    const middleware = registeredMiddleware[0]?.handler;

    const event = {
      toolName: 'apply_patch',
      args: { path: 'src/unrelated.ts' },
      cwd: scratchDir,
      result: { content: [{ type: 'text', text: 'ok' }] },
      toolCallId: 'call-2',
    };
    const ctx = { runtime: 'openclaw', sessionId: 'sess-impact-2' };

    const result = await middleware!(event, ctx);
    expect(result).toBeUndefined();
  });

  it('impact card returns undefined on tool error', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    knowlPlugin.register(api);
    const middleware = registeredMiddleware[0]?.handler;

    const event = {
      toolName: 'apply_patch',
      args: { path: 'src/core.ts' },
      cwd: scratchDir,
      isError: true,
      result: { content: [{ type: 'text', text: 'error applying patch' }] },
      toolCallId: 'call-err',
    };
    const ctx = { runtime: 'openclaw', sessionId: 'sess-impact-3' };

    const result = await middleware!(event, ctx);
    expect(result).toBeUndefined();
  });

  it('Step 3: after_tool_call maps to session-event and maps status correctly without floating promises', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    const capturedEvents: NormalizedHostHook[] = [];
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      const origLifecycle = handle.lifecycle.bind(handle);
      handle.lifecycle = async (hook: NormalizedHostHook) => {
        capturedEvents.push(hook);
        return await origLifecycle(hook);
      };
      return handle;
    });

    knowlPlugin.register(api);
    const afterToolHook = registeredHooks.get('after_tool_call')?.[0]?.handler;
    expect(afterToolHook).toBeDefined();

    // Success call
    await afterToolHook!(
      { toolName: 'exec', params: { command: 'npm test' }, durationMs: 120 },
      { workspaceDir: scratchDir, sessionId: 's-after-1' },
    );

    // Failed call
    await afterToolHook!(
      { toolName: 'exec', params: { command: 'false' }, error: 'Command exited with 1', durationMs: 45 },
      { workspaceDir: scratchDir, sessionId: 's-after-1' },
    );

    expect(capturedEvents.length).toBe(2);
    expect(capturedEvents[0].event).toBe('session-event');
    expect(capturedEvents[0].status).not.toBe('failed');
    expect(capturedEvents[1].event).toBe('session-event');
    expect(capturedEvents[1].status).toBe('failed');
  });

  it('Step 4: before_compaction maps to checkpoint and runs bounded', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    let checkpointFired = false;
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.lifecycle = async (hook: NormalizedHostHook) => {
        if (hook.event === 'checkpoint') {
          checkpointFired = true;
        }
        return { accepted: true };
      };
      return handle;
    });

    knowlPlugin.register(api);
    const compactionHook = registeredHooks.get('before_compaction')?.[0]?.handler;
    expect(compactionHook).toBeDefined();

    await compactionHook!({}, { workspaceDir: scratchDir, sessionId: 's-compact-1' });
    expect(checkpointFired).toBe(true);
  });

  it('Step 5: session_end and agent_end map to turn-stop under shutdown drain budget', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    const stopEvents: NormalizedHostHook[] = [];
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      handle.lifecycle = async (hook: NormalizedHostHook) => {
        stopEvents.push(hook);
        return { accepted: true };
      };
      return handle;
    });

    knowlPlugin.register(api);
    const sessionEndHook = registeredHooks.get('session_end')?.[0]?.handler;
    const agentEndHook = registeredHooks.get('agent_end')?.[0]?.handler;
    expect(sessionEndHook).toBeDefined();
    expect(agentEndHook).toBeDefined();

    await sessionEndHook!({ sessionId: 's-end-1' }, { workspaceDir: scratchDir });
    await agentEndHook!({}, { workspaceDir: scratchDir, sessionId: 's-end-1' });

    expect(stopEvents.length).toBe(2);
    expect(stopEvents[0].event).toBe('turn-stop');
    expect(stopEvents[1].event).toBe('turn-stop');
  });

  it('session_start warms workspace and gateway_stop releases all handles', async () => {
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: scratchDir, encoding: 'utf8' });

    let released = false;
    const origOpenProject = pluginModule.openProject;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      const handle = await origOpenProject(cwd);
      if (!handle) return null;
      const origRelease = handle.release.bind(handle);
      handle.release = async () => {
        released = true;
        return await origRelease();
      };
      return handle;
    });

    knowlPlugin.register(api);
    const sessionStartHook = registeredHooks.get('session_start')?.[0]?.handler;
    const gatewayStopHook = registeredHooks.get('gateway_stop')?.[0]?.handler;
    expect(sessionStartHook).toBeDefined();
    expect(gatewayStopHook).toBeDefined();

    await sessionStartHook!({ sessionId: 's-start-1' }, { workspaceDir: scratchDir });
    expect(released).toBe(false);

    await gatewayStopHook!({}, {});
    expect(released).toBe(true);
  });
});

