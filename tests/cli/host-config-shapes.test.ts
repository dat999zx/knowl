import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeHookConfig, verifyHookConfig } from '../../src/cli/agents/hook-config.js';
import { hostProfile } from '../../src/session/hosts/index.js';

/**
 * Each host's hooks file, asserted against the shape its own vendor documents.
 *
 * This is the failure these tests exist for: a hooks file in the wrong shape is *parsed without
 * error* and acted on not at all. Nothing throws, `knowl doctor` is quiet, and the integration
 * is dead. Every assertion here is a literal from a vendor reference rather than a shape
 * inferred from the host next door -- which is exactly how Codex ended up with two handlers for
 * events it never had.
 */
const workspaces: string[] = [];
const workspace = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-hostshape-'));
  workspaces.push(dir);
  return dir;
};
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

describe('Copilot hooks file', () => {
  it('carries the version key Copilot rejects the file without', async () => {
    const file = path.join(await workspace(), 'knowl.json');
    expect(await mergeHookConfig(file, 'linux', 'copilot')).toBe('configured');

    const config = await readJson(file);
    expect(config.version).toBe(1);
    expect(config.hooks.preToolUse[0].hooks[0].command).toBe('knowl agent-hook copilot preToolUse --json');
    expect(await verifyHookConfig(file, 'linux', 'copilot')).toBe(true);
  });

  it('uses camelCase and never registers an event with no camelCase original', async () => {
    // `SubagentStart` exists in the PascalCase alias table only. Registering it would repeat
    // the dead-entry bug this release removes from Codex.
    const events = hostProfile('copilot').hookEvents;
    expect(events).not.toContain('SubagentStart');
    for (const event of events) expect(event[0]).toBe(event[0].toLowerCase());
  });

  it('is idempotent, and a re-run leaves a foreign handler in place', async () => {
    const file = path.join(await workspace(), 'knowl.json');
    await writeFile(file, JSON.stringify({ version: 1, hooks: {
      postToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'someone-else' }] }],
    } }), 'utf8');

    await mergeHookConfig(file, 'linux', 'copilot');
    expect(await mergeHookConfig(file, 'linux', 'copilot')).toBe('unchanged');

    const config = await readJson(file);
    expect(config.hooks.postToolUse[0].hooks[0].command).toBe('someone-else');
    expect(config.hooks.postToolUse).toHaveLength(2);
  });
});

describe('OpenHands hooks file', () => {
  it('puts the events at the top level, with no hooks wrapper', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    expect(await mergeHookConfig(file, 'linux', 'openhands')).toBe('configured');

    const config = await readJson(file);
    // The whole point: `{ pre_tool_use: [...] }`, not `{ hooks: { pre_tool_use: [...] } }`.
    expect(config.hooks).toBeUndefined();
    expect(config.pre_tool_use).toEqual([{
      // `*`, not the regex `.*` the Anthropic-shaped hosts take. `type` is in OpenHands' own
      // field table (optional, defaulting to "command"), so emitting it is valid.
      matcher: '*',
      hooks: [{ type: 'command', command: 'knowl agent-hook openhands pre_tool_use --json', timeout: 30 }],
    }]);
    // `statusMessage` is not in OpenHands' schema at all, so it must not be emitted.
    expect(JSON.stringify(config)).not.toContain('statusMessage');
    // The prompt reminder, which the first hand-rolled OpenHands writer silently dropped.
    expect(JSON.stringify(config.user_prompt_submit)).toContain('agent-reminder openhands');
    expect(await verifyHookConfig(file, 'linux', 'openhands')).toBe(true);
  });

  it('keeps a foreign top-level key untouched', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    await writeFile(file, JSON.stringify({
      post_tool_use: [{ matcher: 'terminal', hooks: [{ command: 'theirs.sh' }] }],
      unrelated_setting: true,
    }), 'utf8');

    await mergeHookConfig(file, 'linux', 'openhands');
    const config = await readJson(file);
    expect(config.unrelated_setting).toBe(true);
    expect(config.post_tool_use[0]).toEqual({ matcher: 'terminal', hooks: [{ command: 'theirs.sh' }] });
    expect(config.post_tool_use).toHaveLength(2);
  });
});

describe('Antigravity hooks file', () => {
  it('nests a hook name above the event, one level deeper than Claude', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    expect(await mergeHookConfig(file, 'linux', 'antigravity')).toBe('configured');

    const config = await readJson(file);
    expect(config.hooks).toBeUndefined();
    expect(config.knowl.PreToolUse[0].hooks[0].command).toBe('knowl agent-hook antigravity PreToolUse --json');
    expect(await verifyHookConfig(file, 'linux', 'antigravity')).toBe(true);
  });

  it('owns only its own key and never rewrites another hook set', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    await writeFile(file, JSON.stringify({
      'safety-gate': { PreToolUse: [{ matcher: '.*', hooks: [{ command: 'theirs' }] }] },
    }), 'utf8');

    await mergeHookConfig(file, 'linux', 'antigravity');
    const config = await readJson(file);
    expect(config['safety-gate']).toEqual({ PreToolUse: [{ matcher: '.*', hooks: [{ command: 'theirs' }] }] });
    expect(config.knowl.PreToolUse).toBeDefined();
  });
});

describe('Windsurf hooks file', () => {
  it('writes a flat command list with none of Cursor’s extra fields', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    expect(await mergeHookConfig(file, 'linux', 'windsurf')).toBe('configured');

    const config = await readJson(file);
    // Flat: no matcher, no nested hooks array, and no `timeout` -- Windsurf documents none.
    expect(config.hooks.pre_write_code).toEqual([{ command: 'knowl agent-hook windsurf pre_write_code --json' }]);
    expect(config.version).toBeUndefined();
    expect(await verifyHookConfig(file, 'linux', 'windsurf')).toBe(true);
  });

  it('registers no event that fires twice for one thing', () => {
    const events = hostProfile('windsurf').hookEvents;
    // Both fire for the same response; registering both would close the turn twice.
    expect(events).toContain('post_cascade_response');
    expect(events).not.toContain('post_cascade_response_with_transcript');
    // The gate only ever refuses writes, so a pre-hook on reads would answer "no opinion" in
    // front of every file the agent opens.
    expect(events).not.toContain('pre_read_code');
    expect(events).toContain('pre_write_code');
  });
});

describe('Cursor is unchanged by the shared writer', () => {
  it('still emits version 1 and a timeout', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    await mergeHookConfig(file, 'win32', 'cursor');

    const config = await readJson(file);
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart).toEqual([{ command: 'knowl.cmd agent-hook cursor sessionStart --json', timeout: 30 }]);
    expect(await verifyHookConfig(file, 'win32', 'cursor')).toBe(true);
  });
});

describe('every host with a deny channel can actually deliver a refusal', () => {
  it('renders a reason on whichever channel it declared', () => {
    for (const host of ['claude', 'codex', 'copilot', 'openhands', 'antigravity', 'windsurf'] as const) {
      const profile = hostProfile(host);
      if (!profile.denyToolCall) continue;
      const envelope = profile.denyToolCall('re-read src/a.ts');
      expect(JSON.stringify(envelope), host).toContain('re-read src/a.ts');
    }
  });
});

describe('the --host flag on the MCP entry', () => {
  it('names the host, so the initialize card can be exact', async () => {
    const { createHookHostAdapter, hookHostSpecs } = await import('../../src/cli/agents/hook-host-adapter.js');
    const dir = await workspace();
    const environment = {
      platform: 'linux' as const, homeDir: dir, appDataDir: dir, commandExists: async () => true,
    };
    const copilot = hookHostSpecs(environment).find(spec => spec.name === 'copilot')!;
    await createHookHostAdapter(copilot, environment).configure(dir);

    const config = await readJson(path.join(dir, '.github', 'mcp.json'));
    expect(config.mcpServers.knowl.args).toEqual(['serve', '--host', 'copilot']);
  });

  it('does not report an install written before the flag existed as unconfigured', async () => {
    // The upgrade case. A strict positional comparison would have put every existing user into
    // doctor's drift list and invited `doctor --fix` to rewrite files that were working.
    const { mcpEntryMatches } = await import('../../src/cli/agents/files.js');
    const withHost = { command: 'knowl', args: ['serve', '--host', 'claude'] };

    expect(mcpEntryMatches({ command: 'knowl', args: ['serve'] }, withHost)).toBe(true);
    expect(mcpEntryMatches(withHost, withHost)).toBe(true);
    // An entry somebody edited on purpose is still a mismatch.
    expect(mcpEntryMatches({ command: 'knowl', args: ['serve', '--verbose'] }, withHost)).toBe(false);
    expect(mcpEntryMatches({ command: 'other', args: ['serve'] }, withHost)).toBe(false);
  });

  it('gives each host a mode line it can act on without inferring which branch applies', async () => {
    const { mcpModeLineForHost } = await import('../../src/session/hosts/index.js');
    const { KNOWL_HOST_NEUTRAL_MODE_LINE } = await import('../../src/core/knowl-guidance.js');

    expect(mcpModeLineForHost('claude')).toContain('Claude hooks own lifecycle');
    expect(mcpModeLineForHost('claude')).not.toContain('when active');
    expect(mcpModeLineForHost('copilot')).toContain('Copilot hooks own lifecycle');
    // No hook channel at all: told it owns the loop, rather than left with a conditional.
    expect(mcpModeLineForHost('claude-desktop')).toContain('you own the work loop');
    expect(mcpModeLineForHost('claude-desktop')).not.toContain('when active');
    // An unknown or absent host keeps today's card rather than throwing: this string comes off
    // a command line, and a hand-edited config must not stop the server booting.
    expect(mcpModeLineForHost(undefined)).toBe(KNOWL_HOST_NEUTRAL_MODE_LINE);
    expect(mcpModeLineForHost('not-a-host')).toBe(KNOWL_HOST_NEUTRAL_MODE_LINE);
  });
});

describe('the deny path each host actually declared', () => {
  it('recognises each host’s own write tool, which is what reaches the deny channel at all', async () => {
    const { normalizeHostHook } = await import('../../src/cli/agents/host-hook.js');
    const root = await workspace();

    // The bug this pins: `runWriteGate` returns before consulting `denyToolCall` unless the
    // profile recognises the tool, so a host with a perfect deny envelope and an unrecognised
    // tool name is silently ungated. Every row is a *host's own* vocabulary, not Claude's.
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['claude', 'PreToolUse', { session_id: 's', tool_name: 'Edit' }],
      ['codex', 'PreToolUse', { session_id: 's', tool_name: 'apply_patch' }],
      ['copilot', 'preToolUse', { session_id: 's', tool_name: 'str_replace' }],
      ['openhands', 'pre_tool_use', { conversation_id: 's', tool_name: 'str_replace_editor' }],
      ['antigravity', 'PreToolUse', { session_id: 's', tool_name: 'edit_file' }],
      // Windsurf names the action and sends no tool name at all.
      ['windsurf', 'pre_write_code', { conversation_id: 's' }],
    ];

    for (const [host, event, raw] of cases) {
      const normalized = normalizeHostHook(host, event, {
        ...raw, cwd: root, tool_input: { file_path: path.join(root, 'src/a.ts') },
      });
      expect(normalized.event, host).toBe('tool-precheck');
      expect(normalized.hostEvent, host).toBe(event);
      expect(normalized.payload.changedPaths, host).toEqual(['src/a.ts']);
      // The reason must survive into whatever envelope this host declared.
      const envelope = hostProfile(host as any).denyToolCall?.('re-read src/a.ts');
      expect(JSON.stringify(envelope), host).toContain('re-read src/a.ts');
    }
  });

  it('does not treat a read as a write on any host', async () => {
    const { normalizeHostHook } = await import('../../src/cli/agents/host-hook.js');
    const root = await workspace();
    const normalized = normalizeHostHook('codex', 'PostToolUse', {
      session_id: 's', cwd: root, tool_name: 'read_file',
      tool_input: { file_path: path.join(root, 'src/a.ts') },
    });
    // `read_file` is codex's reader; the shared Claude fallback would have matched neither.
    expect(hostProfile('codex').readsFiles?.('PostToolUse', 'read_file')).toBe(true);
    expect(hostProfile('codex').writesFiles?.('PostToolUse', 'read_file')).toBe(false);
    expect(normalized.toolName).toBe('read_file');
  });

  it('never promises hooks own the lifecycle for a host whose hooks may not be running', async () => {
    const { mcpModeLineForHost } = await import('../../src/session/hosts/index.js');
    const { KNOWL_HOST_NEUTRAL_MODE_LINE } = await import('../../src/core/knowl-guidance.js');

    // Codex hooks are behind a feature flag and absent on Windows; Antigravity and Windsurf
    // register MCP once at user scope but hooks per project. Telling any of them "never call
    // knowl_task_start" leaves a session with no hooks and no manual loop either.
    for (const host of ['codex', 'antigravity', 'windsurf']) {
      expect(mcpModeLineForHost(host), host).toBe(KNOWL_HOST_NEUTRAL_MODE_LINE);
    }
    // Hosts whose hooks land with the MCP entry, in the same directory, may say it outright.
    expect(mcpModeLineForHost('claude')).toContain('Claude hooks own lifecycle');
    expect(mcpModeLineForHost('copilot')).toContain('Copilot hooks own lifecycle');
    // An MCP-only agent owns the loop; it is the case the manual line was written for.
    expect(mcpModeLineForHost('opencode')).toContain('you own the work loop');
    // Cline is neither: it registers no file and still has a lifecycle, through a plugin the
    // person opts into, so the conditional line is the only true one.
    expect(mcpModeLineForHost('cline')).toBe(KNOWL_HOST_NEUTRAL_MODE_LINE);
  });
});

describe('two failures that only show up on a host nobody has installed', () => {
  it('stamps every context envelope with the event that actually fired', () => {
    // Output whose `hookEventName` does not match the firing event is discarded. Copilot wrote
    // this as a two-way ternary, so registering `subagentStart` silently answered it with the
    // prompt event's name and dropped every subagent bootstrap card.
    const expected: Record<string, Record<string, string>> = {
      claude: { 'session-start': 'SessionStart', 'agent-start': 'SubagentStart', 'turn-start': 'UserPromptSubmit' },
      codex: { 'session-start': 'SessionStart', 'agent-start': 'SubagentStart', 'turn-start': 'UserPromptSubmit' },
      copilot: { 'session-start': 'sessionStart', 'agent-start': 'subagentStart', 'turn-start': 'userPromptSubmitted' },
    };
    for (const [host, events] of Object.entries(expected)) {
      for (const [event, name] of Object.entries(events)) {
        const output = hostProfile(host as any).startContext(event as any, 'x') as any;
        expect(output?.hookSpecificOutput?.hookEventName, `${host}:${event}`).toBe(name);
      }
    }
  });

  it('never classifies one tool as both a read and a write', () => {
    // `runToolEventImpact` tests reads first, so a dual-purpose editor listed in both records
    // every edit as a read: no re-index, no detection, and a belief the session does not hold.
    const dualPurpose = ['str_replace_editor', 'edit', 'write', 'create', 'apply_patch', 'view', 'read', 'read_file'];
    for (const host of ['codex', 'cursor', 'copilot', 'openhands', 'antigravity', 'windsurf'] as const) {
      const profile = hostProfile(host);
      for (const tool of dualPurpose) {
        const reads = profile.readsFiles?.('', tool) ?? false;
        const writes = profile.writesFiles?.('', tool) ?? false;
        expect(reads && writes, `${host}:${tool}`).toBe(false);
      }
    }
  });

  it('lets a host be initialised when its MCP config is ours to write by hand', async () => {
    // OpenHands runs through Docker or uvx, so the binary is often not on PATH. `verify` must
    // not answer "is this host installed" -- there is nothing to verify for a config Knowl
    // deliberately does not write, and answering false makes init exit 1 before it ever writes
    // the hooks file.
    const { createHookHostAdapter, hookHostSpecs } = await import('../../src/cli/agents/hook-host-adapter.js');
    const dir = await workspace();
    const environment = {
      platform: 'linux' as const, homeDir: dir, appDataDir: dir, commandExists: async () => false,
    };
    const spec = hookHostSpecs(environment).find(s => s.name === 'openhands')!;
    const adapter = createHookHostAdapter(spec, environment);

    expect(await adapter.verify(dir)).toBe(true);
    // ...while doctor still stays silent, because nothing here is installed.
    expect((await adapter.detect(dir)).configured).toBe(false);
  });

  it('survives a config file another vendor left empty', async () => {
    // Gemini CLI leaves a 0-byte mcp_config.json at the path Antigravity reads. Rethrowing the
    // parse error took detection for all nine hosts down before `knowl init` showed its picker.
    const { createAgentRegistry, detectAgents } = await import('../../src/cli/agents/registry.js');
    const dir = await workspace();
    await import('node:fs/promises').then(fs => fs.mkdir(path.join(dir, '.gemini', 'config'), { recursive: true }));
    await writeFile(path.join(dir, '.gemini', 'config', 'mcp_config.json'), '', 'utf8');

    const registry = createAgentRegistry({
      platform: 'linux', homeDir: dir, appDataDir: dir, commandExists: async () => true,
    });
    const detected = await detectAgents(dir, registry);
    expect(detected.map(d => d.adapter.name)).toContain('antigravity');
  });
});

describe('channels that exist under a different name than expected', () => {
  it('cursor gates on preToolUse, which is not the same as beforeFileEdit', () => {
    const profile = hostProfile('cursor');
    expect(profile.hookEvents).toContain('preToolUse');
    expect(profile.normalizedEvent('preToolUse')).toBe('tool-precheck');
    // Cursor names its tools the same words Claude does, which is why afterFileEdit was the
    // half that silently did not work rather than the half that did.
    expect(profile.writesFiles?.('preToolUse', 'Write')).toBe(true);
    expect(profile.writesFiles?.('afterFileEdit', '')).toBe(true);
    expect(profile.readsFiles?.('postToolUse', 'Read')).toBe(true);
    // Fire-and-forget stop, but followup_message is submitted as the next user message.
    expect(profile.stopContext?.('store what you learned'))
      .toEqual({ followup_message: 'store what you learned' });
  });

  it('antigravity carries context as trajectory steps, not as an additionalContext field', () => {
    const profile = hostProfile('antigravity');
    // No prompt-submit and no session-start event; PreInvocation is the slot both use.
    expect(profile.normalizedEvent('PreInvocation')).toBe('turn-start');
    expect(profile.hookEvents).toContain('PreInvocation');
    expect(profile.startContext('turn-start', 'remember this'))
      .toEqual({ injectSteps: [{ ephemeralMessage: 'remember this' }] });
    // ephemeral, not userMessage (which would put words in the person's mouth) and not
    // toolCall (which would have Knowl execute something as the agent).
    expect(JSON.stringify(profile.midTurnContext('x'))).not.toContain('userMessage');
    expect(JSON.stringify(profile.midTurnContext('x'))).not.toContain('toolCall');
  });

  it('still refuses to claim delivery nobody has observed', () => {
    // Both hosts now emit a context envelope. Neither may claim it lands.
    for (const host of ['cursor', 'antigravity'] as const) {
      expect(hostProfile(host).midTurnContext('x'), host).toBeDefined();
      expect(hostProfile(host).midTurnDeliveryVerified, host).toBe(false);
    }
  });
});
