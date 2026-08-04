import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasAiConfigured } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * K-67: an ambient environment variable must not switch a repository onto a billable path.
 *
 * `hasAiConfigured` is the gate on the AI pipeline, and the pipeline runs on writes:
 * `recordDecisionDirect` calls `runDeriveTruth` behind it, so whether it answers yes decides
 * whether `knowl decide` records a decision deterministically or makes provider calls.
 *
 * It answered yes for `provider: 'anthropic'` with no key in the config at all, as long as
 * `ANTHROPIC_API_KEY` happened to be exported -- which on a machine running Claude Code is
 * a variable set for something else entirely. Nothing in the repository said the AI path was
 * on, and nothing said when it turned on.
 *
 * So configuration has to be in the configuration. `${ANTHROPIC_API_KEY}` is the supported
 * way to say "use the environment" without putting the key in the file, and it is now safe
 * to write there -- K-10 stopped the round trip that used to resolve it in place.
 */

const config = (ai: Record<string, unknown>): ProjectConfig => ({ version: 1, ai } as any);

describe('what turns the AI pipeline on', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-key-for-something-else';
    process.env.OPENAI_API_KEY = 'sk-openai-ambient-key-for-something-else';
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
  });

  it('is not turned on by an environment variable the repository never mentions', () => {
    expect(hasAiConfigured(config({ provider: 'anthropic', model: 'claude-sonnet-4' }))).toBe(false);
    expect(hasAiConfigured(config({ provider: 'openai', model: 'gpt-4-turbo' }))).toBe(false);
  });

  it('is turned on by a key in the config', () => {
    expect(hasAiConfigured(config({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'sk-ant-chosen' }))).toBe(true);
  });

  it('is turned on by an explicit ${ENV_VAR} reference, which is how you opt in', () => {
    // loadConfig resolves the reference before anything sees it, so by the time the gate is
    // asked the value is the key. What matters is that the repository asked for it.
    expect(hasAiConfigured(config({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: process.env.ANTHROPIC_API_KEY,
    }))).toBe(true);
  });

  it('leaves ollama alone, which needs no key', () => {
    expect(hasAiConfigured(config({ provider: 'ollama', model: 'llama3' }))).toBe(true);
  });

  it('stays off with no ai block at all', () => {
    expect(hasAiConfigured({ version: 1 } as ProjectConfig)).toBe(false);
    expect(hasAiConfigured(undefined)).toBe(false);
  });
});
