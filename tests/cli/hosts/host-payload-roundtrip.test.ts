import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook, type HookHost } from '../../../src/cli/agents/host-hook.js';
import { readLifecyclePayload } from '../../../src/cli/agents/lifecycle.js';
import { toolWritesFile } from '../../../src/session/hosts/index.js';

/**
 * One payload per host, in that host's own vocabulary, driven through the real stdin path.
 *
 * The bug this generalises took Antigravity's integration to zero and nobody noticed for a
 * release: its payload names every field differently, the stdin allowlist dropped all three of
 * them, and every event then threw `IncompleteHostHookPayloadError` -- which the hook entry
 * swallows in silence, so the host reported nothing, logged nothing, and looked exactly like
 * one nobody had configured. Every unit test it had passed, because they all handed the
 * normalizer an object directly and skipped the filter that was eating the payload.
 *
 * So: through `readLifecyclePayload` for every host, never around it. What this pins is the
 * contract Knowl *claims* for each host end to end -- allowlist, normalizer, event map and tool
 * vocabulary agreeing with each other. It cannot prove a vendor sends this shape; only reading
 * a real install does that, and `docs/hosts.md` records which hosts have had one read.
 */
const ROOT = path.resolve('.knowl-host-roundtrip-test');
const FILE = path.join(ROOT, 'src/a.ts');

const through = async (raw: unknown) => readLifecyclePayload(Readable.from([JSON.stringify(raw)]) as never);

type Row = {
  host: HookHost;
  /** A write, in this host's own event and tool names. */
  write: { event: string; raw: Record<string, unknown> };
  /** A shell command, likewise. Absent for a host with no shell channel of its own. */
  shell?: { event: string; raw: Record<string, unknown> };
};

const ROWS: Row[] = [
  {
    host: 'claude',
    write: { event: 'PostToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'Edit', tool_input: { file_path: FILE } } },
    shell: { event: 'PostToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'npm test' } } },
  },
  {
    host: 'codex',
    write: { event: 'PostToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'apply_patch', tool_input: { file_path: FILE } } },
    // `shell_command` and not `shell`: it is the name codex 0.149.1 actually calls, by an order
    // of magnitude, and the shared bash/shell helper did not know it.
    shell: { event: 'PostToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'shell_command', tool_input: { command: 'npm test' } } },
  },
  {
    host: 'copilot',
    write: { event: 'postToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'str_replace', tool_input: { file_path: FILE } } },
    shell: { event: 'postToolUse', raw: { session_id: 's', cwd: ROOT, tool_name: 'bash', tool_input: { command: 'npm test' } } },
  },
  {
    host: 'openhands',
    write: { event: 'post_tool_use', raw: { conversation_id: 's', cwd: ROOT, tool_name: 'str_replace_editor', tool_input: { path: FILE } } },
    shell: { event: 'post_tool_use', raw: { conversation_id: 's', cwd: ROOT, tool_name: 'terminal', tool_input: { command: 'npm test' } } },
  },
  {
    // Cursor names the ACTION and sends no tool name at all, on both halves.
    host: 'cursor',
    write: { event: 'afterFileEdit', raw: { conversation_id: 's', cwd: ROOT, file_path: FILE } },
    shell: { event: 'afterShellExecution', raw: { conversation_id: 's', cwd: ROOT, command: 'npm test' } },
  },
  {
    host: 'windsurf',
    write: { event: 'post_write_code', raw: { conversation_id: 's', cwd: ROOT, file_path: FILE } },
    shell: { event: 'post_run_command', raw: { conversation_id: 's', cwd: ROOT, command: 'npm test' } },
  },
  {
    // Through the shipped plugin, which sends normalized event names directly.
    host: 'cline',
    write: { event: 'session-event', raw: { conversation_id: 's', cwd: ROOT, tool_name: 'write_to_file', tool_input: { path: FILE } } },
    shell: { event: 'session-event', raw: { conversation_id: 's', cwd: ROOT, tool_name: 'execute_command', tool_input: { command: 'npm test' } } },
  },
  {
    host: 'hermes',
    write: { event: 'post_tool_call', raw: { session_id: 's', cwd: ROOT, tool_name: 'write_file', tool_input: { path: FILE } } },
    shell: { event: 'post_tool_call', raw: { session_id: 's', cwd: ROOT, tool_name: 'terminal', tool_input: { command: 'npm test' } } },
  },
  {
    // protojson: camelCase throughout, one `toolCall` object, PascalCase arguments, and the
    // root under `workspacePaths` rather than `cwd`.
    host: 'antigravity',
    write: {
      event: 'PostToolUse',
      raw: { conversationId: 's', workspacePaths: [ROOT], toolCall: { name: 'replace_file_content', args: { TargetFile: FILE } } },
    },
    shell: {
      event: 'PostToolUse',
      raw: { conversationId: 's', workspacePaths: [ROOT], toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } },
    },
  },
  {
    // The third-party contract: normalized event names, an explicit `type`, and paths reported
    // outright rather than inferred from a tool's arguments.
    host: 'generic',
    write: { event: 'session-event', raw: { sessionId: 's', cwd: ROOT, type: 'checkpoint', toolName: 'Write', changedPaths: [FILE] } },
    shell: { event: 'session-event', raw: { sessionId: 's', cwd: ROOT, type: 'command', toolName: 'Bash', command: 'npm test' } },
  },
];

describe.each(ROWS)('$host, through the stdin filter it actually runs behind', row => {
  it('resolves the session and the project root', async () => {
    const event = normalizeHostHook(row.host, row.write.event, await through(row.write.raw));
    expect(event.externalSessionId).toBe('s');
    expect(event.projectRoot).toBe(ROOT);
  });

  it('recognises its own write, and the file it wrote', async () => {
    const event = normalizeHostHook(row.host, row.write.event, await through(row.write.raw));
    // Both halves matter and they fail separately: an unrecognised tool leaves the write gate
    // and the fleet's claim with nothing to act on, and a lost path leaves the change card and
    // the read-set with nothing to name.
    expect(toolWritesFile(event), `${row.host} does not recognise its own write tool`).toBe(true);
    expect(event.payload.changedPaths, `${row.host} lost the path it wrote`).toEqual(['src/a.ts']);
  });

  it('carries a shell command as a command, not as a nameless checkpoint', async () => {
    if (!row.shell) return;
    const event = normalizeHostHook(row.host, row.shell.event, await through(row.shell.raw));
    expect(event.payload.command, `${row.host} dropped the command text`).toBe('npm test');
  });
});
