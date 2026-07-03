import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initAI, filterInput, extractKnowledge, compareKnowledge, askQuestion } from '../../src/ai/provider.js';
import { ProjectConfig } from '../../src/core/types.js';

// Mock the 'ai' module functions
vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();
  return {
    ...original,
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
});

import { generateObject, generateText } from 'ai';

const MOCK_CONFIG: ProjectConfig = {
  version: 1,
  project: { name: 'test' },
  ai: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'mock-key',
  },
  security: {
    rejectSecrets: true,
    secretPatterns: ['api_key', 'password'],
  },
};

describe('AI Provider Layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initAI(MOCK_CONFIG.ai!);
    
    // Set a default mock response for generateObject to prevent destructuring errors
    vi.mocked(generateObject).mockResolvedValue({
      object: { pass: true, reason: 'default mock' }
    } as any);
  });

  it('should filter basic sensitive patterns directly', async () => {
    const sensitiveInput = 'My api_key is sk-proj-12345678901234567890';
    const result = await filterInput(sensitiveInput, MOCK_CONFIG);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('Rejected');
  });

  it('should call generateObject for filterInput when clean', async () => {
    const mockFilterResult = { pass: true, reason: 'Looks good' };
    vi.mocked(generateObject).mockResolvedValue({
      object: mockFilterResult,
    } as any);

    const result = await filterInput('This is a valid TypeScript choice.', MOCK_CONFIG);
    expect(result.pass).toBe(true);
    expect(generateObject).toHaveBeenCalled();
  });

  it('should extract knowledge atoms', async () => {
    const mockAtoms = [
      {
        category: 'decision',
        title: 'Use TypeScript',
        content: 'We use TypeScript for type safety.',
        tags: ['backend', 'typescript'],
      },
    ];

    vi.mocked(generateObject).mockResolvedValue({
      object: { atoms: mockAtoms },
    } as any);

    const atoms = await extractKnowledge('Use TS for type safety');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].title).toBe('Use TypeScript');
    expect(generateObject).toHaveBeenCalled();
  });

  it('should compare knowledge atoms', async () => {
    const mockCompareResult = {
      relationship: 'update',
      reason: 'Adds TS version',
      updatedContent: 'We use TypeScript v5 for type safety.',
    };

    vi.mocked(generateObject).mockResolvedValue({
      object: mockCompareResult,
    } as any);

    const result = await compareKnowledge(
      {
        category: 'fact',
        title: 'TS Version',
        content: 'TypeScript v5',
      },
      {
        id: '1',
        projectId: 'test',
        category: 'fact',
        status: 'active',
        title: 'TS Version',
        content: 'TypeScript v4',
        confidence: 1.0,
        version: 1,
        createdAt: '',
        updatedAt: '',
      }
    );

    expect(result.relationship).toBe('update');
    expect(result.updatedContent).toBe('We use TypeScript v5 for type safety.');
  });

  it('should ask questions', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'The active database is PostgreSQL.',
    } as any);

    const answer = await askQuestion('What database are we using?', 'Database: PostgreSQL');
    expect(answer).toBe('The active database is PostgreSQL.');
    expect(generateText).toHaveBeenCalled();
  });
});
