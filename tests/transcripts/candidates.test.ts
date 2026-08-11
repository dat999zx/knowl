import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import {
  countCandidates,
  extractCandidates,
  listCandidates,
  planExtraction,
} from '../../src/transcripts/extract-candidates.js';
import { discardCandidates } from '../../src/transcripts/approve-candidates.js';

// The model is the one thing these tests must not actually call: extraction spends the operator's
// quota, and a suite that did so would bill whoever ran it.
const extractKnowledge = vi.hoisted(() => vi.fn());
vi.mock('../../src/ai/provider.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/ai/provider.js')>()),
  extractKnowledge,
  initAI: vi.fn(),
}));

let roots: string[] = [];
let db: Client;

// Ollama because it is the one provider `hasAiConfigured` accepts without an apiKey — it is local
// and keyless, so naming it is the whole opt-in. A fixture carrying a fake key would be testing
// the same gate through a field nobody should put a placeholder in.
const AI_CONFIG: ProjectConfig = {
  ...DEFAULT_CONFIG,
  ai: { provider: 'ollama', model: 'llama-test' },
};

async function freshDb(): Promise<Client> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cand-'));
  roots.push(root);
  return openTranscriptDb(path.join(root, 'transcripts.db'));
}

/** A session in the index, with a real `.jsonl` behind it, since extraction reads the file. */
async function seedSession(client: Client, sessionId: string, messages: string[], harness = 'claude') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cand-src-'));
  roots.push(dir);
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const lines = messages.map((text, index) => JSON.stringify({
    type: index % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text }] },
    timestamp: '2026-08-11T00:00:00.000Z',
  }));
  await fs.writeFile(filePath, lines.join('\n') + '\n');

  await client.execute({
    sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, harness)
          VALUES (?, ?, NULL, 0, 0, 0, ?, ?)`,
    args: [filePath, sessionId, new Date().toISOString(), harness],
  });
  for (const [index, text] of messages.entries()) {
    await client.execute({
      sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars)
            VALUES (?, ?, NULL, ?, ?, ?)`,
      args: [filePath, sessionId, index + 1, index % 2 === 0 ? 'user' : 'assistant', text.length],
    });
  }
  return filePath;
}

beforeEach(async () => {
  extractKnowledge.mockReset();
  await closeTranscriptDbs();
  db = await freshDb();
});

afterEach(async () => {
  await closeTranscriptDbs();
});

afterAll(async () => {
  await closeTranscriptDbs();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  roots = [];
});

describe('planning an extraction run', () => {
  it('reports what a run would cost before anything is sent', async () => {
    await seedSession(db, 'a', ['how do we handle retries?', 'with a bounded backoff.']);

    const plan = await planExtraction(db, { limit: 5 });

    expect(plan.sessions).toHaveLength(1);
    expect(plan.pending).toBe(1);
    expect(plan.done).toBe(0);
    expect(plan.chars).toBeGreaterThan(0);
    // Nothing was extracted merely by planning.
    expect(extractKnowledge).not.toHaveBeenCalled();
  });

  it('limits the run but still reports how much is left', async () => {
    for (const id of ['a', 'b', 'c']) await seedSession(db, id, [`ask ${id}`, `answer ${id}`]);

    const plan = await planExtraction(db, { limit: 2 });

    expect(plan.sessions).toHaveLength(2);
    expect(plan.pending).toBe(3);
  });

  it('ignores a session with no indexed messages', async () => {
    await db.execute({
      sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at)
            VALUES ('/nowhere.jsonl', 'empty', NULL, 0, 0, 0, ?)`,
      args: [new Date().toISOString()],
    });

    expect((await planExtraction(db)).sessions).toEqual([]);
  });
});

describe('extraction', () => {
  it('refuses without AI configured, and names the alternative', async () => {
    await seedSession(db, 'a', ['question', 'answer']);

    await expect(extractCandidates(db, DEFAULT_CONFIG)).rejects.toThrow(/knowl_ingest_atoms/);
    expect(extractKnowledge).not.toHaveBeenCalled();
  });

  it('stages what the model returns without storing any of it', async () => {
    await seedSession(db, 'a', ['how do we handle retries?', 'with a bounded backoff.']);
    extractKnowledge.mockResolvedValue([
      { category: 'decision', title: 'Retries use bounded backoff', content: 'Bounded, not infinite.', confidence: 0.8 },
    ]);

    const result = await extractCandidates(db, AI_CONFIG);

    expect(result).toMatchObject({ sessionsExtracted: 1, candidates: 1 });
    const staged = await listCandidates(db);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ status: 'pending', title: 'Retries use bounded backoff' });
  });

  it('does not pay the model twice for one session', async () => {
    await seedSession(db, 'a', ['question', 'answer']);
    extractKnowledge.mockResolvedValue([
      { category: 'fact', title: 'A fact', content: 'Something.', confidence: 0.5 },
    ]);

    await extractCandidates(db, AI_CONFIG);
    const second = await extractCandidates(db, AI_CONFIG);

    expect(extractKnowledge).toHaveBeenCalledTimes(1);
    expect(second.sessionsExtracted).toBe(0);
  });

  it('watermarks a session that yielded nothing, so the bill is not dominated by empty runs', async () => {
    await seedSession(db, 'a', ['hi', 'hello']);
    extractKnowledge.mockResolvedValue([]);

    await extractCandidates(db, AI_CONFIG);
    await extractCandidates(db, AI_CONFIG);

    expect(extractKnowledge).toHaveBeenCalledTimes(1);
  });

  it('leaves a session unwatermarked when the provider fails', async () => {
    // A transient provider error is not a verdict about the session. Marking it done would lose
    // it permanently, and silently.
    await seedSession(db, 'a', ['question', 'answer']);
    extractKnowledge.mockRejectedValueOnce(new Error('502 upstream'));

    const failed = await extractCandidates(db, AI_CONFIG);
    expect(failed.sessionsExtracted).toBe(0);

    extractKnowledge.mockResolvedValue([
      { category: 'fact', title: 'Recovered', content: 'Now it works.', confidence: 0.6 },
    ]);
    const retried = await extractCandidates(db, AI_CONFIG);

    expect(retried.sessionsExtracted).toBe(1);
  });

  it('skips a session whose transcript has vanished and still extracts the rest', async () => {
    // The archive is not this process's to keep: a transcript indexed last week can be gone by
    // the time extraction reaches it. Reading it used to happen outside the per-session guard, so
    // one deleted file ended the run with an ENOENT — after the sessions before it had already
    // been paid for, and with no report of which one stopped it.
    const gone = await seedSession(db, 'gone', ['ask', 'answer']);
    await seedSession(db, 'alive', ['still here', 'and readable']);
    await fs.rm(gone);
    extractKnowledge.mockResolvedValue([
      { category: 'fact', title: 'Survivor', content: 'Extracted after the gap.', confidence: 0.6 },
    ]);

    const result = await extractCandidates(db, AI_CONFIG);

    expect(result.sessionsExtracted).toBe(1);
    expect(result.candidates).toBe(1);
    // Unwatermarked, exactly like a provider failure: the file being unreadable once is not a
    // verdict about the session.
    const done = await db.execute('SELECT session_id FROM transcript_extractions');
    expect(done.rows.map(row => String(row.session_id))).toEqual(['alive']);
  });

  it('sends the tail of a long session, where its conclusions are', async () => {
    const filler = 'x'.repeat(30_000);
    await seedSession(db, 'a', [filler, 'THE CONCLUSION AT THE END']);
    extractKnowledge.mockResolvedValue([]);

    await extractCandidates(db, AI_CONFIG);

    const sent = extractKnowledge.mock.calls[0][0] as string;
    expect(sent).toContain('THE CONCLUSION AT THE END');
    expect(sent.length).toBeLessThanOrEqual(24_000);
  });

  it('stops at the deadline and leaves the rest for the next run', async () => {
    for (const id of ['a', 'b', 'c']) await seedSession(db, id, [`ask ${id}`, `answer ${id}`]);
    extractKnowledge.mockResolvedValue([]);

    const result = await extractCandidates(db, AI_CONFIG, { limit: 3, deadline: Date.now() - 1 });

    expect(extractKnowledge).not.toHaveBeenCalled();
    expect(result.remaining).toBe(3);
  });
});

describe('deciding on candidates', () => {
  beforeEach(async () => {
    await seedSession(db, 'a', ['question', 'answer']);
    extractKnowledge.mockResolvedValue([
      { category: 'fact', title: 'One', content: 'First.', confidence: 0.7 },
      { category: 'fact', title: 'Two', content: 'Second.', confidence: 0.6 },
    ]);
    await extractCandidates(db, AI_CONFIG);
  });

  it('discards without deleting, so a rerun does not ask again', async () => {
    const discarded = await discardCandidates(db, { all: true });

    expect(discarded).toBe(2);
    expect(await listCandidates(db, { status: 'pending' })).toEqual([]);
    expect(await countCandidates(db)).toMatchObject({ discarded: 2 });
  });

  it('discards only the ids it was given', async () => {
    const [first] = await listCandidates(db);

    expect(await discardCandidates(db, { ids: [first.id] })).toBe(1);
    expect(await listCandidates(db, { status: 'pending' })).toHaveLength(1);
  });

  it('does nothing when given no ids and no --all', async () => {
    expect(await discardCandidates(db, {})).toBe(0);
    expect(await listCandidates(db, { status: 'pending' })).toHaveLength(2);
  });
});
