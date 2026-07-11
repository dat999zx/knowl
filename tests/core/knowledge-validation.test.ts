import { describe, expect, it } from 'vitest';
import {
  KnowledgeValidationError,
  validateKnowledgeWrite,
} from '../../src/core/knowledge-validation.js';

describe('validateKnowledgeWrite', () => {
  it('accepts clean structured knowledge', () => {
    expect(validateKnowledgeWrite({
      title: 'SQLite persistence',
      content: 'Knowl stores project knowledge in a local SQLite database.',
      affectedPaths: ['src/store/repository.ts'],
    })).toEqual({ pass: true });
  });

  it('rejects a credential-like token without echoing it', () => {
    const secret = 'sk-test-123456789012345678901234567890';

    expect(() => validateKnowledgeWrite({ title: 'x', content: secret }))
      .toThrow(/secret/i);

    try {
      validateKnowledgeWrite({ title: 'x', content: secret });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeValidationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects PEM blocks', () => {
    expect(() => validateKnowledgeWrite({
      content: '-----BEGIN PRIVATE KEY-----\nprivate material',
    })).toThrow(/secret/i);
  });

  it('rejects credential-bearing URLs', () => {
    expect(() => validateKnowledgeWrite({
      source: 'postgres://admin:password@example.test/knowl',
    })).toThrow(/secret/i);
  });

  it('rejects high-entropy token runs', () => {
    expect(() => validateKnowledgeWrite({
      content: 'Token: AKIAIOSFODNN7EXAMPLEa8Zk0mN2pQ4rS6tV9wX1yC3dE5fG7hJ',
    })).toThrow(/secret/i);
  });

  it('rejects configured secret patterns case-insensitively', () => {
    expect(() => validateKnowledgeWrite(
      { content: 'Deploy with InternalProdCredential.' },
      { secretPatterns: ['internalprodcredential'] },
    )).toThrow(/configured-pattern/i);
  });

  it('rejects environment and credential paths', () => {
    expect(() => validateKnowledgeWrite({
      affectedPaths: ['apps/api/.env.production'],
    })).toThrow(/path/i);
  });

  it('rejects oversized payloads', () => {
    expect(() => validateKnowledgeWrite(
      { rawOutput: 'x'.repeat(11) },
      { maxRawOutputLength: 10 },
    )).toThrow(/length/i);
  });

  it('rejects oversized normal fields', () => {
    expect(() => validateKnowledgeWrite(
      { content: 'x'.repeat(11) },
      { maxFieldLength: 10 },
    )).toThrow(/length/i);
  });
});
