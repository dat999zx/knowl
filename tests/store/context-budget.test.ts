import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { upsertKnowledgeEmbedding } from '../../src/store/vector.js';
import { composeContext } from '../../src/store/context-composer.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const FINGERPRINT = 'context-test-fingerprint';

async function open(root: string) {
  await closeDb();
  await releaseAll();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  return (await repo.createProject(root, 'p')).id;
}

async function drop(root: string) {
  await closeDb();
  await releaseAll();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

describe('K-26 -- pinned constraints cannot crowd out the answer', () => {
  const ROOT = path.resolve('./.knowl-context-budget');
  const titles = (pack: Awaited<ReturnType<typeof composeContext>>, section: string) =>
    pack.sections.find(entry => entry.name === section)!.items.map(item => item.title);

  beforeAll(async () => {
    const projectId = await open(ROOT);
    // A store that takes its rulebook seriously. Nothing unusual: constraints accumulate and
    // are never ranked, so they were all pinned ahead of everything at every budget.
    for (let index = 0; index < 29; index += 1) {
      await repo.createKnowledgeItem(projectId, {
        category: 'constraint',
        title: `Operating constraint ${index}`,
        content: `Constraint ${index}: a paragraph of policy text that has nothing to do with `
          + 'the question being asked, repeated at enough length to cost real budget. '.repeat(3),
      });
    }
    await repo.createKnowledgeItem(projectId, {
      category: 'constraint',
      title: 'Cloudflare tunnel constraint',
      content: 'The cloudflared service reads the SYSTEMPROFILE config, never the user one.',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'The cloudflare tunnel routes to port 6767',
      content: 'Production serves through the cloudflare tunnel on port 6767.',
    });
  });

  afterAll(() => drop(ROOT));

  it.each([500, 1000, 2000, 4000, 8000])('still returns the answer at a %i-token budget', async (tokenBudget) => {
    const pack = await composeContext('local', { query: 'cloudflare tunnel port', tokenBudget });
    expect(titles(pack, 'Relevant knowledge')).toContain('The cloudflare tunnel routes to port 6767');
  });

  it('orders the pinned constraints by relevance rather than by insertion', async () => {
    const pack = await composeContext('local', { query: 'cloudflare tunnel port', tokenBudget: 4000 });
    expect(titles(pack, 'Pinned constraints')[0]).toBe('Cloudflare tunnel constraint');
  });

  it('never spends more than the budget', async () => {
    for (const tokenBudget of [500, 4000]) {
      const pack = await composeContext('local', { query: 'cloudflare tunnel port', tokenBudget });
      expect(pack.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
    }
  });
});

describe('K-31 -- context composition ranks the way query does', () => {
  const ROOT = path.resolve('./.knowl-context-vector');

  beforeAll(async () => {
    const projectId = await open(ROOT);
    // The semantic answer shares no word with the query; the lexical decoy shares several.
    const semantic = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Ingress terminates at the edge worker',
      content: 'Requests are terminated by the edge worker before anything else sees them.',
    });
    const lexical = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Tunnel port notes',
      content: 'Tunnel port notes about the tunnel port and the tunnel port again.',
    });
    await upsertKnowledgeEmbedding({
      knowledgeItemId: semantic.id, provider: 'test', model: 'test-model',
      profileFingerprint: FINGERPRINT, dimensions: 3, vector: [1, 0, 0],
    });
    await upsertKnowledgeEmbedding({
      knowledgeItemId: lexical.id, provider: 'test', model: 'test-model',
      profileFingerprint: FINGERPRINT, dimensions: 3, vector: [0, 1, 0],
    });
  });

  afterAll(() => drop(ROOT));

  it('uses a query embedding when one is available', async () => {
    // Permanently lexical-only before this: composeContext never built a vector and never
    // accepted one, so on a fully embedded store it ranked by BM25 while knowl_query --
    // answering the same question against the same rows -- ranked semantically.
    const pack = await composeContext('local', {
      query: 'tunnel port', tokenBudget: 4000, namespaceRoot: ROOT,
      vector: { enabled: true, profileFingerprint: FINGERPRINT, embedding: [1, 0, 0] },
    });
    const items = pack.sections.flatMap(section => section.items).map(item => item.title);
    expect(items[0]).toBe('Ingress terminates at the edge worker');
  });

  it('still composes lexically when no embedding can be produced', async () => {
    const pack = await composeContext('local', { query: 'tunnel port', tokenBudget: 4000, namespaceRoot: ROOT });
    const items = pack.sections.flatMap(section => section.items).map(item => item.title);
    expect(items).toContain('Tunnel port notes');
  });
});
