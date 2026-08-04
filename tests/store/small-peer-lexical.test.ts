import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { scoreCandidates, selectCandidates, type Candidate } from '../../src/store/agent-query.js';
import { openPeerStore } from '../../src/store/store-handle.js';
import type { KnowledgeItem } from '../../src/core/types.js';

// Per-case roots. libSQL holds the -shm sidecar open on Windows, so a reused fixture path is
// not actually emptied between cases and the peer silently accumulates the previous run's rows.
const bigRoot = (rows: number) => path.resolve(`./.knowl-small-peer-big${rows}`);
const smallRoot = (rows: number) => path.resolve(`./.knowl-small-peer-small${rows}`);

/**
 * The recorded cross-repo residual, tested rather than inherited.
 *
 * The scoring lane left this open: *"SQLite's IDF clamp means a very small peer whose rows
 * nearly all match scores ~1e-6 and drops out of the lexical half... not closable here (it
 * needs the peer's own IDF, already discarded)."* Measured against the shipped code, the first
 * half is real and the second is not: the peer's BM25 does collapse to ~3.7e-6 -- SQLite clamps
 * IDF to 1e-6 once a term appears in half a corpus, and in a 1-to-3-row peer where every row
 * matches, every term does -- but it collapses to a *tiny positive number*, not to zero, and
 * per-corpus normalisation divides it by its own corpus's best. The peer comes back at 1.0 on
 * the lexical half and wins the page.
 *
 * Nothing recomputes the peer's IDF, because nothing needs to. Position within a corpus and
 * share of the query covered are both available without it, and between them they are the
 * whole lexical signal.
 */
async function seed(root: string, rows: Array<{ title: string; content: string }>): Promise<void> {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  const project = await repo.createProject(root, path.basename(root));
  for (const row of rows) {
    const created = await repo.createKnowledgeItem(project.id, { category: 'fact', ...row });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: ['workspace', path.basename(root), created.id],
    });
  }
  await closeDb();
}

describe('a tiny peer whose rows all match is not lost to the IDF clamp', () => {
  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const rows of [1, 2, 3]) {
      for (const dir of [bigRoot(rows), smallRoot(rows)]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Every peer size at which the clamp bites: at 1, 2 and 3 rows every query term appears in
  // at least half of them, so SQLite gives all three an IDF of 1e-6 and the peer's whole
  // lexical ordering spans 3.75e-6 to 3.95e-6.
  it.each([1, 2, 3])('recovers a %i-row peer whose every row matches', async rows => {
    await releaseAll();
    const BIG = bigRoot(rows);
    const SMALL = smallRoot(rows);
    await seed(BIG, [
      { title: 'Payments retry policy', content: 'Failed payments retry three times with backoff.' },
      { title: 'Session cookie flags', content: 'Cookies are httpOnly and secure in production.' },
      { title: 'Image pipeline', content: 'Uploaded images are resized to three widths.' },
      { title: 'Log retention', content: 'Application logs are kept for fourteen days.' },
      { title: 'Feature flags', content: 'Flags are evaluated per request and cached briefly.' },
      { title: 'Rate limiting', content: 'Requests are limited per token bucket per account.' },
      { title: 'Search index build', content: 'The search index build runs after each import.' },
      { title: 'Mail templates', content: 'Templates are compiled at deploy time.' },
    ]);
    await seed(SMALL, [
      { title: 'Deploy build output', content: 'The deploy build output directory is dist.' },
      { title: 'Build output cleaning', content: 'The build output directory is cleaned before each build.' },
      { title: 'Build output caching', content: 'The build output directory is cached between builds.' },
    ].slice(0, rows));

    const query = 'build output directory';
    await initDb(BIG);
    const mine = (await selectCandidates('local', { query, limit: 10 })).map(candidate => ({ ...candidate, repo: 'big' }));
    const peerStore = await openPeerStore(path.join(SMALL, '.knowl', 'knowl.db'));
    const theirs = (await selectCandidates('local', { query, limit: 10, visibility: 'workspace' }, peerStore))
      .map(candidate => ({ ...candidate, repo: 'small' }));

    // The clamp is real: the peer's raw evidence is six orders of magnitude below the local
    // repo's, on a match that is strictly better.
    expect(theirs.length).toBe(rows);
    for (const candidate of theirs) expect(candidate.lexicalScore).toBeLessThan(1e-5);
    expect(mine[0].lexicalScore).toBeGreaterThan(1);

    const scored = scoreCandidates([...mine, ...theirs], { query, limit: 10, usingVector: false });
    // ...and it costs the peer nothing. Its best row leads the page on a full-coverage match,
    // above a local row that shares one term of three.
    expect(scored[0].repo).toBe('small');
    expect((scored[0].explanation.contributions as { lexical: number }).lexical).toBeCloseTo(1, 5);
    expect(scored.some(entry => entry.repo === 'big')).toBe(true);

    await closeDb();
    await releaseAll();
  }, 120_000);

  // The one shape that would genuinely drop a corpus: raw evidence of exactly zero across all
  // of it, so there is no best to divide by. Unreachable from either lexical engine today --
  // `bm25()` is never exactly 0 for a match and the LIKE fallback scores its own literal
  // predicate, which every candidate contains -- but it is a cliff rather than a slope, and
  // coverage is measured on the item and the query alone, so it survives where position does
  // not. This is the case the residual said needed the peer's IDF. It does not.
  it('falls back to coverage when a corpus has no usable lexical magnitude at all', () => {
    const item = (id: string, title: string, content: string): KnowledgeItem => ({
      id, category: 'fact', status: 'active', title, content, freshness: 'fresh', confidence: 1,
      version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as KnowledgeItem);

    const candidates: Array<Candidate & { repo?: string }> = [
      { item: item('a', 'Build output directory', 'The build output directory is dist.'), repo: 'flat', bm25Rank: 1, lexicalScore: 0, lexicalCoverage: 1 },
      { item: item('b', 'Build notes', 'Some build notes.'), repo: 'flat', bm25Rank: 2, lexicalScore: 0, lexicalCoverage: 1 / 3 },
    ];

    const scored = scoreCandidates(candidates, { query: 'build output directory', limit: 5, usingVector: false });
    const lexicalOf = (id: string) => (scored.find(entry => entry.item.id === id)!.explanation.contributions as { lexical: number }).lexical;

    // Not a flat zero for the whole corpus, which is what a rank-and-magnitude-only reading
    // gives, and which leaves the ordering to a tie-break.
    expect(lexicalOf('a')).toBeCloseTo(1, 5);
    expect(lexicalOf('b')).toBeCloseTo(1 / 3, 5);
    expect(scored[0].item.id).toBe('a');
  });

  it('still says nothing about an item the lexical engine never returned', () => {
    const item = (id: string): KnowledgeItem => ({
      id, category: 'fact', status: 'active', title: `Item ${id}`, content: 'Body.', freshness: 'fresh',
      confidence: 1, version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as KnowledgeItem);

    // No rank, no score: vector found it and lexical did not. "Not established" must stay 0
    // rather than becoming a free `coverage` the lexical engine never awarded.
    const scored = scoreCandidates([{ item: item('vector-only'), repo: 'r', lexicalCoverage: 1 }], {
      query: 'build output directory', limit: 5, usingVector: false,
    });
    expect((scored[0].explanation.contributions as { lexical: number }).lexical).toBe(0);
  });
});
