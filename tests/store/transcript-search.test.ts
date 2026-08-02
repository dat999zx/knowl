import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { encodeProjectDir, ensureTranscriptIndex, transcriptIndexStats } from '../../src/store/transcript-index.js';
import { readTranscriptEntry, searchTranscripts } from '../../src/store/transcript-search.js';

const TEST_ROOT = path.resolve('./.knowl-transcript-search-test');
// A fake transcript store, injected rather than pointed at via HOME: mutating
// HOME/USERPROFILE leaks into every other suite sharing the worker, and
// os.homedir() reads USERPROFILE on Windows.
const FAKE_STORE = path.join(TEST_ROOT, 'store', 'projects');
const STORES = [FAKE_STORE];
const PROJECT_DIR = 'D:\\Code\\FakeProject';

function userLine(text: string, ts: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } }) + '\n';
}
function assistantLine(text: string, ts: string) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } }) + '\n';
}
function toolLine(result: string, ts: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', content: result }] } }) + '\n';
}

let sessionDir: string;

describe('transcript search', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    await repo.createProject(TEST_ROOT, 'Transcript search test');

    sessionDir = path.join(FAKE_STORE, encodeProjectDir(PROJECT_DIR));
    await fs.mkdir(sessionDir, { recursive: true });

    await fs.writeFile(path.join(sessionDir, 'session-one.jsonl'),
      // Noise that must never be indexed.
      userLine('<local-command-caveat>Caveat: ignore me</local-command-caveat>', '2026-01-01T00:00:00Z') +
      userLine('<command-name>/rename</command-name>', '2026-01-01T00:01:00Z') +
      // The target: a decision stated by the user.
      userLine('the boxed card variant read as an advertisement so we rejected it', '2026-01-02T00:00:00Z') +
      assistantLine('Understood, dropping the boxed variant.', '2026-01-02T00:01:00Z') +
      // Distractor sharing one term only.
      assistantLine('The card padding is sixteen pixels.', '2026-01-02T00:02:00Z'));

    await fs.writeFile(path.join(sessionDir, 'session-two.jsonl'),
      toolLine('boxed card variant advertisement rejected rejected rejected', '2026-01-03T00:00:00Z') +
      assistantLine('Unrelated discussion about migrations.', '2026-01-03T00:01:00Z'));
  });

  afterAll(async () => {
    await closeDb();
    // Windows keeps a handle on the WAL briefly after close, so removal here can
    // race and throw EBUSY. beforeAll clears the directory anyway, which is the
    // guarantee the suite actually needs.
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('encodes a project directory the way Claude Code does', () => {
    expect(encodeProjectDir('D:\\Code\\FakeProject')).toBe('D--Code-FakeProject');
  });

  it('ranks the user message that states the decision first', async () => {
    const { hits } = await searchTranscripts('boxed card variant rejected', { projectDir: PROJECT_DIR, stores: STORES });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].role).toBe('user');
    expect(hits[0].snippet).toContain('advertisement');
    expect(hits[0].locator).toMatch(/^transcript:\/\/session-one#L\d+$/);
  });

  it('never returns the caveat wrapper or a bare slash command', async () => {
    const { hits } = await searchTranscripts('rename caveat ignore', { projectDir: PROJECT_DIR, limit: 20, stores: STORES });
    for (const hit of hits) {
      expect(hit.snippet).not.toContain('local-command-caveat');
      expect(hit.snippet).not.toContain('<command-name>');
    }
  });

  it('indexes tool output but weights it below real prose', async () => {
    const { hits } = await searchTranscripts('advertisement', { projectDir: PROJECT_DIR, limit: 20, stores: STORES });
    // The tool result repeats the term more often, so an unweighted BM25 would
    // put it first. The user message must still win.
    expect(hits[0].sessionId).toBe('session-one');
    expect(hits.some(hit => hit.sessionId === 'session-two')).toBe(true);
  });

  it('rewards covering every query term over repeating one', async () => {
    const { hits } = await searchTranscripts('boxed variant advertisement', { projectDir: PROJECT_DIR, limit: 5, stores: STORES });
    expect(hits[0].snippet).toContain('boxed');
    expect(hits[0].snippet).toContain('advertisement');
  });

  it('returns nothing for a query of only stopwords', async () => {
    const { hits } = await searchTranscripts('the and for', { projectDir: PROJECT_DIR, stores: STORES });
    expect(hits).toEqual([]);
  });

  it('reads a single entry in full from its locator', async () => {
    const { hits } = await searchTranscripts('boxed card variant rejected', { projectDir: PROJECT_DIR, stores: STORES });
    const entry = await readTranscriptEntry(hits[0].sessionId, hits[0].line, PROJECT_DIR, STORES);
    expect(entry?.role).toBe('user');
    expect(entry?.text).toContain('rejected it');
  });

  it('re-indexing an unchanged archive adds nothing and opens no files', async () => {
    const before = await transcriptIndexStats(PROJECT_DIR);
    const result = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect(result.messagesAdded).toBe(0);
    expect(result.filesUpdated).toBe(0);
    expect((await transcriptIndexStats(PROJECT_DIR)).messages).toBe(before.messages);
  });

  it('picks up appended messages without reindexing what came before', async () => {
    const before = await transcriptIndexStats(PROJECT_DIR);
    await fs.appendFile(path.join(sessionDir, 'session-one.jsonl'),
      userLine('the gradient headline was rejected because it looked like a crypto advert', '2026-01-04T00:00:00Z'));

    const result = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    // Exactly one new message, not the whole file again.
    expect(result.messagesAdded).toBe(1);
    expect((await transcriptIndexStats(PROJECT_DIR)).messages).toBe(before.messages + 1);

    const { hits } = await searchTranscripts('gradient headline crypto', { projectDir: PROJECT_DIR, stores: STORES });
    expect(hits[0].snippet).toContain('gradient headline');
  });

  it('rebuilds a session that was rewritten rather than appended to', async () => {
    await fs.writeFile(path.join(sessionDir, 'session-two.jsonl'),
      assistantLine('short', '2026-01-05T00:00:00Z'));
    const result = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect(result.messagesAdded).toBeGreaterThan(0);
    // The old tool-result line is gone, so its distinctive terms no longer match.
    const { hits } = await searchTranscripts('migrations unrelated', { projectDir: PROJECT_DIR, stores: STORES });
    expect(hits.every(hit => hit.sessionId !== 'session-two')).toBe(true);
  });

  it('detects a same-size in-place rewrite by mtime and rebuilds the session', async () => {
    // Same byte length, different content - invisible to the size check.
    const before = assistantLine('the animal is a badger', '2026-01-05T01:00:00Z');
    const after  = assistantLine('the animal is a ferret', '2026-01-05T01:00:00Z');
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));

    await fs.appendFile(path.join(sessionDir, 'session-one.jsonl'), before);
    await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect((await searchTranscripts('badger', { projectDir: PROJECT_DIR, stores: STORES })).hits.length).toBeGreaterThan(0);

    // Rewrite the whole file with the one word changed; size is identical.
    const content = await fs.readFile(path.join(sessionDir, 'session-one.jsonl'), 'utf8');
    await fs.writeFile(path.join(sessionDir, 'session-one.jsonl'), content.replace('badger', 'ferret'));
    // Detection is mtime-based, and a rewrite inside the same clock tick is
    // indistinguishable - real rewrites happen later than that. Model it.
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(sessionDir, 'session-one.jsonl'), later, later);
    await ensureTranscriptIndex(PROJECT_DIR, STORES);

    expect((await searchTranscripts('badger', { projectDir: PROJECT_DIR, stores: STORES })).hits).toEqual([]);
    expect((await searchTranscripts('ferret', { projectDir: PROJECT_DIR, stores: STORES })).hits.length).toBeGreaterThan(0);
  });

  it('stops at the time budget and resumes where it left off', async () => {
    // Wipe the index so there is real work to interrupt.
    const { getClient } = await import('../../src/store/database.js');
    const client = getClient();
    await client.execute("INSERT INTO transcript_fts(transcript_fts) VALUES('delete-all')");
    await client.execute('DELETE FROM transcript_messages');
    await client.execute('DELETE FROM transcript_files');

    // A zero budget expires on the first line, so the pass must report itself
    // incomplete rather than quietly returning a half-built index as finished.
    const first = await ensureTranscriptIndex(PROJECT_DIR, STORES, 0);
    expect(first.complete).toBe(false);

    // A generous budget finishes the job, and the total is the whole archive -
    // proving the interrupted pass resumed instead of restarting or duplicating.
    const second = await ensureTranscriptIndex(PROJECT_DIR, STORES, 60_000);
    expect(second.complete).toBe(true);

    const { hits } = await searchTranscripts('boxed card variant rejected', { projectDir: PROJECT_DIR, stores: STORES });
    expect(hits[0].snippet).toContain('advertisement');

    // No message indexed twice: one locator per line.
    const all = await searchTranscripts('advertisement', { projectDir: PROJECT_DIR, limit: 50, stores: STORES });
    const locators = all.hits.map(hit => hit.locator);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('scopes to one session by id or prefix, which is what makes a handoff brief actionable', async () => {
    // Own fixture: an earlier test rewrites session-two, so this cannot rely on
    // the original contents still spanning both sessions.
    await fs.appendFile(path.join(sessionDir, 'session-two.jsonl'),
      userLine('a second take on the advertisement question', '2026-01-06T00:00:00Z'));
    await ensureTranscriptIndex(PROJECT_DIR, STORES);

    const all = await searchTranscripts('advertisement', { projectDir: PROJECT_DIR, limit: 20, stores: STORES });
    expect(new Set(all.hits.map(hit => hit.sessionId)).size).toBeGreaterThan(1);

    const scoped = await searchTranscripts('advertisement', { projectDir: PROJECT_DIR, limit: 20, stores: STORES, sessionId: 'session-one' });
    expect(scoped.hits.length).toBeGreaterThan(0);
    expect(scoped.hits.every(hit => hit.sessionId === 'session-one')).toBe(true);

    // A prefix resolves the same way, so a brief can quote a short id.
    const byPrefix = await searchTranscripts('advertisement', { projectDir: PROJECT_DIR, limit: 20, stores: STORES, sessionId: 'session-o' });
    expect(byPrefix.hits.map(hit => hit.locator)).toEqual(scoped.hits.map(hit => hit.locator));
  });

  it('defers to another process\'s fresh lease, then reclaims it once stale', async () => {
    const { getClient } = await import('../../src/store/database.js');
    const client = getClient();
    await fs.appendFile(path.join(sessionDir, 'session-one.jsonl'),
      userLine('the lease canary sentence about phosphorescent umbrellas', '2026-01-07T00:00:00Z'));

    // Simulate a live claim by a DIFFERENT process: a fresh stamp this process
    // never wrote. The file must be skipped without ending the whole pass.
    await client.execute({
      sql: "UPDATE transcript_files SET indexed_at = ? WHERE path LIKE '%session-one%'",
      args: [new Date().toISOString()],
    });
    const deferred = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect(deferred.complete).toBe(false);
    const before = await searchTranscripts('phosphorescent umbrellas', { projectDir: PROJECT_DIR, stores: STORES });
    expect(before.hits).toEqual([]);

    // Expire the claim: a crashed indexer must not stall the file forever.
    await client.execute({
      sql: "UPDATE transcript_files SET indexed_at = ? WHERE path LIKE '%session-one%'",
      args: [new Date(Date.now() - 60_000).toISOString()],
    });
    const reclaimed = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect(reclaimed.messagesAdded).toBeGreaterThan(0);
    const after = await searchTranscripts('phosphorescent umbrellas', { projectDir: PROJECT_DIR, stores: STORES });
    expect(after.hits[0]?.snippet).toContain('phosphorescent');
  });

  it('drops cached embeddings when their messages are purged, so a reused id cannot inherit a stale vector', async () => {
    const { getClient } = await import('../../src/store/database.js');
    const client = getClient();

    // Populate the embedding cache via a semantic search over current content.
    const semantic = { model: 'purge-model', embed: async (texts: string[]) => texts.map(() => [1, 0]) };
    // Two matching messages: the semantic pass only engages with >1 candidate.
    await fs.appendFile(path.join(sessionDir, 'session-two.jsonl'),
      userLine('embedding purge target phrase', '2026-01-08T00:00:00Z') +
      assistantLine('a second embedding purge target for the ranker', '2026-01-08T00:01:00Z'));
    await ensureTranscriptIndex(PROJECT_DIR, STORES);
    await searchTranscripts('embedding purge target', { projectDir: PROJECT_DIR, stores: STORES, semantic });
    const cached = Number((await client.execute("SELECT COUNT(*) n FROM transcript_embeddings WHERE model = 'purge-model'")).rows[0].n);
    expect(cached).toBeGreaterThan(0);

    // Rewrite the session so its rows are purged. No embedding row may survive
    // pointing at a message that no longer exists.
    await fs.writeFile(path.join(sessionDir, 'session-two.jsonl'), assistantLine('tiny', '2026-01-09T00:00:00Z'));
    await ensureTranscriptIndex(PROJECT_DIR, STORES);
    const orphans = Number((await client.execute(
      'SELECT COUNT(*) n FROM transcript_embeddings e LEFT JOIN transcript_messages m ON m.id = e.message_id WHERE m.id IS NULL',
    )).rows[0].n);
    expect(orphans).toBe(0);
  });

  it('fuses a semantic ranking with the lexical one when a reranker is supplied', async () => {
    // A stub embedder: vectors are keyed off a marker word, so the semantic pass
    // has a defined preference without downloading a model.
    const semantic = {
      model: 'stub-model',
      embed: async (texts: string[]) => texts.map(text => [text.includes('gradient') ? 1 : 0, text.includes('boxed') ? 1 : 0]),
    };
    const { hits } = await searchTranscripts('gradient headline crypto', { projectDir: PROJECT_DIR, stores: STORES, semantic });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('gradient');
  });

  it('degrades to lexical ranking when the reranker throws', async () => {
    const broken = { model: 'broken', embed: async () => { throw new Error('model unavailable'); } };
    const { hits } = await searchTranscripts('boxed card variant rejected', { projectDir: PROJECT_DIR, stores: STORES, semantic: broken });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].role).toBe('user');
  });

  it('reports coverage as a count, not just as a flag', async () => {
    // The starved pass needs real work to leave undone. A file whose size matches the stored
    // offset is skipped without being opened and without consulting the deadline, so a zero
    // budget against an already-warm archive legitimately COMPLETES — correct behaviour, and
    // the reason this has to add unindexed material rather than just starve the clock.
    await fs.writeFile(path.join(sessionDir, 'session-coverage.jsonl'),
      assistantLine('fresh unindexed material for the coverage assertion', '2026-01-09T00:00:00Z'));

    const starved = await ensureTranscriptIndex(PROJECT_DIR, STORES, 0);
    expect(starved.complete).toBe(false);
    // The number is the point: "incomplete" alone cannot tell a caller how much was missed.
    expect(starved.filesPending).toBeGreaterThan(0);
    expect(starved.filesPending).toBeLessThanOrEqual(starved.filesScanned);

    const full = await ensureTranscriptIndex(PROJECT_DIR, STORES);
    expect(full.complete).toBe(true);
    expect(full.filesPending).toBe(0);
  });

  it('calls a fruitless search against a partial archive inconclusive, not empty', async () => {
    // The distinction the old code could not draw. Zero hits against an archive that was only
    // partly searched does not mean absent, and returning an empty list said it did.
    // Same reason as above: the starved pass must have genuinely unindexed material to leave.
    await fs.writeFile(path.join(sessionDir, 'session-inconclusive.jsonl'),
      assistantLine('further unindexed material so the starved pass stays incomplete', '2026-01-10T00:00:00Z'));

    const partial = await searchTranscripts('nonexistentnonsenseterm', {
      projectDir: PROJECT_DIR, stores: STORES, indexBudgetMs: 0,
    });
    expect(partial.hits).toHaveLength(0);
    expect(partial.indexComplete).toBe(false);
    expect(partial.inconclusive).toBe(true);

    // Hits are a real answer even on partial coverage: the caller has something concrete,
    // and filesPending tells them more may exist.
    const found = await searchTranscripts('boxed card variant rejected', {
      projectDir: PROJECT_DIR, stores: STORES, indexBudgetMs: 0,
    });
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.inconclusive).toBe(false);

    // And on a complete index, absence IS trustworthy — it must not refuse here.
    const complete = await searchTranscripts('nonexistentnonsenseterm', { projectDir: PROJECT_DIR, stores: STORES });
    expect(complete.hits).toHaveLength(0);
    expect(complete.indexComplete).toBe(true);
    expect(complete.inconclusive).toBe(false);
  });

  // The reason index-time embeddings exist. Re-ranking a lexical shortlist can
  // only reorder what BM25 found, so a message that shares NO word with the
  // query was unreachable however good the embedder was. This is that message.
  it('finds a message with no lexical overlap with the query at all', async () => {
    await fs.appendFile(path.join(sessionDir, 'session-one.jsonl'),
      assistantLine('the mallard prefers still water', '2026-01-11T00:00:00Z'));
    await ensureTranscriptIndex(PROJECT_DIR, STORES);

    // A stub embedder that only agrees on one thing: this query and that
    // message mean the same. Nothing lexical connects them.
    const semantic = {
      model: 'duck-model',
      embed: async (texts: string[]) => texts.map(text =>
        /mallard|waterfowl/.test(text) ? [1, 0] : [0, 1]),
    };

    const lexicalOnly = await searchTranscripts('waterfowl', { projectDir: PROJECT_DIR, stores: STORES });
    expect(lexicalOnly.hits).toHaveLength(0);

    const fused = await searchTranscripts('waterfowl', { projectDir: PROJECT_DIR, stores: STORES, semantic });
    expect(fused.hits.map(hit => hit.snippet).join(' ')).toContain('mallard');
    expect(fused.vectorsEmbedded).toBeGreaterThan(0);
  });

  it('embeds within a budget and resumes, rather than blocking on a large archive', async () => {
    const { embedTranscripts, transcriptVectorStats } = await import('../../src/store/transcript-vectors.js');
    const embedder = { model: 'budget-model', embed: async (texts: string[]) => texts.map(() => [1, 0]) };

    // More messages than one batch can hold, or a zero budget would finish the
    // archive outright and prove nothing about stopping partway.
    let bulk = '';
    for (let i = 0; i < 40; i++) bulk += assistantLine(`bulk message number ${i}`, '2026-01-12T00:00:00Z');
    await fs.appendFile(path.join(sessionDir, 'session-one.jsonl'), bulk);
    await ensureTranscriptIndex(PROJECT_DIR, STORES);

    // A zero budget still embeds one batch: the deadline is checked per batch,
    // so the guarantee is bounded work, not zero work.
    const first = await embedTranscripts(PROJECT_DIR, embedder, { budgetMs: 0 });
    expect(first.embedded).toBeGreaterThan(0);
    expect(first.complete).toBe(false);
    expect(first.remaining).toBeGreaterThan(0);

    const second = await embedTranscripts(PROJECT_DIR, embedder, { budgetMs: 30_000 });
    expect(second.complete).toBe(true);
    const stats = await transcriptVectorStats(PROJECT_DIR, embedder.model);
    expect(stats.embedded).toBe(stats.total);

    // Re-running finds nothing to do: coverage is the resume state, so an
    // interrupted pass leaves no bookkeeping to repair.
    const third = await embedTranscripts(PROJECT_DIR, embedder, { budgetMs: 30_000 });
    expect(third.embedded).toBe(0);
  });

  it('quantized vectors rank the same way the float vectors did', async () => {
    const { quantize } = await import('../../src/store/transcript-vectors.js');
    // Unit-norm vectors at 8 dims, the shape the scale constant assumes.
    const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
    const query = norm([0.9, 0.4, 0.1, 0, 0, 0, 0, 0]);
    const near = norm([0.85, 0.45, 0.15, 0, 0, 0, 0, 0]);
    const far = norm([0, 0, 0, 0.3, 0.9, 0.2, 0, 0]);

    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
    const qi = new Int8Array(quantize(query).buffer);
    const ints = (v: number[]) => {
      const d = new Int8Array(quantize(v).buffer);
      let sum = 0;
      for (let i = 0; i < qi.length; i++) sum += qi[i] * d[i];
      return sum;
    };

    expect(dot(query, near)).toBeGreaterThan(dot(query, far));
    expect(ints(near)).toBeGreaterThan(ints(far));
  });
});
