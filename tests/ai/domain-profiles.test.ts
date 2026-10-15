import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();
  return {
    ...original,
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
});

import { generateObject, generateText } from 'ai';
import { FILTER_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, DERIVE_TRUTH_PROMPT } from '../../src/ai/prompts.js';
import { FilterResultSchema } from '../../src/ai/schemas.js';
import { codeProfile } from '../../src/ai/profiles/code.js';
import { BUILT_IN_PROFILES, domainProfile } from '../../src/ai/profiles/index.js';
import { initAI, filterInput, extractKnowledge, askQuestion, deriveTruth } from '../../src/ai/provider.js';
import type { ProjectConfig, KnowledgeItem } from '../../src/core/types.js';

const CONFIG: ProjectConfig = {
  version: 1,
  ai: { provider: 'openai', model: 'gpt-profiles', apiKey: 'mock-key' },
  security: { rejectSecrets: false, secretPatterns: [] },
};

const ITEM = {
  category: 'fact',
  title: 'T',
  content: 'C',
} as unknown as KnowledgeItem;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('domain profiles (code only)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalHome = process.env.KNOWL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowl-profiles-'));
    process.env.KNOWL_HOME = home;
    initAI(CONFIG.ai!);
    vi.mocked(generateObject).mockResolvedValue({ object: { pass: true, atoms: [], truths: [] } } as any);
    vi.mocked(generateText).mockResolvedValue({ text: 'answer' } as any);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('pins the code prompts byte for byte', () => {
    // These are the strings shipped in 5.25.1; changing them changes behaviour for every existing project.
    expect(sha(codeProfile.filter)).toBe('1faa7410d6f1022848111e0004649d10ca3e27a90dc14f8f239535f82e3f200e');
    expect(sha(codeProfile.extract)).toBe('244d167b6bf67fa2568ad63c020fe20141375c28dc365524c7a46f014ec36da8');
    expect(sha(codeProfile.ask)).toBe('d25c993f082d12f6bcd625dcb8cb5f49fc49cc3ccb146e7c2dbe6b5a2617cc4c');
    expect(sha(codeProfile.deriveTruth as string)).toBe('8ff982c4db58cb333880b5ded1d59799e523d0f8eaf2b4a3784aff3743e6a686');
  });

  it('default path sends today\'s request', async () => {
    await filterInput('x', CONFIG);
    const filterCall = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(filterCall.system).toBe(FILTER_SYSTEM_PROMPT);
    expect(filterCall.schema).toBe(FilterResultSchema);

    await extractKnowledge('x');
    expect((vi.mocked(generateObject).mock.calls[1][0] as any).system).toBe(EXTRACT_SYSTEM_PROMPT);

    await askQuestion('q', 'c');
    expect((vi.mocked(generateText).mock.calls[0][0] as any).system).toBe(ASK_SYSTEM_PROMPT);

    await deriveTruth(ITEM);
    expect((vi.mocked(generateObject).mock.calls[2][0] as any).system).toBe(DERIVE_TRUTH_PROMPT);
  });

  it('an explicit profile replaces the prompts, schema and derive opt-out', async () => {
    const profile = { id: 't', filter: 'F', extract: 'E', ask: 'A', deriveTruth: null, passDescription: 'P' };

    await filterInput('x', CONFIG, profile);
    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.system).toBe('F');
    expect(call.schema).not.toBe(FilterResultSchema);

    await extractKnowledge('x', profile);
    expect((vi.mocked(generateObject).mock.calls[1][0] as any).system).toBe('E');

    await askQuestion('q', 'c', profile);
    expect((vi.mocked(generateText).mock.calls[0][0] as any).system).toBe('A');

    vi.mocked(generateObject).mockClear();
    await expect(deriveTruth(ITEM, profile)).resolves.toEqual([]);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('domainProfile resolves code and rejects unknown ids', () => {
    expect(domainProfile('code')).toBe(codeProfile);
    expect(() => domainProfile('nope')).toThrow('Unknown domain profile "nope". Available: code.');
  });

  it('guard: one file per built-in profile, keyed by id', () => {
    const stems = fs
      .readdirSync(new URL('../../src/ai/profiles/', import.meta.url))
      .filter(f => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
      .map(f => f.slice(0, -3))
      .sort();
    expect(stems).toEqual(Object.keys(BUILT_IN_PROFILES).sort());
    for (const [k, v] of Object.entries(BUILT_IN_PROFILES)) expect(v.id).toBe(k);
    expect(BUILT_IN_PROFILES.code).toBe(codeProfile);
  });
});
