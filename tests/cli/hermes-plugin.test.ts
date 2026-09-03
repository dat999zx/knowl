import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { commandExistsOnPath } from '../../src/cli/agents/command-exists.js';

const ROOT = path.resolve('.knowl-hermes-plugin-test');

/** Mirrors `_base_payload` in `integrations/hermes/knowl/__init__.py`. */
const basePayload = { session_id: 'sess-1', cwd: ROOT };

describe('Hermes plugin payloads', () => {
  it('are accepted for every event the plugin sends', () => {
    for (const event of ['session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop'] as const) {
      const normalized = normalizeHostHook('hermes', event, {
        ...basePayload,
        ...(event === 'tool-precheck' || event === 'session-event'
          ? { tool_name: 'write_file', tool_input: { path: path.join(ROOT, 'src/a.py') } }
          : {}),
      });
      expect(normalized.event, event).toBe(event);
      expect(normalized.externalSessionId, event).toBe('sess-1');
    }
    const precheck = normalizeHostHook('hermes', 'tool-precheck', { ...basePayload, tool_name: 'write_file', tool_input: { path: path.join(ROOT, 'src/a.py') } });
    expect(precheck.toolName).toBe('write_file');
    expect(precheck.payload.changedPaths).toEqual(['src/a.py']);
  });
});

describe('Hermes plugin (python)', () => {
  it('passes its unittest when python is available', async () => {
    const python = (await commandExistsOnPath('python')) ? 'python' : (await commandExistsOnPath('python3')) ? 'python3' : null;
    if (!python) return; // No interpreter here; CI on the Linux leg has one.
    const { stderr } = await promisify(execFile)(python, ['-m', 'unittest', 'tests/integrations/hermes/test_plugin.py'], { cwd: path.resolve('.') });
    expect(stderr).toContain('OK');
  }, 30_000);
});
