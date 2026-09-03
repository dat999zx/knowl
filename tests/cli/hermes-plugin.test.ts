import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';

/**
 * Hermes' shell-hook stdin, as `_serialize_payload` in `agent/shell_hooks.py` (v0.21.0) builds
 * it, checked against the normaliser that has to accept it. The failure this guards is total
 * silence: a payload the normaliser rejects throws `IncompleteHostHookPayloadError`, which
 * `runAgentHook` swallows, so the integration reports nothing and looks unconfigured.
 */
const ROOT = path.resolve('.knowl-hermes-hook-test');

const hermesPayload = (event: string, extra: Record<string, unknown> = {}, tool?: { name: string; args: Record<string, unknown> }) => ({
  hook_event_name: event,
  tool_name: tool?.name ?? null,
  tool_input: tool?.args ?? null,
  session_id: 'sess-1',
  cwd: ROOT,
  extra,
});

describe('Hermes shell-hook payloads', () => {
  it('are accepted for every event knowl init registers', () => {
    const cases: Array<[string, string]> = [
      ['on_session_start', 'session-start'],
      ['pre_llm_call', 'turn-start'],
      ['pre_tool_call', 'tool-precheck'],
      ['post_tool_call', 'session-event'],
      ['pre_verify', 'turn-stop'],
      ['on_session_end', 'turn-stop'],
      ['on_session_finalize', 'session-stop'],
    ];
    for (const [hostEvent, normalized] of cases) {
      const tool = hostEvent.endsWith('tool_call') ? { name: 'write_file', args: { path: path.join(ROOT, 'src/a.py') } } : undefined;
      const result = normalizeHostHook('hermes', hostEvent, hermesPayload(hostEvent, { model: 'm', platform: 'cli' }, tool));
      expect(result.event, hostEvent).toBe(normalized);
      expect(result.externalSessionId, hostEvent).toBe('sess-1');
      expect(result.projectRoot, hostEvent).toBe(ROOT);
    }
  });

  it('carries the edited path through from tool_input.path, and names the tool', () => {
    const result = normalizeHostHook('hermes', 'pre_tool_call', hermesPayload('pre_tool_call', {}, { name: 'write_file', args: { path: path.join(ROOT, 'src/a.py') } }));
    expect(result.toolName).toBe('write_file');
    expect(result.payload.changedPaths).toEqual(['src/a.py']);
  });

  it('tolerates the null tool fields Hermes sends on non-tool events', () => {
    const result = normalizeHostHook('hermes', 'pre_llm_call', hermesPayload('pre_llm_call', { user_message: 'hi', is_first_turn: true }));
    expect(result.toolName).toBeUndefined();
  });
});
