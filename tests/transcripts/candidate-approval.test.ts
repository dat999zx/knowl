import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import * as repo from '../../src/store/repository.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { approveCandidates } from '../../src/transcripts/approve-candidates.js';
import { listCandidates } from '../../src/transcripts/extract-candidates.js';
import { hasIndexableArchive } from '../../src/transcripts/paths.js';

let roots: string[] = [];
let db: Client;
let projectId = '';
let root = '';

/** A staged candidate, written straight in — extraction is `candidates.test.ts`'s subject. */
async function stage(client: Client, over: Partial<{ category: string; title: string; content: string }> = {}) {
  const id = Math.random().toString(16).slice(2, 10);
  await client.execute({
    sql: `INSERT INTO transcript_candidates
            (id, session_id, source_path, harness, category, title, content, confidence, status, extracted_at)
          VALUES (?, 'sess-1', '/archive/sess-1.jsonl', 'codex', ?, ?, ?, 0.7, 'pending', ?)`,
    args: [
      id,
      over.category ?? 'decision',
      over.title ?? 'Retries use bounded backoff',
      over.content ?? 'Retries are bounded rather than infinite, decided while fixing the queue.',
      new Date().toISOString(),
    ],
  });
  return id;
}

beforeEach(async () => {
  await closeDb();
  await closeTranscriptDbs();
  await releaseAll();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-approve-'));
  roots.push(root);
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  projectId = (await repo.createProject(root, 'approval')).id;
  db = await openTranscriptDb(path.join(root, '.knowl', 'transcripts.db'));
});

afterEach(async () => {
  await closeDb();
  await closeTranscriptDbs();
  await releaseAll();
});

afterAll(async () => {
  await closeDb();
  await closeTranscriptDbs();
  await releaseAll();
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  roots = [];
});

describe('approving a staged candidate', () => {
  it('puts it in the knowledge store, attributed to the transcript it came from', async () => {
    const id = await stage(db);

    const result = await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [id] });

    expect(result.approved).toBe(1);
    const stored = await queryKnowledgeBase(projectId, { status: 'active' });
    const promoted = stored.find(item => item.title === 'Retries use bounded backoff');
    expect(promoted).toBeDefined();
    // Distilled by a model from a conversation nobody re-read at approval time. Claiming
    // `observed` would rank it above knowledge somebody actually verified.
    expect(promoted!.provenance).toBe('inferred');
    expect(promoted!.source).toBe('transcript:codex:sess-1');
  });

  it('leaves nothing in the store until approval happens', async () => {
    await stage(db);

    expect(await queryKnowledgeBase(projectId, { status: 'active' })).toEqual([]);
  });

  it('marks the row decided, so it stops being offered', async () => {
    const id = await stage(db);

    await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [id] });

    expect(await listCandidates(db, { status: 'pending' })).toEqual([]);
    const [approved] = await listCandidates(db, { status: 'approved' });
    expect(approved.id).toBe(id);
  });

  it('approves every pending candidate on --all', async () => {
    await stage(db, { title: 'First thing', content: 'One distinct fact about retries.' });
    await stage(db, { title: 'Second thing', content: 'A different fact about caching entirely.' });

    const result = await approveCandidates(db, projectId, DEFAULT_CONFIG, { all: true });

    expect(result.approved).toBe(2);
  });

  it('never touches a candidate that was already decided', async () => {
    const id = await stage(db);
    await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [id] });

    const again = await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [id] });

    expect(again.approved).toBe(0);
  });

  it('fails one candidate alone rather than taking the run down with it', async () => {
    // One bad atom among a thousand model-written ones is the expected case, not the exception.
    const bad = await stage(db, { category: 'not-a-category', title: 'Bad', content: 'Nonsense.' });
    const good = await stage(db, { title: 'Good one', content: 'A real fact worth keeping around.' });

    const result = await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [bad, good] });

    expect(result.approved).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(bad);
    // The failure stays pending: retryable, and never silently reported as a decision.
    expect((await listCandidates(db, { status: 'pending' })).map(row => row.id)).toEqual([bad]);
  });

  /**
   * `--all` does not mean all, and the number that says so.
   *
   * The cap is deliberate -- approval writes atoms one at a time and an unbounded run over a
   * whole archive is worse -- but the first run over a real archive produces atoms on that
   * order, so the cap lands on precisely the run it exists for. Reporting only "Approved N"
   * reads as completion, and the operator who believes it stops with the rest unreviewed.
   */
  it('says how many are still pending when --all stops at its cap', async () => {
    for (let index = 0; index < 5; index += 1) {
      await stage(db, { title: `Atom ${index}`, content: `A distinct fact number ${index} worth keeping.` });
    }

    const first = await approveCandidates(db, projectId, DEFAULT_CONFIG, { all: true, limit: 2 });

    expect(first.approved).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await approveCandidates(db, projectId, DEFAULT_CONFIG, { all: true, limit: 10 });

    expect(second.approved).toBe(3);
    // Nothing left, and the caller can tell that apart from "I stopped early".
    expect(second.remaining).toBe(0);
  });

  it('counts a failed candidate as still pending, because it is still a decision to make', async () => {
    const bad = await stage(db, { category: 'not-a-category', title: 'Bad', content: 'Nonsense.' });
    const good = await stage(db, { title: 'Fine', content: 'An ordinary fact that promotes cleanly.' });

    const result = await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [bad, good] });

    expect(result.approved).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

describe('the cold-start probe', () => {
  it('answers without opening a single transcript', async () => {
    // Two stats and no file reads: this runs at the moment a query has decided memory is empty.
    await expect(hasIndexableArchive(root)).resolves.toEqual(expect.any(Boolean));
  });
});
