import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { readLifecyclePayload } from '../../src/cli/agents/lifecycle.js';

const ROOT = path.resolve('.knowl-host-hook-fleet-test');

const read = (payload: unknown) => readLifecyclePayload(Readable.from([JSON.stringify(payload)]) as any);

describe('fleet fields through the stdin filter', () => {
  it('keeps the prompt and the final assistant message, head-bounded', async () => {
    const payload = await read({ session_id: 's', cwd: ROOT, prompt: 'fix the flake', last_assistant_message: 'Done. ' + 'x'.repeat(5_000) });
    expect(payload.prompt).toBe('fix the flake');
    expect(String(payload.last_assistant_message)).toHaveLength(2_000);
    expect(String(payload.last_assistant_message).startsWith('Done. ')).toBe(true);
  });

  it('keeps the TAIL of command output and of an error, so the failure line survives a long run', async () => {
    const banner = 'passed line\n'.repeat(400);
    const payload = await read({
      session_id: 's', cwd: ROOT, tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, stdout: banner + 'FAIL tests/x.test.ts\n  → SQLITE_BUSY: database is locked', stderr: banner + 'npm ERR! code 1' },
      error: banner + 'Error: the thing at the end',
    });
    const response = payload.tool_response as Record<string, string>;
    expect(response.stdout.endsWith('→ SQLITE_BUSY: database is locked')).toBe(true);
    expect(response.stdout.length).toBeLessThanOrEqual(2_000);
    expect(response.stderr.endsWith('npm ERR! code 1')).toBe(true);
    expect(String(payload.error).endsWith('Error: the thing at the end')).toBe(true);
    expect(response.exit_code).toBe(1);
  });

  it('still drops fields nobody allowlisted', async () => {
    const payload = await read({ session_id: 's', cwd: ROOT, transcript_path: '/x', permission_mode: 'bypass', tool_response: { interrupted: false } });
    expect(payload).not.toHaveProperty('transcript_path');
    expect(payload).not.toHaveProperty('permission_mode');
    expect(payload.tool_response).toEqual({});
  });
});

describe('fleet fields on the normalized event', () => {
  it('attaches the failed command output beside the payload, never inside it', () => {
    const event = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-1', cwd: ROOT, tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      tool_response: { exit_code: 1, stdout: 'banner\n→ SQLITE_BUSY: database is locked', stderr: '' },
    });
    expect(event.errorText).toBe('banner\n→ SQLITE_BUSY: database is locked');
    expect(event.status).toBeUndefined();
    expect(event.payload).toEqual({ command: 'npx vitest run', exitCode: 1 });
    expect(JSON.stringify(event.payload)).not.toContain('SQLITE_BUSY');
  });

  it('attaches nothing for a command that succeeded', () => {
    const event = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-1', cwd: ROOT, tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { exit_code: 0, stdout: 'secret-looking output' },
    });
    expect(event.errorText).toBeUndefined();
  });

  it('carries the error text of a failed tool', () => {
    const event = normalizeHostHook('claude', 'PostToolUseFailure', {
      session_id: 'session-1', cwd: ROOT, tool_name: 'Edit', error: 'File has been modified since read',
    });
    expect(event.status).toBe('failed');
    expect(event.errorText).toBe('File has been modified since read');
    expect(event.payload).toEqual({ message: 'File has been modified since read' });
  });

  it('carries the final assistant message on a clean Stop only', () => {
    const clean = normalizeHostHook('claude', 'Stop', { session_id: 'session-1', cwd: ROOT, last_assistant_message: 'Fixed the retry.' });
    expect(clean.assistantMessage).toBe('Fixed the retry.');
    expect(clean.payload).toEqual({ status: 'finished' });
    const failed = normalizeHostHook('claude', 'StopFailure', { session_id: 'session-1', cwd: ROOT, error: 'rate_limit', last_assistant_message: 'half' });
    expect(failed.assistantMessage).toBeUndefined();
    const end = normalizeHostHook('claude', 'SessionEnd', { session_id: 'session-1', cwd: ROOT, last_assistant_message: 'bye' });
    expect(end.assistantMessage).toBeUndefined();
  });
});
