import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { hostProfile } from '../../src/session/hosts/index.js';
import { mergeNestedHookConfig, verifyNestedHookConfig } from '../../src/cli/agents/hook-config.js';

const ROOT = path.resolve('.knowl-tool-precheck-test');
// Outside the repo: the settings fixtures here are written concurrently with other lanes'
// suites, and a `.knowl-*` directory in the repo root is swept by their setup.
const workspaces: string[] = [];
const workspace = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-precheck-'));
  workspaces.push(dir);
  return dir;
};

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

describe('PreToolUse normalization', () => {
  it('carries the tool name and the path the call is about to touch', () => {
    const result = normalizeHostHook('claude', 'PreToolUse', {
      session_id: 'session-1',
      cwd: ROOT,
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: path.join(ROOT, 'src/store/impact.ts') },
    });

    expect(result).toMatchObject({
      host: 'claude',
      event: 'tool-precheck',
      externalSessionId: 'session-1',
      projectRoot: ROOT,
      toolName: 'Edit',
      payload: { changedPaths: ['src/store/impact.ts'] },
    });
  });

  it('normalizes paths the same way the post-tool event does', () => {
    // The gate compares these against paths recorded by earlier events. Two spellings of one
    // file would make every lookup miss, and a gate that never fires is indistinguishable
    // from a gate with nothing to report.
    const raw = { session_id: 's', cwd: ROOT, tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'a', 'b.ts') } };
    const before = normalizeHostHook('claude', 'PreToolUse', raw);
    const after = normalizeHostHook('claude', 'PostToolUse', raw);
    expect(before.payload.changedPaths).toEqual(after.payload.changedPaths);
  });

  it('drops a target outside the project rather than inventing a relative path', () => {
    const result = normalizeHostHook('claude', 'PreToolUse', {
      session_id: 's', cwd: ROOT, tool_name: 'Write', tool_input: { file_path: path.resolve('/elsewhere/x.ts') },
    });
    expect(result.payload.changedPaths).toEqual([]);
  });

  it('degrades to an empty target list when the host names no tool and no path', () => {
    const result = normalizeHostHook('claude', 'PreToolUse', { session_id: 's', cwd: ROOT });
    expect(result.event).toBe('tool-precheck');
    expect(result.toolName).toBeUndefined();
    expect(result.payload.changedPaths).toEqual([]);
  });

  it('does not retain the body of the write it is checking', () => {
    const result = normalizeHostHook('claude', 'PreToolUse', {
      session_id: 's', cwd: ROOT, tool_name: 'Write',
      tool_input: { file_path: path.join(ROOT, 'a.ts'), content: 'Private file body must not be stored' },
    });
    expect(JSON.stringify(result)).not.toContain('Private file body');
  });

  it('answers a sensitive target instead of erroring on it', () => {
    // The write validator refuses `.env`, which is right for a stored atom and wrong here:
    // a precheck is answered and discarded, and throwing would print an error in front of
    // that tool call and every retry of it.
    const result = normalizeHostHook('claude', 'PreToolUse', {
      session_id: 's', cwd: ROOT, tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, '.env') },
    });
    expect(result.payload.changedPaths).toEqual(['.env']);
  });

  it('keeps the event off hosts that do not register it', () => {
    // Cursor has no pre-tool event of any name. Codex used to be here too, on the strength of
    // its 0.145.0 dispatcher enum; 0.147.0's binary carries PreToolUse, PermissionRequest and
    // permissionDecision, so it moved to the test below.
    expect(hostProfile('cursor').normalizedEvent('PreToolUse')).toBeUndefined();
    expect(hostProfile('claude-desktop').normalizedEvent('PreToolUse')).toBeUndefined();
    expect(() => normalizeHostHook('cursor', 'PreToolUse', { conversation_id: 's', cwd: ROOT }))
      .toThrow('Unsupported cursor hook event');
  });

  it('normalizes the event on codex, which implements the same route', () => {
    expect(hostProfile('codex').normalizedEvent('PreToolUse')).toBe('tool-precheck');
    expect(normalizeHostHook('codex', 'PreToolUse', { session_id: 's', cwd: ROOT }).event)
      .toBe('tool-precheck');
  });

  it('rejects PermissionRequest, which would answer with the wrong event name', () => {
    // Codex has the event, but `tool-precheck` discards the host event name and the refusal is
    // stamped `hookEventName: "PreToolUse"`. Answering a PermissionRequest with it would land
    // the write while telling the caller it was blocked.
    for (const host of ['codex', 'claude'] as const) {
      expect(hostProfile(host).normalizedEvent('PermissionRequest'), host).toBeUndefined();
      expect(hostProfile(host).hookEvents, host).not.toContain('PermissionRequest');
    }
  });

  it('leaves the existing events byte-identical', () => {
    const raw = {
      session_id: 'session-2', cwd: ROOT, tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 },
    };
    expect(normalizeHostHook('claude', 'PostToolUse', raw)).toEqual({
      host: 'claude', event: 'session-event', externalSessionId: 'session-2', externalTurnId: undefined,
      projectRoot: ROOT, type: 'command', payload: { command: 'npm test', exitCode: 0 },
      status: undefined, toolName: 'Bash', knowlTool: false,
      // The host's own event name, kept beside the normalized one: Windsurf classifies writes
      // by event rather than by tool, and a pre-tool verdict has to name the event it answers.
      hostEvent: 'PostToolUse',
    });
    expect(normalizeHostHook('claude', 'SessionStart', { session_id: 's', cwd: ROOT }))
      .toEqual({ host: 'claude', event: 'session-start', externalSessionId: 's', externalTurnId: undefined, projectRoot: ROOT, title: 'Agent session', payload: {}, hostEvent: 'SessionStart' });
  });
});

describe('tool-call denial', () => {
  it('returns Claude Code\'s documented deny envelope', () => {
    expect(hostProfile('claude').denyToolCall?.('re-read src/a.ts: it changed'))
      .toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 're-read src/a.ts: it changed',
        },
      });
  });

  it('passes a long reason through uncut', () => {
    // The reason carries the diff and the recovery instruction; truncating it leaves the
    // agent blocked without being told what to do.
    const reason = 'x'.repeat(8_000);
    const output = hostProfile('claude').denyToolCall?.(reason) as any;
    expect(output.hookSpecificOutput.permissionDecisionReason).toHaveLength(8_000);
  });

  it('yields undefined for every host whose refusal channel is unconfirmed', () => {
    // Codex left this list at 0.147.0 and Cursor left it once `preToolUse` was read properly --
    // Cursor has no `beforeFileEdit`, which is not the same as having no pre-tool event.
    for (const host of ['claude-desktop', 'generic'] as const) {
      expect(hostProfile(host).denyToolCall?.('nope'), host).toBeUndefined();
    }
  });

  it('gives cursor its own verdict shape, shared with no other host', () => {
    // `permission`, not `permissionDecision`, and the reason is split across a message for the
    // person and a message for the model.
    expect(hostProfile('cursor').denyToolCall?.('re-read src/a.ts')).toEqual({
      permission: 'deny',
      user_message: 're-read src/a.ts',
      agent_message: 're-read src/a.ts',
    });
  });

  it('gives codex the same envelope as claude, from one shared builder', () => {
    const reason = 're-read src/a.ts: it changed';
    expect(hostProfile('codex').denyToolCall?.(reason))
      .toEqual(hostProfile('claude').denyToolCall?.(reason));
  });
});

describe('PreToolUse registration', () => {
  it('registers with the same command shape as the other events', async () => {
    const dir = await workspace();
    const configPath = path.join(dir, 'settings.json');
    expect(await mergeNestedHookConfig(configPath, 'win32', 'claude')).toBe('configured');

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.hooks.PreToolUse).toEqual([{
      matcher: '.*',
      hooks: [{ type: 'command', command: 'knowl.cmd agent-hook claude PreToolUse --json', timeout: 30, statusMessage: '' }],
    }]);
    expect(config.hooks.PreToolUse[0].hooks[0]).toEqual({
      ...config.hooks.PostToolUse[0].hooks[0],
      command: 'knowl.cmd agent-hook claude PreToolUse --json',
    });
    expect(await verifyNestedHookConfig(configPath, 'win32', 'claude')).toBe(true);
  });

  it('is idempotent on a re-run', async () => {
    const dir = await workspace();
    const configPath = path.join(dir, 'settings.json');
    await mergeNestedHookConfig(configPath, 'linux', 'claude');
    const first = await readFile(configPath, 'utf8');
    expect(await mergeNestedHookConfig(configPath, 'linux', 'claude')).toBe('unchanged');
    expect(await readFile(configPath, 'utf8')).toBe(first);
  });

  it('adds the event to a settings.json written before it existed, keeping foreign handlers', async () => {
    const dir = await workspace();
    const configPath = path.join(dir, 'settings.json');
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'someone-elses-tool' }] };
    await mergeNestedHookConfig(configPath, 'linux', 'claude');
    const older = JSON.parse(await readFile(configPath, 'utf8'));
    delete older.hooks.PreToolUse;
    older.hooks.PostToolUse = [foreign, ...older.hooks.PostToolUse];
    await writeFile(configPath, `${JSON.stringify(older, null, 2)}\n`);

    // Stale until something re-runs the merge -- nothing does so on its own, which is why
    // doctor has to see it as a warning with a host-init remedy.
    expect(await verifyNestedHookConfig(configPath, 'linux', 'claude')).toBe(false);
    expect(await mergeNestedHookConfig(configPath, 'linux', 'claude')).toBe('updated');

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('knowl agent-hook claude PreToolUse --json');
    expect(config.hooks.PostToolUse[0]).toEqual(foreign);
    expect(await verifyNestedHookConfig(configPath, 'linux', 'claude')).toBe(true);
  });

  it('registers the event for Codex too, and retires the two events it never had', async () => {
    const dir = await workspace();
    const configPath = path.join(dir, 'settings.json');
    // Seeded as an older build wrote it: two handlers for events no codex build implements.
    await writeFile(configPath, JSON.stringify({ hooks: {
      PostToolUseFailure: [{ matcher: '.*', hooks: [{ type: 'command', command: 'knowl agent-hook codex PostToolUseFailure --json' }] }],
      StopFailure: [{ matcher: '.*', hooks: [{ type: 'command', command: 'knowl agent-hook codex StopFailure --json' }] }],
    } }), 'utf8');

    await mergeNestedHookConfig(configPath, 'linux', 'codex');
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('knowl agent-hook codex PreToolUse --json');
    expect(config.hooks.PostToolUseFailure).toBeUndefined();
    expect(config.hooks.StopFailure).toBeUndefined();
    // The prompt event carries the reminder and never a lifecycle handler.
    expect(JSON.stringify(config.hooks.UserPromptSubmit)).toContain('agent-reminder codex');
    expect(JSON.stringify(config.hooks.UserPromptSubmit)).not.toContain('agent-hook codex');
    expect(await verifyNestedHookConfig(configPath, 'linux', 'codex')).toBe(true);
  });

  it('keeps a foreign handler on a retired event, removing only the Knowl one', async () => {
    const dir = await workspace();
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({ hooks: {
      StopFailure: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'knowl agent-hook codex StopFailure --json' }] },
        { matcher: '.*', hooks: [{ type: 'command', command: 'someone-elses-hook' }] },
      ],
    } }), 'utf8');

    await mergeNestedHookConfig(configPath, 'linux', 'codex');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.hooks.StopFailure).toEqual([{ matcher: '.*', hooks: [{ type: 'command', command: 'someone-elses-hook' }] }]);
  });
});

describe('the generic contract carries what impact detection needs', () => {
  it('keeps the tool name a caller supplied', () => {
    // It used to be dropped here and nowhere else -- every other host routes through
    // `toolEvent`, which sets it. Without it `toolReadsFile`/`toolWritesFile` both see '',
    // so a generic caller got neither a read-set entry nor impact detection, silently,
    // because capture itself worked fine and the subsystem simply never fired.
    const result = normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: ROOT, type: 'checkpoint', tool_name: 'Read',
    });
    expect(result.toolName).toBe('Read');
    expect(normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: ROOT, type: 'checkpoint', toolName: 'Edit',
    }).toolName).toBe('Edit');
  });

  it('makes an absolute path repo-relative, and leaves a relative one alone', () => {
    // A program integrating over this contract naturally has absolute paths, and storing them
    // verbatim wrote a spelling nothing else in the codebase looks up.
    const absolute = normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: ROOT, type: 'checkpoint',
      changedPaths: [path.join(ROOT, 'src', 'a.ts')],
    });
    expect(absolute.payload.changedPaths).toEqual(['src/a.ts']);

    // Resolving an already-relative entry against the *process* cwd is how a valid path turns
    // into `..` and gets dropped.
    const relative = normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: ROOT, type: 'checkpoint', changedPaths: ['src/b.ts'],
    });
    expect(relative.payload.changedPaths).toEqual(['src/b.ts']);
  });

  it('drops a path outside the project rather than inventing one', () => {
    const result = normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: ROOT, type: 'checkpoint',
      changedPaths: [path.resolve('/elsewhere/x.ts'), path.join(ROOT, 'src', 'c.ts')],
    });
    expect(result.payload.changedPaths).toEqual(['src/c.ts']);
  });
});
