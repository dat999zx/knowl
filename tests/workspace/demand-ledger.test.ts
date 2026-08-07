import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDemandDb,
  demandDbPath,
  fingerprintQuery,
  openDemandDb,
  recordDemandEventBestEffort,
  summarizeDemand,
} from '../../src/workspace/demand-ledger.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-demand-home');

const event = (over: Partial<Parameters<typeof recordDemandEventBestEffort>[1]> = {}) => ({
  queryingRepo: 'a',
  kind: 'federated_query' as const,
  query: 'auth token ttl',
  ...over,
});

/**
 * A fresh workspace name per test, rather than deleting the file between them.
 *
 * On Windows libSQL holds the `-shm` sidecar until the owning process lets go, so a
 * `beforeEach` that removes the home directory silently does nothing and every test after the
 * first inherits the previous one's rows -- which is not a visible failure but a slow drift in
 * every count. The db path is derived from the workspace name, so a new name is a new file, and
 * global teardown sweeps the `.knowl-` prefixed home once every worker is done.
 */
let counter = 0;
let ws = '';

describe('demand ledger', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDemandDb();
    ws = `ws${counter += 1}`;
  });

  afterEach(async () => {
    await closeDemandDb();
    delete process.env.KNOWL_HOME;
  });

  it('lives beside the manifest, not inside any member repo', async () => {
    await recordDemandEventBestEffort(ws, event());
    // The property that makes it the workspace's ledger rather than one repo's: deleting any
    // member repo must not take the evidence with it.
    expect(demandDbPath(ws).startsWith(HOME)).toBe(true);
    expect(await fs.stat(demandDbPath(ws))).toBeDefined();
  });

  it('counts one question asked twice as one question', async () => {
    await recordDemandEventBestEffort(ws, event({ query: 'Auth  Token TTL' }));
    await recordDemandEventBestEffort(ws, event({ query: 'auth token ttl' }));

    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(2);
    expect(summary.topQuestions).toHaveLength(1);
    expect(summary.topQuestions[0].count).toBe(2);
  });

  it('stores a fingerprint but withholds the terms of a secret-bearing query', async () => {
    // The rule this holds: never keep in a workspace file what the knowledge store next door
    // would have refused. The count still lands -- demand is measurable without the text.
    await recordDemandEventBestEffort(
      ws,
      event({ query: 'why did AKIAIOSFODNN7EXAMPLE stop working' }),
      { ...DEFAULT_CONFIG, security: { rejectSecrets: true, secretPatterns: [] } },
    );

    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(1);
    expect(summary.topQuestions[0].terms).toBeNull();
    expect(summary.topQuestions[0].fingerprint).toBe(fingerprintQuery('why did AKIAIOSFODNN7EXAMPLE stop working'));
  });

  it('keeps the terms of an ordinary query, since a proposal has to be re-runnable', async () => {
    await recordDemandEventBestEffort(ws, event({ query: 'how long do auth tokens last' }), DEFAULT_CONFIG);

    const summary = await summarizeDemand(ws);
    expect(summary.topQuestions[0].terms).toBe('how long do auth tokens last');
  });

  it('honours a configured secret pattern', async () => {
    await recordDemandEventBestEffort(
      ws,
      event({ query: 'where is the deploy passphrase kept' }),
      { ...DEFAULT_CONFIG, security: { rejectSecrets: true, secretPatterns: ['passphrase'] } },
    );

    expect((await summarizeDemand(ws)).topQuestions[0].terms).toBeNull();
  });

  it('records every query, not only the weak ones', async () => {
    // The design decision this pins: an abstention-only predicate fires almost never on a real
    // corpus, so a ledger built on it would report "no cross-repo demand" and be believed.
    await recordDemandEventBestEffort(ws, event({ query: 'strong hit', topScore: 0.91 }));
    await recordDemandEventBestEffort(ws, event({ query: 'weak hit', topScore: 0.04 }));

    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(2);
    expect(summary.scores.withScore).toBe(2);
    expect(summary.scores.min).toBeCloseTo(0.04);
    expect(summary.scores.max).toBeCloseTo(0.91);
  });

  it('reports which repo asked and which answered', async () => {
    await recordDemandEventBestEffort(ws, event({ queryingRepo: 'a', servedRepo: 'b' }));
    await recordDemandEventBestEffort(ws, event({ queryingRepo: 'a', servedRepo: 'b', query: 'other' }));
    await recordDemandEventBestEffort(ws, event({ queryingRepo: 'b', servedRepo: 'a', query: 'third' }));

    const summary = await summarizeDemand(ws);
    expect(summary.byQueryingRepo).toEqual([{ repo: 'a', count: 2 }, { repo: 'b', count: 1 }]);
    expect(summary.byServingRepo).toEqual([{ repo: 'b', count: 2 }, { repo: 'a', count: 1 }]);
  });

  it('never throws, whatever the caller hands it', async () => {
    // The contract the response path depends on. A ledger that can fail a query is strictly
    // worse than no ledger, so this must hold even for a workspace name that is not a
    // legal path segment.
    await expect(recordDemandEventBestEffort('name/with\0nul', event())).resolves.toBeUndefined();
  });

  it('drops events older than the retention window when the ledger is opened', async () => {
    await recordDemandEventBestEffort(ws, event());
    const client = await openDemandDb(ws);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await client.execute({
      sql: `INSERT INTO demand_events (at, querying_repo, kind, query_fingerprint) VALUES (?, 'a', 'federated_query', 'old')`,
      args: [old],
    });
    expect((await summarizeDemand(ws)).total).toBe(2);

    await closeDemandDb();
    // Pruning happens on open, so the reopen is the thing under test.
    expect((await summarizeDemand(ws)).total).toBe(1);
  });

  it('upgrades a file written by a build that lacked the later columns', async () => {
    // Two builds write this file whenever a machine's global CLI and a repo's pinned version
    // differ, and CREATE TABLE IF NOT EXISTS is not a migration: it leaves the old table alone
    // and every insert naming a new column fails.
    await fs.mkdir(path.dirname(demandDbPath(ws)), { recursive: true });
    const legacy = createClient({ url: `file:${demandDbPath(ws)}` });
    await legacy.execute(`CREATE TABLE demand_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      querying_repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL
    );`);
    await legacy.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    legacy.close();

    await recordDemandEventBestEffort(ws, event({ topScore: 0.5, servedRepo: 'b', servedItemId: 'item-1' }));

    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(1);
    expect(summary.byServingRepo).toEqual([{ repo: 'b', count: 1 }]);
  });

  it('takes concurrent writers on one file, on one connection', async () => {
    // Every knowl process on the machine may write this, and the busy timeout is deliberately
    // low -- across processes, losing a row beats blocking a query. WITHIN one process there is
    // nothing to lose to: `openDemandDb` caches the in-flight open, so a burst that all misses
    // the cache together collapses onto a single connection and the writes simply queue.
    //
    // So this asserts all twenty rather than "more than none". The weaker assertion passed
    // equally when each caller opened its own connection -- which is the shape that leaks, since
    // only the last one is reachable from the cache and the other nineteen are never closed.
    // Twenty is the number that distinguishes the two.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordDemandEventBestEffort(ws, event({ query: `question ${index % 5}` }))),
    );

    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(20);
    expect(summary.topQuestions.length).toBe(5);
  });

  it('reports an empty ledger without creating one', async () => {
    // Opening a libSQL `file:` URL creates the file, so a report that goes straight to the
    // client brings into existence the thing it is reporting on -- the shape 3.3.0 fixed in
    // `doctor`. "Nothing recorded" is an answer; it is not a reason to write.
    const summary = await summarizeDemand(ws);

    expect(summary.total).toBe(0);
    expect(summary.scores.withScore).toBe(0);
    await expect(fs.access(demandDbPath(ws))).rejects.toThrow();
  });

  it('retries the open after a failure instead of caching the rejection', async () => {
    // The cost of caching a promise rather than a client: a rejected open must not be handed to
    // every later caller forever. The failure this survives is transient by nature -- something
    // sitting where the workspace directory belongs -- so recovery has to be automatic.
    const dir = path.dirname(demandDbPath(ws));
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not a directory');

    await recordDemandEventBestEffort(ws, event());
    expect(await fs.readFile(dir, 'utf-8')).toBe('not a directory');

    await fs.rm(dir, { force: true });
    await recordDemandEventBestEffort(ws, event());
    expect((await summarizeDemand(ws)).total).toBe(1);
  });
});
