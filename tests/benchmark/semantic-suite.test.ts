import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const suite = JSON.parse(readFileSync(path.resolve('docs/evals/semantic-suite.json'), 'utf8'));

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'and', 'or', 'for', 'on', 'at',
  'by', 'we', 'our', 'do', 'does', 'did', 'what', 'why', 'how', 'when', 'which', 'that', 'this',
  'it', 'be', 'with', 'as', 'from', 'have', 'has', 'can', 'should', 'not', 'no', 'use', 'used', 'uses',
]);

function contentWords(text: string): string[] {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words)].filter(word => !STOPWORDS.has(word) && word.length > 2);
}

const fixtures = new Map<string, any>(suite.fixtures.map((f: any) => [f.id, f]));

function fixtureText(id: string): string {
  const fixture = fixtures.get(id);
  return `${fixture.title} ${fixture.content} ${(fixture.tags ?? []).join(' ')}`;
}

describe('semantic suite shape', () => {
  it('has 100 to 120 cases', () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(100);
    expect(suite.cases.length).toBeLessThanOrEqual(120);
  });

  it('gives every case a tier and a resolvable expected item', () => {
    for (const testCase of suite.cases) {
      expect(['basic', 'moderate', 'extreme']).toContain(testCase.tier);
      expect(testCase.expectedItemIds.length).toBeGreaterThan(0);
      for (const id of testCase.expectedItemIds) expect(fixtures.has(id)).toBe(true);
      for (const id of testCase.mustNotReturn) expect(fixtures.has(id)).toBe(true);
    }
  });

  it('keeps queries to the 2-6 keywords agents actually send', () => {
    for (const testCase of suite.cases) {
      const words = String(testCase.query).trim().split(/\s+/);
      expect(words.length).toBeGreaterThanOrEqual(2);
      expect(words.length).toBeLessThanOrEqual(6);
    }
  });

  it('holds the intended tier mix', () => {
    const share = (tier: string) =>
      suite.cases.filter((c: any) => c.tier === tier).length / suite.cases.length;
    expect(share('basic')).toBeGreaterThan(0.55);
    expect(share('extreme')).toBeGreaterThan(0.05);
    expect(share('extreme')).toBeLessThan(0.16);
  });
});

describe('tier discipline', () => {
  it('gives extreme cases zero lexical overlap with their target', () => {
    for (const testCase of suite.cases.filter((c: any) => c.tier === 'extreme')) {
      const queryWords = contentWords(testCase.query);
      for (const id of testCase.expectedItemIds) {
        const target = new Set(contentWords(fixtureText(id)));
        const shared = queryWords.filter(word => target.has(word));
        expect(shared, `case ${testCase.id} shares "${shared.join(', ')}"`).toEqual([]);
      }
    }
  });

  it('gives every extreme case at least one lexical decoy', () => {
    for (const testCase of suite.cases.filter((c: any) => c.tier === 'extreme')) {
      expect(testCase.mustNotReturn.length).toBeGreaterThan(0);
      const queryWords = new Set(contentWords(testCase.query));
      const decoyShares = testCase.mustNotReturn.some((id: string) =>
        contentWords(fixtureText(id)).some(word => queryWords.has(word)));
      expect(decoyShares, `case ${testCase.id} has no word-sharing decoy`).toBe(true);
    }
  });

  it('includes lexical-is-correct controls so the suite cannot reward ignoring keywords', () => {
    const controls = suite.cases.filter((c: any) => {
      const queryWords = new Set(contentWords(c.query));
      return c.expectedItemIds.some((id: string) =>
        contentWords(fixtureText(id)).filter(word => queryWords.has(word)).length >= 2);
    });
    expect(controls.length).toBeGreaterThanOrEqual(20);
  });
});
