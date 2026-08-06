import { describe, expect, it } from 'vitest';
import { lexicalCoverageCheck, probeTermsFromTitle, retrievalProbeCheck } from '../../src/cli/retrieval-probe.js';

describe('probeTermsFromTitle', () => {
  it('keeps the distinctive words and drops the ones that match everything', () => {
    // A probe whose terms are "with"/"that"/"this" passes against an index that has lost the
    // item, because the LIKE fallback in `queryKnowledgeCandidates` still returns rows. The
    // filter is what makes a passing self-test mean something.
    expect(probeTermsFromTitle('Migrations that run with this connection pool'))
      .not.toContain('that');
    expect(probeTermsFromTitle('Migrations that run with this connection pool'))
      .toContain('connection');
  });

  it('orders by length, because a long rare word discriminates and a short one does not', () => {
    const terms = probeTermsFromTitle('Postgres connection pool exhausts');

    expect(terms[0]).toBe('connection');
    expect(terms).toHaveLength(4);
  });

  it('caps the query and never repeats a word', () => {
    const terms = probeTermsFromTitle('backup backup restore restore snapshot rollback archive');

    expect(terms).toHaveLength(4);
    expect(new Set(terms).size).toBe(4);
  });

  it('returns nothing for a title it cannot build a fair question from', () => {
    // Non-ASCII and all-short titles reduce to nothing here. That is reported as skipped
    // rather than failed: a check that cannot ask a fair question must not answer it.
    expect(probeTermsFromTitle('日本語のタイトル')).toEqual([]);
    expect(probeTermsFromTitle('a b c to be or not')).toEqual([]);
  });
});

describe('lexicalCoverageCheck', () => {
  it('fails when items are in neither index, because nothing can reach them', () => {
    // The one state that is not degradation: the item is stored, counted and backed up, and no
    // query of any kind can return it.
    const check = lexicalCoverageCheck({ activeItems: 582, indexedItems: 1, darkItems: 581 });

    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('581 of 582');
  });

  it('warns, not fails, when the lexical gap is still covered by vectors', () => {
    // Keyword search is broken for these items but an agent can still retrieve them
    // semantically, so this is degradation. The count is in the message because that is the
    // part a reader acts on -- 581 missing and 1 missing are not the same morning.
    const check = lexicalCoverageCheck({ activeItems: 582, indexedItems: 1, darkItems: 0 });

    expect(check.status).toBe('WARN');
    expect(check.message).toContain('581 of 582');
  });

  it('passes a fully indexed store and says nothing alarming about an empty one', () => {
    expect(lexicalCoverageCheck({ activeItems: 12, indexedItems: 12, darkItems: 0 }).status).toBe('OK');
    expect(lexicalCoverageCheck({ activeItems: 0, indexedItems: 0, darkItems: 0 }).status).toBe('OK');
  });
});

describe('retrievalProbeCheck', () => {
  it('treats an empty store as advisory, not broken', () => {
    // A new repository is not a broken one. This is the line that used to make `knowl doctor`
    // print NOT READY seconds after `knowl init` printed "ready".
    const check = retrievalProbeCheck({ kind: 'empty' });

    expect(check.status).toBe('WARN');
    expect(check.fix).toMatch(/store at least one durable fact/);
  });

  it('fails when the item behind the query did not come back', () => {
    const check = retrievalProbeCheck({
      kind: 'missed', title: 'Postgres connection pool exhausts', terms: ['connection', 'exhausts'], returned: 10,
    });

    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('connection exhausts');
    expect(check.fix).toContain('knowl audit');
  });

  it('truncates a long title instead of printing a paragraph into the report', () => {
    const check = retrievalProbeCheck({
      kind: 'found', title: 'x'.repeat(200), terms: ['xxxx'], rank: 1, returned: 3,
    });

    expect(check.status).toBe('OK');
    expect(check.message).toContain('...');
    expect(check.message.length).toBeLessThan(160);
  });
});
