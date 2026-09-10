import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { readLifecyclePayloadObject } from '../../src/cli/agents/lifecycle.js';
import { commandExistsOnPath } from '../../src/cli/agents/command-exists.js';

/**
 * The payload the plugin sends -- the shape `_payload` in `integrations/hermes/knowl/__init__.py`
 * builds, which mirrors `_serialize_payload` in Hermes' `agent/shell_hooks.py` -- checked against
 * the normaliser that has to accept it. Two failures are guarded here.
 *
 * Total silence: a payload the normaliser rejects throws `IncompleteHostHookPayloadError`, which
 * `runAgentHook` swallows, so the integration reports nothing and looks unconfigured.
 *
 * Silent loss: every payload goes through the stdin allowlist (`readLifecyclePayloadObject`)
 * before the normaliser sees it, and that allowlist drops `extra` whole. A field the plugin nests
 * there and the engine reads at the root is sent, dropped, and read as absent -- which is how a
 * failed write_file was captured as a success and the correction classifier never fired on this
 * host. So `normalize` below runs the allowlist first; a test that hands the normaliser the raw
 * object passes for a field production never delivers.
 */
const ROOT = path.resolve('.knowl-hermes-hook-test');

const hermesPayload = (event: string, root: Record<string, unknown> = {}, tool?: { name: string; args: Record<string, unknown> }) => ({
  hook_event_name: event,
  tool_name: tool?.name ?? null,
  tool_input: tool?.args ?? null,
  session_id: 'sess-1',
  cwd: ROOT,
  ...root,
  extra: { model: 'm', platform: 'cli', is_first_turn: true, turn_id: 't1' },
});

const normalize = (event: string, payload: Record<string, unknown>) =>
  normalizeHostHook('hermes', event, readLifecyclePayloadObject(payload));

describe('Hermes plugin payloads, through the stdin allowlist', () => {
  it('are accepted for every event the plugin sends', () => {
    const cases: Array<[string, string]> = [
      ['pre_llm_call', 'turn-start'],
      ['pre_tool_call', 'tool-precheck'],
      ['post_tool_call', 'session-event'],
      ['pre_verify', 'turn-stop'],
      ['on_session_end', 'turn-stop'],
      ['on_session_finalize', 'session-stop'],
    ];
    for (const [hostEvent, normalized] of cases) {
      const tool = hostEvent.endsWith('tool_call') ? { name: 'write_file', args: { path: path.join(ROOT, 'src/a.py') } } : undefined;
      const result = normalize(hostEvent, hermesPayload(hostEvent, {}, tool));
      expect(result.event, hostEvent).toBe(normalized);
      expect(result.externalSessionId, hostEvent).toBe('sess-1');
      expect(result.projectRoot, hostEvent).toBe(ROOT);
    }
  });

  it('carries the edited path through from tool_input.path, and names the tool', () => {
    const result = normalize('pre_tool_call', hermesPayload('pre_tool_call', {}, { name: 'write_file', args: { path: path.join(ROOT, 'src/a.py') } }));
    expect(result.toolName).toBe('write_file');
    expect(result.payload.changedPaths).toEqual(['src/a.py']);
  });

  it('tolerates the null tool fields Hermes sends on non-tool events', () => {
    const result = normalize('pre_llm_call', hermesPayload('pre_llm_call', { prompt: 'hi' }));
    expect(result.toolName).toBeUndefined();
    expect(result.payload.correctionSignal).toBeUndefined();
  });

  it('classifies a correction from the root prompt, and keeps the text out of the payload', () => {
    const result = normalize('pre_llm_call', hermesPayload('pre_llm_call', { prompt: 'no, i already told you not to do that' }));
    expect(result.payload).toEqual({ correctionSignal: true });
    expect(JSON.stringify(result)).not.toContain('told you');
  });

  it('records a failed tool call as an error event, not a checkpoint crediting the write', () => {
    const tool = { name: 'write_file', args: { path: path.join(ROOT, 'src/a.py') } };
    const failed = normalize('post_tool_call', hermesPayload('post_tool_call', { status: 'failed', error: 'EACCES' }, tool));
    expect(failed).toMatchObject({ type: 'error', status: 'failed', payload: { message: 'EACCES' }, errorText: 'EACCES' });
    expect(failed.payload.changedPaths).toBeUndefined();

    const ok = normalize('post_tool_call', hermesPayload('post_tool_call', { status: 'finished' }, tool));
    expect(ok).toMatchObject({ type: 'checkpoint', payload: { changedPaths: ['src/a.py'] } });
    expect(ok.status).toBeUndefined();
  });

  it('records a failed terminal call as a failed command, keeping its fingerprint', () => {
    const tool = { name: 'terminal', args: { command: 'npm test' } };
    const result = normalize('post_tool_call', hermesPayload('post_tool_call', { status: 'failed', error: '3 tests failed' }, tool));
    expect(result).toMatchObject({ type: 'command', status: 'failed', payload: { command: 'npm test' }, errorText: '3 tests failed' });
  });

  it('closes an interrupted turn as failed and a finished one with its last message', () => {
    const interrupted = normalize('on_session_end', hermesPayload('on_session_end', { status: 'failed' }));
    expect(interrupted).toMatchObject({ event: 'turn-stop', status: 'failed' });
    expect(interrupted.assistantMessage).toBeUndefined();

    const finished = normalize('pre_verify', hermesPayload('pre_verify', { last_assistant_message: 'Renamed the helper.' }));
    expect(finished).toMatchObject({ event: 'turn-stop', status: 'finished', assistantMessage: 'Renamed the helper.' });
  });
});

describe('Hermes plugin (python)', () => {
  it('passes its unittest when python is available', async () => {
    const python = (await commandExistsOnPath('python')) ? 'python'
      : (await commandExistsOnPath('python3')) ? 'python3'
        : null;
    // The plugin is Python that ships in the npm package; where no interpreter exists there is
    // nothing to run it with, and the Linux CI leg has one.
    if (!python) return;
    const { stderr } = await promisify(execFile)(python, ['-m', 'unittest', 'tests/integrations/hermes/test_plugin.py'], { cwd: path.resolve('.') });
    expect(stderr).toContain('OK');
  }, 60_000);
});
