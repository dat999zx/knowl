import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../../src/cli/agents/host-hook.js';
import { readLifecyclePayload } from '../../../src/cli/agents/lifecycle.js';
import { hostProfile, toolWritesFile } from '../../../src/session/hosts/index.js';
import { mergeHookConfig, verifyHookConfig } from '../../../src/cli/agents/hook-config.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';

const ROOT = path.resolve('.knowl-antigravity-test');

/**
 * One Antigravity hook payload, in the shape its reference documents and its transcripts show:
 * protojson (every key camelCase), the session under `conversationId`, the root under
 * `workspacePaths`, and the tool as one `toolCall` object whose arguments are PascalCase.
 *
 * Written as stdin rather than passed straight to the normalizer, because the stdin allowlist
 * is where this integration actually died: it dropped all three fields, so every event threw
 * `IncompleteHostHookPayloadError`, the hook entry swallowed it, and the host looked exactly
 * like one nobody had configured. A test that hands the normalizer a payload directly passes
 * against that bug.
 */
const through = async (raw: unknown) => readLifecyclePayload(Readable.from([JSON.stringify(raw)]) as any);

describe('an Antigravity hook payload survives the stdin filter', () => {
  it('keeps the session, the root and the tool call', async () => {
    const payload = await through({
      conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
      workspacePaths: [ROOT],
      toolCall: { name: 'replace_file_content', args: { TargetFile: path.join(ROOT, 'src/a.ts'), Description: 'x' } },
    });
    expect(payload.conversationId).toBe('ec33ebf9-0cba-4100-8142-c61503f6c587');
    expect(payload.workspacePaths).toEqual([ROOT]);
    expect((payload.toolCall as any).name).toBe('replace_file_content');
    expect((payload.toolCall as any).args.TargetFile).toBe(path.join(ROOT, 'src/a.ts'));
  });

  it('drops the file contents beside them', async () => {
    const payload = await through({
      conversationId: 'c1', workspacePaths: [ROOT],
      toolCall: { name: 'write_to_file', args: { TargetFile: path.join(ROOT, 'a.ts'), CodeContent: 'SECRET-BODY' } },
    });
    expect(JSON.stringify(payload)).not.toContain('SECRET-BODY');
  });
});

describe('the normalized Antigravity event', () => {
  it('resolves the session and the root that used to throw', async () => {
    const event = normalizeHostHook('antigravity', 'PreInvocation', await through({
      conversationId: 'c1', workspacePaths: [ROOT], invocationNum: 3,
    }));
    expect(event.externalSessionId).toBe('c1');
    expect(event.projectRoot).toBe(ROOT);
    expect(event.event).toBe('turn-start');
  });

  it('reads the write tool and its target out of toolCall', async () => {
    const event = normalizeHostHook('antigravity', 'PostToolUse', await through({
      conversationId: 'c1', workspacePaths: [ROOT],
      toolCall: { name: 'replace_file_content', args: { TargetFile: path.join(ROOT, 'src/a.ts') } },
    }));
    expect(event.toolName).toBe('replace_file_content');
    expect(event.payload.changedPaths).toEqual(['src/a.ts']);
  });

  it('reads a shell run as a command, not as a nameless checkpoint', async () => {
    const event = normalizeHostHook('antigravity', 'PostToolUse', await through({
      conversationId: 'c1', workspacePaths: [ROOT],
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    }));
    expect(event.payload.command).toBe('npm test');
  });

  it('recognises the tools a real install emits, and no invented ones', () => {
    const profile = hostProfile('antigravity');
    expect([...profile.writeTools!]).toEqual(['replace_file_content', 'multi_replace_file_content', 'write_to_file']);
    for (const tool of profile.writeTools!) {
      expect(toolWritesFile({ host: 'antigravity', toolName: tool }), tool).toBe(true);
    }
    expect(toolWritesFile({ host: 'antigravity', toolName: 'edit_file' })).toBe(false);
    expect(profile.readsFiles!('PostToolUse', 'view_file')).toBe(true);
    expect(profile.isShellEvent('PostToolUse', 'run_command')).toBe(true);
  });
});

describe('the Antigravity hooks file', () => {
  it('wraps only the tool events, and leaves the invocation events flat', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'knowl-ag-')), 'hooks.json');
    expect(await mergeHookConfig(file, 'linux', 'antigravity')).toBe('configured');
    const config = JSON.parse(await readFile(file, 'utf8'));

    // Grouped: a matcher and a `hooks` wrapper, matching exactly the write tools.
    expect(config.knowl.PreToolUse[0].matcher).toBe('^(replace_file_content|multi_replace_file_content|write_to_file)$');
    expect(config.knowl.PostToolUse[0].hooks[0].command).toBe('knowl agent-hook antigravity PostToolUse --json');

    // Flat: the handler itself, no matcher, no wrapper -- the shape Antigravity's reference
    // gives these three. Wrapped, they parse and never fire.
    for (const event of ['PreInvocation', 'PostInvocation', 'Stop']) {
      expect(config.knowl[event], event).toEqual([
        { type: 'command', command: `knowl agent-hook antigravity ${event} --json`, timeout: 30 },
      ]);
    }
    // Not in Antigravity's handler schema; an undefined key can take the whole file down.
    expect(JSON.stringify(config)).not.toContain('statusMessage');
    expect(await verifyHookConfig(file, 'linux', 'antigravity')).toBe(true);
  });
});
