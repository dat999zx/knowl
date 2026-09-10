import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The card is owed again after the host compacts.
 *
 * Deliberately once per session (see `hosts/hermes.ts:9-16`) -- but compaction is the one event
 * that erases the card from the model's context WITHOUT ending the session, so once-per-session
 * and once-per-context stop being the same thing exactly there. Measured before this fix: a
 * hermes session got 419 chars on its first turn, then nothing on every turn after
 * `on_pre_compress`, for the life of the session.
 *
 * Driven through the built CLI rather than the engine, because the defect was never in the
 * composer -- it was in which events reach it with `includeContext` true.
 */

const TEST_DIR = path.join(os.tmpdir(), 'knowl-recompact-card-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: TEST_DIR, encoding: 'utf8', input });
}

/**
 * The context a host would actually receive, or '' for silence.
 *
 * Hermes reads a bare `context` key; the Claude-shaped hosts read
 * `hookSpecificOutput.additionalContext`. Both are checked so this helper is not silently
 * reading the wrong field and calling an empty string a pass.
 */
function card(args: string[], payload: Record<string, unknown>): string {
  const raw = run(args, JSON.stringify(payload)).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.context ?? parsed?.hookSpecificOutput?.additionalContext ?? '');
  } catch {
    return raw;
  }
}

describe('the bootstrap card after a compaction', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
    run(['store', '--category', 'fact', '--title', 'The deploy window is Tuesday',
      'Releases go out Tuesday 09:00 UTC, agreed with the platform team.']);
  }, 180_000);

  afterAll(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {}); });

  it('is re-delivered on the first turn after the host compacts, then not again', () => {
    const session = { session_id: 'compact-1', cwd: TEST_DIR };

    // Turn 1: the card, as always.
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'hello' }))
      .toContain('deploy window');

    // Turn 2: silence, which is the deliberate once-per-session behaviour.
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'still here' }))
      .toBe('');

    // The host compacts. A PRE-compaction hook cannot carry the card itself -- whatever it
    // returned would be composed into the very context about to be discarded.
    card(['agent-hook', 'hermes', 'on_pre_compress', '--json'], session);

    // The next turn is owed it again.
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'where do we deploy' }))
      .toContain('deploy window');

    // And exactly once: the flag is spent, not sticky.
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'and after that' }))
      .toBe('');
  }, 180_000);

  it('a session that never compacts is unchanged', () => {
    const session = { session_id: 'compact-2', cwd: TEST_DIR };
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'hello' }))
      .toContain('deploy window');
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'again' }))
      .toBe('');
    expect(card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'and again' }))
      .toBe('');
  }, 180_000);

  it('one compaction pays one card, however many turns follow', () => {
    const session = { session_id: 'compact-3', cwd: TEST_DIR };
    card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt: 'hello' });
    card(['agent-hook', 'hermes', 'on_pre_compress', '--json'], session);

    const delivered = ['a', 'b', 'c']
      .map(prompt => card(['agent-hook', 'hermes', 'pre_llm_call', '--json'], { ...session, prompt }))
      .filter(text => text.includes('deploy window'));
    expect(delivered.length).toBe(1);
  }, 180_000);
});
