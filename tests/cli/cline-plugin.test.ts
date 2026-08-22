import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { hostProfile } from '../../src/session/hosts/index.js';

/**
 * The Cline plugin's payload, checked against the normaliser that has to accept it.
 *
 * The plugin is a `.mjs` outside tsconfig with no runtime of its own here, so nothing else in
 * this suite touches it -- and its failure mode is total silence: a payload the normaliser
 * rejects throws `IncompleteHostHookPayloadError`, which `runAgentHook` swallows deliberately,
 * so the integration reports nothing, logs nothing and looks exactly like a host nobody
 * configured. These cases mirror what `basePayload` builds.
 */
const ROOT = path.resolve('.knowl-cline-plugin-test');

const basePayload = (session: string | undefined, fallback: string) => ({
  cwd: ROOT,
  conversation_id: session ?? fallback,
  session_id: session ?? fallback,
});

describe('Cline plugin payloads', () => {
  it('is accepted for every event the plugin sends', () => {
    for (const event of ['session-start', 'turn-start', 'session-event', 'turn-stop', 'session-stop'] as const) {
      const normalized = normalizeHostHook('cline', event, {
        ...basePayload('task-1', 'fallback'),
        ...(event === 'session-event' ? { tool_name: 'write_to_file', tool_input: { path: path.join(ROOT, 'src/a.ts') } } : {}),
      });
      expect(normalized.event, event).toBe(event);
      expect(normalized.externalSessionId, event).toBe('task-1');
    }
  });

  it('still works when Cline names its task id something unexpected', () => {
    // Without the plugin's fallback this throws, and `runAgentHook` swallows it in silence --
    // which is how the whole integration ships dark with nothing to diagnose from.
    const normalized = normalizeHostHook('cline', 'session-start', basePayload(undefined, 'cline-abc123'));
    expect(normalized.externalSessionId).toBe('cline-abc123');
  });

  it('recognises a Cline edit as a write, and a Cline read as a read', () => {
    const profile = hostProfile('cline');
    expect(profile.writesFiles?.('', 'write_to_file')).toBe(true);
    expect(profile.writesFiles?.('', 'replace_in_file')).toBe(true);
    expect(profile.readsFiles?.('', 'read_file')).toBe(true);
    expect(profile.readsFiles?.('', 'write_to_file')).toBe(false);
  });

  it('carries the edited path through, from the key the plugin sends it under', () => {
    const normalized = normalizeHostHook('cline', 'session-event', {
      ...basePayload('task-1', 'f'),
      tool_name: 'write_to_file',
      tool_input: { path: path.join(ROOT, 'src/a.ts') },
    });
    expect(normalized.toolName).toBe('write_to_file');
    expect(normalized.payload.changedPaths).toEqual(['src/a.ts']);
  });
});
