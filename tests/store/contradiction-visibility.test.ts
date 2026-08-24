import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  detectReversal,
  distinctiveTitleCap,
  reversalCueSentences,
  storeKnowledgeItemDeduped,
  titleTokenFrequency,
} from '../../src/store/knowledge-writer.js';
import { scanContradictions } from '../../src/store/contradiction-scan.js';

/**
 * The motivating pair, reproduced 2026-08-24 against the then-current main through the real
 * MCP write path: the second store landed in silence, the query returned both decisions as
 * fresh, and `knowl conflicts` returned []. Every assertion on this pair below is a regression
 * pin on that silence.
 */
const POSTGRES = {
  category: 'decision' as const,
  title: 'Database choice: Postgres for everything',
  content: 'We standardize on Postgres for all persistence: app data, queues, and analytics. No second database.',
};
const SQLITE_REVERSAL = {
  category: 'decision' as const,
  title: 'We are moving persistence to SQLite',
  content: 'Persistence moves to SQLite per-project files. The Postgres-for-everything plan is abandoned.',
};

describe('reversalCueSentences', () => {
  it('is empty for ordinary content, which is what makes the check affordable', () => {
    expect(reversalCueSentences('The build takes 90 seconds and the cache halves it.')).toEqual([]);
  });

  it('returns the cue sentence with its own tokens, not the whole content', () => {
    const found = reversalCueSentences(SQLITE_REVERSAL.content);
    expect(found).toHaveLength(1);
    expect(found[0].cue).toBe('abandoned');
    expect(found[0].sentence).toBe('The Postgres-for-everything plan is abandoned.');
    expect(found[0].tokens.has('sqlite')).toBe(false);
  });
});

describe('detectReversal', () => {
  const twoItemStore = titleTokenFrequency([POSTGRES.title, SQLITE_REVERSAL.title]);
  const cap = distinctiveTitleCap(2);

  it('fires on the motivating pair in a fresh two-item store', () => {
    const match = detectReversal(
      reversalCueSentences(SQLITE_REVERSAL.content),
      POSTGRES.title,
      twoItemStore,
      cap,
    );
    expect(match).not.toBeNull();
    expect(match!.cue).toBe('abandoned');
    expect(match!.sentence).toContain('Postgres-for-everything plan is abandoned');
  });

  it('needs the cue and the subject in the SAME sentence -- a cue elsewhere is not a reversal of this', () => {
    const match = detectReversal(
      reversalCueSentences('The old CI runner is abandoned. Postgres handles everything else fine.'),
      POSTGRES.title,
      twoItemStore,
      cap,
    );
    expect(match).toBeNull();
  });

  it('does not count tokens that are common across this store\'s own titles', () => {
    // Ten titles sharing "web site" make those tokens name nothing; measured on a real
    // 831-item store, pairs matched through such tokens were every false fire in the naive
    // variant. The cue sentence here shares only common tokens, so nothing fires.
    const titles = Array.from({ length: 10 }, (_, i) => `feat(web): the public site part ${i}`);
    const frequency = titleTokenFrequency(titles);
    const match = detectReversal(
      reversalCueSentences('The web site experiment is abandoned.'),
      titles[0],
      frequency,
      distinctiveTitleCap(titles.length),
    );
    expect(match).toBeNull();
  });

  it('needs half the distinctive title tokens, not just any two', () => {
    const frequency = titleTokenFrequency([
      'Retrieval latency budget: cache, index, embedder, reranker, fusion, floor',
    ]);
    const match = detectReversal(
      reversalCueSentences('The cache and index experiment is abandoned.'),
      'Retrieval latency budget: cache, index, embedder, reranker, fusion, floor',
      frequency,
      distinctiveTitleCap(1),
    );
    expect(match).toBeNull();
  });

  it('never matches a title with fewer than two distinctive tokens, like sameSubjectTitle\'s one-token exclusion', () => {
    const frequency = titleTokenFrequency(['Auth']);
    expect(detectReversal(
      reversalCueSentences('Auth is abandoned.'),
      'Auth',
      frequency,
      distinctiveTitleCap(1),
    )).toBeNull();
  });
});

describe('the motivating pair through a real write', () => {
  const ROOT = path.resolve('./.knowl-contradiction-visibility-test');
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'contradiction-visibility')).id;
  });
  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('the write that used to land in silence now reports the item it reads as reversing', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, POSTGRES);
    expect(first.action).toBe('inserted');

    const second = await storeKnowledgeItemDeduped(projectId, SQLITE_REVERSAL);
    expect(second.action).toBe('inserted');
    // The load-bearing assertion: this was `undefined` all the way down before, with a
    // token overlap of 0.33 sitting just under the 0.35 near-duplicate gate.
    expect(second.reversal).toBeDefined();
    expect(second.reversal!.id).toBe(first.item.id);
    expect(second.reversal!.sentence).toContain('abandoned');

    // Advisory, never a resolution: both stay active, exactly like the polarity clamp.
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('active');
    expect((await repo.getKnowledgeItem(second.item.id))!.status).toBe('active');
  });

  it('knowl conflicts lists polarity pairs and NOT reversal candidates', async () => {
    // The split, pinned. `detectReversal` runs on the write path (asserted above) and is
    // deliberately absent from the inspection command: measured at ~4% recall against 101 real
    // supersessions, with 45 false candidates among active items
    // (docs/evals/reversal-detector-recall.md). A dismissable note beside the writer's own
    // sentence survives that rate; a list an agent reads as a work queue does not.
    const detected = await scanContradictions();
    expect(Object.keys(detected)).toEqual(['polarity']);
    expect((detected as Record<string, unknown>).reversalCandidates).toBeUndefined();
  });

  it('a deliberate supersede is already resolved and gets no reversal note', async () => {
    const decided = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Queue backend is Redis streams',
      content: 'Queueing runs on Redis streams.',
    });
    const reversal = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Queue backend moves to Postgres LISTEN/NOTIFY',
      content: 'The Redis streams queue backend is abandoned.',
      supersedes: decided.item.id,
    });
    expect(reversal.superseded?.id).toBe(decided.item.id);
    expect(reversal.reversal).toBeUndefined();
  });

  it('the write advisory names the best-covered item, not every title its sentence brushes', async () => {
    // One sentence asserts one reversal. Before the scan dropped reversal candidates entirely
    // this mattered on both surfaces; it still matters here, because a long enumerating
    // sentence reaches several titles at once and only one of them is what it is about.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Snapshot restore wipes the store on empty ATTACH',
      content: 'An empty ATTACH truncated every table during restore.',
    });
    const near = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Pre-restore prune deletes the restore source rows',
      content: 'The prune pass removed the very rows restore was about to read.',
    });
    const notes = await storeKnowledgeItemDeduped(projectId, {
      category: 'state',
      title: 'Release notes for the recovery run',
      content: 'Pre-restore prune no longer deletes the restore source rows.',
    });
    // Exactly one advisory, and it is the item the sentence actually names.
    expect(notes.reversal).toBeDefined();
    expect(notes.reversal!.id).toBe(near.item.id);
  });

  it('the polarity pairs the write path clamps to coexist are listed too', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Push gate no longer blocks default branch',
      content: 'The default-branch blocking gate was removed.',
    });
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Push gate blocks default branch',
      content: 'Pushing from the default branch is refused.',
    });
    const detected = await scanContradictions();
    const pair = detected.polarity.find(
      row => [row.a.title, row.b.title].sort().join('|')
        === ['Push gate blocks default branch', 'Push gate no longer blocks default branch'].sort().join('|'),
    );
    expect(pair).toBeDefined();
  });
});
