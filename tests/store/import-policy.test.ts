import { describe, expect, it } from 'vitest';
import {
  classifyIncomingItem,
  DEFAULT_DIVERGENCE_POLICY,
  resolveDivergence,
} from '../../src/store/import-policy.js';

const local = { id: 'a', contentHash: 'hash-local', updatedAt: '2026-07-01T00:00:00.000Z', version: 3 };

describe('import classification', () => {
  it('classifies an unseen id as new', () => {
    expect(classifyIncomingItem({ id: 'b', contentHash: 'x', updatedAt: local.updatedAt, version: 1 }, undefined))
      .toBe('new');
  });

  it('classifies a matching content hash as identical', () => {
    expect(classifyIncomingItem({ id: 'a', contentHash: 'hash-local', updatedAt: '2026-07-09T00:00:00.000Z', version: 9 }, local))
      .toBe('identical');
  });

  it('classifies a differing content hash as divergent', () => {
    expect(classifyIncomingItem({ id: 'a', contentHash: 'hash-remote', updatedAt: local.updatedAt, version: 3 }, local))
      .toBe('divergent');
  });
});

describe('divergence resolution', () => {
  const newer = { id: 'a', contentHash: 'hash-remote', updatedAt: '2026-07-09T00:00:00.000Z', version: 4 };
  const older = { id: 'a', contentHash: 'hash-remote', updatedAt: '2026-06-01T00:00:00.000Z', version: 1 };

  it('defaults to newer', () => {
    expect(DEFAULT_DIVERGENCE_POLICY).toBe('newer');
  });

  it('newer takes the later updatedAt', () => {
    expect(resolveDivergence('newer', newer, local)).toBe('incoming');
    expect(resolveDivergence('newer', older, local)).toBe('local');
  });

  it('newer breaks an updatedAt tie on version, then keeps local', () => {
    const tie = { ...newer, updatedAt: local.updatedAt };
    expect(resolveDivergence('newer', { ...tie, version: 9 }, local)).toBe('incoming');
    expect(resolveDivergence('newer', { ...tie, version: 1 }, local)).toBe('local');
    expect(resolveDivergence('newer', { ...tie, version: local.version }, local)).toBe('local');
  });

  it('skip always keeps local and theirs always takes incoming', () => {
    expect(resolveDivergence('skip', newer, local)).toBe('local');
    expect(resolveDivergence('theirs', older, local)).toBe('incoming');
  });
});
