import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => vi.fn((model: string) => ({ sdk: 'openai', model }))) }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn(() => vi.fn((model: string) => ({ sdk: 'anthropic', model }))) }));

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { initAI } from '../../src/ai/provider.js';
import { AI_PROVIDERS, AI_PROVIDER_IDS, aiProvider } from '../../src/core/ai-providers/index.js';
import { openaiProvider } from '../../src/core/ai-providers/openai.js';
import { anthropicProvider } from '../../src/core/ai-providers/anthropic.js';
import { ollamaProvider } from '../../src/core/ai-providers/ollama.js';
import { customProvider } from '../../src/core/ai-providers/custom.js';
import { hasAiConfigured } from '../../src/core/config.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

describe('AI provider registry', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('openai passes apiKey and baseUrl to createOpenAI', () => {
    const model = initAI({ provider: 'openai', model: 'o1', apiKey: 'k', baseUrl: 'https://x/v1' });
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'https://x/v1' });
    expect(model).toEqual({ sdk: 'openai', model: 'o1' });
  });

  it('openai falls back to OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'envk';
    initAI({ provider: 'openai', model: 'o2' });
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'envk', baseURL: undefined });
  });

  it('anthropic uses createAnthropic with the same two shapes', () => {
    const model = initAI({ provider: 'anthropic', model: 'a1', apiKey: 'k', baseUrl: 'https://x/v1' });
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'https://x/v1' });
    expect(model).toEqual({ sdk: 'anthropic', model: 'a1' });

    process.env.ANTHROPIC_API_KEY = 'envk';
    initAI({ provider: 'anthropic', model: 'a2' });
    expect(createAnthropic).toHaveBeenLastCalledWith({ apiKey: 'envk', baseURL: undefined });
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it('ollama ignores the key and defaults the local endpoint', () => {
    initAI({ provider: 'ollama', model: 'l1', apiKey: 'ignored' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' });
    initAI({ provider: 'ollama', model: 'l2', apiKey: 'ignored', baseUrl: 'http://h:1/v1' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: 'ollama', baseURL: 'http://h:1/v1' });
  });

  it('custom passes through, with an empty key and no base when absent', () => {
    initAI({ provider: 'custom', model: 'c1', apiKey: 'k', baseUrl: 'https://c/v1' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: 'k', baseURL: 'https://c/v1' });
    initAI({ provider: 'custom', model: 'c2' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: '', baseURL: undefined });
  });

  it('an unknown provider fails with the registered list', () => {
    expect(() => initAI({ provider: 'nope', model: 'm1' } as any)).toThrow(
      'Failed to initialize AI provider: Unknown AI provider "nope". Registered providers: openai, anthropic, ollama, custom.',
    );
  });

  it('prototype keys are not providers', () => {
    expect(() => aiProvider('__proto__')).toThrow(/Unknown AI provider/);
    expect(() => aiProvider('constructor')).toThrow(/Unknown AI provider/);
  });

  it('keeps declaration order of the ids', () => {
    expect(AI_PROVIDER_IDS).toEqual(['openai', 'anthropic', 'ollama', 'custom']);
  });

  it('every descriptor file is registered, under its own id', () => {
    const stems = fs
      .readdirSync(new URL('../../src/core/ai-providers/', import.meta.url))
      .filter(f => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
      .map(f => f.slice(0, -3))
      .sort();
    expect(stems).toEqual(Object.keys(AI_PROVIDERS).sort());
    for (const [k, v] of Object.entries(AI_PROVIDERS)) expect(v.id).toBe(k);
    expect(AI_PROVIDERS.openai).toBe(openaiProvider);
    expect(AI_PROVIDERS.anthropic).toBe(anthropicProvider);
    expect(AI_PROVIDERS.ollama).toBe(ollamaProvider);
    expect(AI_PROVIDERS.custom).toBe(customProvider);
  });

  // Regression pin: behaviour that already holds on main.
  it('hasAiConfigured: ollama is keyless, openai needs a key', () => {
    expect(hasAiConfigured({ version: 1, ai: { provider: 'ollama', model: 'm' } } as any)).toBe(true);
    expect(hasAiConfigured({ version: 1, ai: { provider: 'openai', model: 'm' } } as any)).toBe(false);
  });
});
