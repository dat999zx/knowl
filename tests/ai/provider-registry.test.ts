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
import { copilotProvider } from '../../src/core/ai-providers/copilot.js';
import { hasAiConfigured } from '../../src/core/config.js';
import { KnowledgeAtomSchema, FilterResultSchema, CompareResultSchema } from '../../src/ai/schemas.js';

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

  it('custom passes through, with an empty key and no base when absent, and routes claude* models to anthropic SDK', () => {
    initAI({ provider: 'custom', model: 'c1', apiKey: 'ck', baseUrl: 'https://c/v1' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: 'ck', baseURL: 'https://c/v1' });
    initAI({ provider: 'custom', model: 'c2' });
    expect(createOpenAI).toHaveBeenLastCalledWith({ apiKey: '', baseURL: undefined });
    const claudeModel = initAI({ provider: 'custom', model: 'claude-haiku-5.5', baseUrl: 'http://127.0.0.1:8794/v1' });
    expect(createAnthropic).toHaveBeenLastCalledWith({ apiKey: '', baseURL: 'http://127.0.0.1:8794/v1' });
    expect(claudeModel).toEqual({ sdk: 'anthropic', model: 'claude-haiku-5.5' });
  });

  it('copilot supports multi-model routing (openai SDK for gpt* and anthropic SDK for claude*)', () => {
    const gptModel = initAI({ provider: 'copilot', model: 'gpt-6-luna' });
    expect(createOpenAI).toHaveBeenLastCalledWith({
      apiKey: 'copilot-local-proxy',
      baseURL: 'http://127.0.0.1:8794/v1',
    });
    expect(gptModel).toEqual({ sdk: 'openai', model: 'gpt-6-luna' });

    const claudeModel = initAI({ provider: 'copilot', model: 'claude-haiku-5.5', baseUrl: 'http://127.0.0.1:8794/p/knowl/v1' });
    expect(createAnthropic).toHaveBeenLastCalledWith({
      apiKey: 'copilot-local-proxy',
      baseURL: 'http://127.0.0.1:8794/p/knowl/v1',
    });
    expect(claudeModel).toEqual({ sdk: 'anthropic', model: 'claude-haiku-5.5' });
  });

  it('an unknown provider fails with the registered list', () => {
    expect(() => initAI({ provider: 'nope', model: 'm1' } as any)).toThrow(
      'Failed to initialize AI provider: Unknown AI provider "nope". Registered providers: openai, anthropic, ollama, custom, copilot.',
    );
  });

  it('prototype keys are not providers', () => {
    expect(() => aiProvider('__proto__')).toThrow(/Unknown AI provider/);
    expect(() => aiProvider('constructor')).toThrow(/Unknown AI provider/);
  });

  it('keeps declaration order of the ids', () => {
    expect(AI_PROVIDER_IDS).toEqual(['openai', 'anthropic', 'ollama', 'custom', 'copilot']);
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
    expect(AI_PROVIDERS.copilot).toBe(copilotProvider);
  });

  // Regression pin: behaviour that already holds on main.
  it('hasAiConfigured: ollama and copilot are keyless, openai needs a key', () => {
    expect(hasAiConfigured({ version: 1, ai: { provider: 'ollama', model: 'm' } } as any)).toBe(true);
    expect(hasAiConfigured({ version: 1, ai: { provider: 'copilot', model: 'gpt-6-luna' } } as any)).toBe(true);
    expect(hasAiConfigured({ version: 1, ai: { provider: 'openai', model: 'm' } } as any)).toBe(false);
  });

  it('KnowledgeAtomSchema, FilterResultSchema, and CompareResultSchema satisfy OpenAI Responses API strict mode (every property required and nullable)', () => {
    const parsedAtom = KnowledgeAtomSchema.parse({
      category: 'decision',
      title: 'Use WAL',
      content: 'Enable WAL mode',
      reasoning: null,
      alternatives: null,
      tags: null,
      confidence: 0.9,
      steps: null,
    });
    expect(parsedAtom.reasoning).toBeNull();
    expect(FilterResultSchema.parse({ pass: true, reason: null }).pass).toBe(true);
    expect(CompareResultSchema.parse({
      relationship: 'duplicate',
      reason: 'Same',
      updatedContent: null,
      updatedTitle: null,
      updatedReasoning: null,
      updatedAlternatives: null,
      updatedTags: null,
      updatedSteps: null,
    }).relationship).toBe('duplicate');
  });
});
