import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import {
  queryKnowledgeForAgent, rankKnowledge, scoreCandidates, type Candidate,
} from '../../src/store/agent-query.js';
import { openPeerStore } from '../../src/store/store-handle.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const MINE = path.resolve('./.knowl-rank-mine');
const THEIRS = path.resolve('./.knowl-rank-theirs');
const peerDb = () => path.join(THEIRS, '.knowl', 'knowl.db');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function accessCount(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_access');
  return Number(rows.rows[0].n);
}

/** A bare candidate, for the pure scoring tests. Only the scored fields matter. */
function candidate(id: string, updatedAt: string, repoName?: string): Candidate & { repo?: string } {
  return {
    item: {
      id,
      category: 'fact',
      status: 'active',
      title: `Item ${id}`,
      content: `Content for ${id}.`,
      freshness: 'fresh',
      confidence: 1,
      version: 1,
      createdAt: updatedAt,
      updatedAt,
    } as unknown as KnowledgeItem,
    bm25Rank: 1,
    repo: repoName,
  };
}

describe('rankKnowledge', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(MINE);
    await makeRepo(THEIRS);

    await initDb(MINE);
    const mine = (await repo.createProject(MINE, 'p')).id;
    await storeKnowledgeItemDeduped(mine, {
      category: 'decision', title: 'Local uses postgres', content: 'This repository stores data in postgres.',
    });
    await closeDb();

    await initDb(THEIRS);
    const theirs = (await repo.createProject(THEIRS, 'p')).id;
    const stored = await storeKnowledgeItemDeduped(theirs, {
      category: 'decision', title: 'Peer uses cassandra', content: 'That repository stores data in cassandra.',
    });
    await getClient().execute({
      sql: "UPDATE knowledge_items SET visibility = 'workspace' WHERE id = ?", args: [stored.item.id],
    });
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('records no access telemetry, so it can run on a read-only database', async () => {
    await initDb(MINE);
    try {
      const before = await accessCount();
      const ranked = await rankKnowledge('local', { query: 'postgres' });
      expect(ranked).not.toHaveLength(0);
      expect(await accessCount()).toBe(before);
    } finally {
      await closeDb();
    }
  });

  it('still records telemetry through the public entry point', async () => {
    await initDb(MINE);
    try {
      const before = await accessCount();
      await queryKnowledgeForAgent('local', { query: 'postgres' });
      expect(await accessCount()).toBeGreaterThan(before);
    } finally {
      await closeDb();
    }
  });

  it('ranks a peer database without writing to it', async () => {
    await initDb(MINE);
    try {
      const before = await fs.readFile(peerDb());
      const peer = await openPeerStore(peerDb());
      const ranked = await rankKnowledge('local', { query: 'cassandra', visibility: 'workspace' }, peer);

      expect(ranked.map(item => item.title)).toEqual(['Peer uses cassandra']);
      expect((await fs.readFile(peerDb())).equals(before)).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('gives peer items the same boosts local items get', async () => {
    // The drift this whole plan removes: the old peer scanner applied no recency,
    // confidence, freshness, category or exact-identifier boost at all.
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const [ranked] = await rankKnowledge('local', { query: 'cassandra', visibility: 'workspace' }, peer);
      expect(ranked.explanation.contributions).toHaveProperty('recency');
      expect(ranked.explanation.contributions).toHaveProperty('confidence');
      expect(ranked.explanation.contributions).toHaveProperty('freshness');
    } finally {
      await closeDb();
    }
  });
});

describe('scoreCandidates', () => {
  it('normalizes recency across every candidate it is given, not per source', () => {
    // The reason selection and scoring are separate. Scored one set at a time, the newest
    // item in each set gets recency 1.0 regardless of its actual date -- so a repo whose
    // freshest note is years old would tie a genuinely recent one.
    const old = candidate('a', '2020-01-01T00:00:00.000Z', 'stale');
    const recent = candidate('b', '2026-07-01T00:00:00.000Z', 'live');

    const together = scoreCandidates([old, recent], { limit: 2, usingVector: false });
    const byId = new Map(together.map(entry => [entry.item.id, entry.explanation.contributions.recency]));
    expect(byId.get('a')).toBe(0);
    expect(byId.get('b')).toBeGreaterThan(0);

    // Scored alone, each is the only timestamp in its set and normalizes to the same value.
    // Fusing those two numbers is what made a stale repo look as fresh as a live one.
    const aloneA = scoreCandidates([old], { limit: 1, usingVector: false });
    const aloneB = scoreCandidates([recent], { limit: 1, usingVector: false });
    expect(aloneA[0].explanation.contributions.recency)
      .toBe(aloneB[0].explanation.contributions.recency);
  });

  it('carries a repo label through untouched', () => {
    const scored = scoreCandidates([candidate('a', '2026-01-01T00:00:00.000Z', 'api')], {
      limit: 1, usingVector: false,
    });
    expect(scored[0].repo).toBe('api');
  });

  it('reconstructs the lexical base score from the ranks it was given', () => {
    // The field the old merge loop accumulated is gone; the ranks are the inputs now. A
    // better lexical rank must still score higher, or the lexical path is silently flat.
    const first = { ...candidate('a', '2026-01-01T00:00:00.000Z'), bm25Rank: 1 };
    const tenth = { ...candidate('b', '2026-01-01T00:00:00.000Z'), bm25Rank: 10 };

    const scored = scoreCandidates([tenth, first], { limit: 2, usingVector: false });
    expect(scored[0].item.id).toBe('a');
    expect(scored[0].explanation.contributions.rank)
      .toBeGreaterThan(scored[1].explanation.contributions.rank);
  });
});
