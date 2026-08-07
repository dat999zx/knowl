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
  it('has 100 to 140 cases', () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(100);
    expect(suite.cases.length).toBeLessThanOrEqual(140);
  });

  it('gives every case a tier and a resolvable expected item', () => {
    for (const testCase of suite.cases) {
      expect(['basic', 'moderate', 'extreme']).toContain(testCase.tier);
      expect(testCase.expectedItemIds.length).toBeGreaterThan(0);
      for (const id of testCase.expectedItemIds) expect(fixtures.has(id)).toBe(true);
      for (const id of testCase.mustNotReturn) expect(fixtures.has(id)).toBe(true);
    }
  });

  /**
   * This assertion used to cap every query at 6 words, which baked a refuted rule into the one
   * suite meant to discriminate. The ground-truth ablation in docs/evals/agent-surface.md found
   * truncating to six words costs 4.7-7.2pp hit@1 while off-subject padding costs 24-37pp: count
   * is not the variable, on-subject-ness is. The cap also made the suite unrepresentative --
   * 921 real knowl_query calls average 5.75 words with 26.6% over 6 and a max of 12, while the
   * suite averaged 3.5 and topped out at 6, so no case exercised the length agents actually send.
   *
   * What replaces it is a floor and a distribution, not a ceiling.
   */
  it('carries queries at the length agents really send, with no upper cap', () => {
    const lengths = suite.cases.map((c: any) => String(c.query).trim().split(/\s+/).length);
    for (const length of lengths) expect(length).toBeGreaterThanOrEqual(2);
    // Representativeness: real traffic is 26.6% over six words. Well under that and the suite
    // has drifted back to the short-query regime the cap created.
    const overSix = lengths.filter((n: number) => n > 6).length;
    expect(overSix / lengths.length).toBeGreaterThan(0.15);
  });

  /**
   * Agents do not end a query with a question mark: 0 of 921 real calls did. A suite of
   * natural-language questions would measure a phrasing nobody sends.
   *
   * Only the punctuation is asserted. The same measurement also found no query *leading* with an
   * interrogative, but enforcing that here fails `where secrets live` -- a relative clause, not a
   * question, and perfectly plausible agent phrasing. The blunt version of this rule flags good
   * queries, which is how the word-count cap it replaced went wrong in the first place.
   */
  it('never phrases a case as an explicit question', () => {
    for (const testCase of suite.cases) {
      expect(String(testCase.query).trim()).not.toMatch(/\?$/);
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
