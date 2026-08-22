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
