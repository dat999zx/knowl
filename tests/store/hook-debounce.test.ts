import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOOK_CAPTURE_DEBOUNCE_MS,
  captureFingerprint,
  claimCapture,
  releaseCapture,
  shouldSkipDuplicateCapture,
} from '../../src/store/hook-debounce.js';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';

const ROOT = path.resolve('.knowl-hook-debounce-test');

const hook = (input: Partial<NormalizedHostHook> = {}): NormalizedHostHook => ({
  host: 'codex',
  event: 'session-event',
  externalSessionId: 'session',
  externalTurnId: 'turn',
  projectRoot: ROOT,
  type: 'command',
  payload: { command: 'npm test', exitCode: 0 },
  ...input,
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('distinguishing distinct tool calls', () => {
  // Non-shell tool events all collapse to `summary: "<Tool> completed"`, so two different
  // Grep calls used to fingerprint identically and the second inside the 1.5s window was
  // dropped silently -- no change card, no drift counting. Agents call tools far faster
  // than that, so this lost real KNOWL CHANGED notifications in ordinary use.
  const toolCall = (captureKey: string) => hook({
    type: 'checkpoint',
    payload: { summary: 'Grep completed' },
    captureKey,
  });

  it('fingerprints two different calls to the same tool differently', () => {
    expect(captureFingerprint(toolCall('Grep:{"pattern":"x"}')))
      .not.toBe(captureFingerprint(toolCall('Grep:{"pattern":"y"}')));
  });

  it('claims both when two distinct calls arrive inside the debounce window', () => {
    const now = Date.now();
    expect(claimCapture(toolCall('Grep:{"pattern":"x"}'), now)).toBe(true);
    expect(claimCapture(toolCall('Grep:{"pattern":"y"}'), now + 10)).toBe(true);
  });

  it('still collapses a genuine duplicate of the same call', () => {
    const now = Date.now();
    expect(claimCapture(toolCall('Grep:{"pattern":"x"}'), now)).toBe(true);
    expect(claimCapture(toolCall('Grep:{"pattern":"x"}'), now + 10)).toBe(false);
  });
});

describe('hook debounce claims', () => {
  it('fingerprints ignore changedPath order and keep failures ineligible', () => {
    const left = captureFingerprint(hook({
      event: 'checkpoint',
      type: 'checkpoint',
      payload: { summary: 'state', changedPaths: ['b.ts', 'a.ts'] },
    }));
    const right = captureFingerprint(hook({
      event: 'checkpoint',
      type: 'checkpoint',
      payload: { summary: 'state', changedPaths: ['a.ts', 'b.ts'] },
    }));
    expect(left).toBe(right);

    expect(claimCapture(hook({ type: 'error', status: 'failed', payload: { message: 'boom' } }))).toBe(true);
    expect(claimCapture(hook({ type: 'error', status: 'failed', payload: { message: 'boom' } }))).toBe(true);
  });

  it('claims once within the window and reclaims after expiry', () => {
    const now = 1_000_000;
    const input = hook({ payload: { command: 'npm test', exitCode: 0 } });

    expect(claimCapture(input, now)).toBe(true);
    expect(claimCapture(input, now + 10)).toBe(false);
    expect(shouldSkipDuplicateCapture(input, now + 10)).toBe(true);

    expect(claimCapture(input, now + HOOK_CAPTURE_DEBOUNCE_MS + 1)).toBe(true);
    expect(shouldSkipDuplicateCapture(input, now + HOOK_CAPTURE_DEBOUNCE_MS + 1)).toBe(true);
  });

  it('releases a claim so a retry can capture again', () => {
    const input = hook({ payload: { command: 'npm run retry', exitCode: 0 } });
    expect(claimCapture(input, 50)).toBe(true);
    releaseCapture(input);
    expect(claimCapture(input, 60)).toBe(true);
  });

  it('only allows one concurrent claim winner', async () => {
    const input = hook({
      externalSessionId: 'race-session',
      externalTurnId: 'race-turn',
      payload: { command: 'npm run race', exitCode: 0 },
    });
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve(claimCapture(input, now))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(value => !value)).toHaveLength(19);
  });
});
