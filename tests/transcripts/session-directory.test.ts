import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { bindHostSession } from '../../src/session/host-session-bindings.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import { listSessionDirectory } from '../../src/transcripts/session-directory.js';

let dir: string;
let projectRoot: string;
let emptyRoot: string;

describe('listSessionDirectory', () => {
  let projectId = '';

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-dir-'));
    projectRoot = path.join(dir, 'repo');
    emptyRoot = path.join(dir, 'empty');
    await fs.mkdir(path.join(projectRoot, '.knowl'), { recursive: true });
    await fs.mkdir(path.join(emptyRoot, '.knowl'), { recursive: true });
    await initDb(projectRoot);
    projectId = (await repo.createProject(projectRoot, 'Session directory')).id;
  });

  afterAll(async () => {
    await closeTranscriptDbs();
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM host_session_bindings`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await db.run(sql`DELETE FROM memory_sessions`);

    const client = await openTranscriptDb(resolveStorage(projectRoot).transcripts);
    await client.execute('DELETE FROM transcript_files');
    await client.execute('DELETE FROM transcript_messages');
    // What the last pass reported about itself is index-wide state, so it outlives a row wipe
    // and would otherwise leak between tests.
    await client.execute('DELETE FROM transcript_index_state').catch(() => {});
  });

  async function seedSession(sessionId: string, options: {
    name?: string;
    opening?: string;
    lastActive?: string;
    messages?: Array<{ role: 'user' | 'assistant'; text: string }>;
    bytesIndexed?: number;
    sizeAtIndex?: number;
    parent?: string;
  } = {}) {
    const client = await openTranscriptDb(resolveStorage(projectRoot).transcripts);
    const filePath = `/archive/${sessionId}.jsonl`;
    await client.execute({
      sql: `INSERT INTO transcript_files
        (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, display_name, name_kind, opening)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        filePath, sessionId, options.parent ?? null,
        options.bytesIndexed ?? 100, 10, options.sizeAtIndex ?? 100,
        '2026-08-03T00:00:00Z', options.name ?? null, options.name ? 3 : 0, options.opening ?? null,
      ],
    });

    const messages = options.messages ?? [{ role: 'user' as const, text: 'hello' }];
    let line = 1;
    for (const message of messages) {
      await client.execute({
        sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          filePath, sessionId, options.parent ?? null, line++, message.role,
          message.text.length, options.lastActive ?? '2026-08-02T00:00:00Z',
        ],
      });
    }
  }

  /** A promoted atom, joined the way the product joins it: binding -> session -> item ids. */
  async function seedPromotion(sessionId: string, title: string) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title, content: `${title}, in detail.`,
    } as never);
    const session = await startMemorySession({ title: `work in ${sessionId}` });
    await bindHostSession({ projectRoot, host: 'claude', externalSessionId: sessionId }, session.id);
    await getClient().execute({
      sql: "UPDATE memory_sessions SET promotion_status = 'promoted', promotion_items = ? WHERE id = ?",
      args: [JSON.stringify([item.id]), session.id],
    });
  }

  /** A session card: an ordinary atom the session stored about its own purpose. */
  async function seedCard(sessionId: string, content: string, at?: string) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: `Session card for ${sessionId}`, content,
      tags: ['session-card', `session:${sessionId}`],
    } as never);
    if (at) {
      await getClient().execute({
        sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
        args: [at, item.id],
      });
    }
  }

  it('lists sessions newest first with names from the transcript itself', async () => {
    await seedSession('older', { name: 'older-work', lastActive: '2026-08-01T00:00:00Z' });
    await seedSession('newer', { name: 'newer-work', lastActive: '2026-08-03T00:00:00Z' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions.map(s => s.sessionId)).toEqual(['newer', 'older']);
    expect(sessions[0].name).toBe('newer-work');
  });

  it('includes unnamed sessions, described by their opening ask', async () => {
    await seedSession('unnamed', { opening: 'why did the reindex run out of memory?' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeNull();
    expect(sessions[0].opening).toBe('why did the reindex run out of memory?');
  });

  it('answers "which session was about X" with a keyword filter', async () => {
    await seedSession('ui', { name: 'ui-trial-screen' });
    await seedSession('db', { name: 'database-migration' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'ui' });

    expect(sessions.map(s => s.sessionId)).toEqual(['ui']);
  });

  it('matches the opening ask and the card, not message bodies', async () => {
    await seedSession('a', { opening: 'a question about caching' });
    await seedSession('b', { name: 'unrelated', messages: [{ role: 'user', text: 'caching appears only here' }] });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'caching' });

    expect(sessions.map(s => s.sessionId)).toEqual(['a']);
  });

  it('requires every query token to appear somewhere across the intent fields', async () => {
    await seedSession('both', { name: 'reindex work', opening: 'about memory limits' });
    await seedSession('half', { name: 'reindex work', opening: 'about something else' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'reindex memory' });

    expect(sessions.map(s => s.sessionId)).toEqual(['both']);
  });

  it('surfaces knowledge a session promoted, joined through the lifecycle chain', async () => {
    await seedSession('promoter', { name: 'promoter' });
    await seedPromotion('promoter', 'Size embedding batches by text length');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions[0].promoted).toContain('Size embedding batches by text length');
  });

  it('surfaces a declared session card and matches it in the filter', async () => {
    await seedSession('carded', { name: 'carded' });
    await seedCard('carded', 'Investigating the OOM in reindex');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'OOM' });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].card).toBe('Investigating the OOM in reindex');
  });

  it('takes the newest card when a session declared more than one', async () => {
    await seedSession('carded', { name: 'carded' });
    await seedCard('carded', 'First intent', '2026-08-01T00:00:00Z');
    await seedCard('carded', 'Revised intent', '2026-08-03T00:00:00Z');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions[0].card).toBe('Revised intent');
  });

  it('does not cap the number of sessions returned', async () => {
    for (let i = 0; i < 60; i++) await seedSession(`s-${i}`, { name: `session ${i}` });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions).toHaveLength(60);
  });

  it('reports an incomplete index rather than implying the list is whole', async () => {
    await seedSession('a', { name: 'a', bytesIndexed: 10, sizeAtIndex: 999 });

    const { indexComplete } = await listSessionDirectory({ projectId, projectRoot });

    expect(indexComplete).toBe(false);
  });

  // K-32. Completeness was computed over the rows that exist -- and a file the pass never
  // reached has no row at all. So a listing that is missing whole sessions reported itself
  // whole, and the caller reads "no sessions match" as proof of absence.
  it('reports incomplete when the last pass never reached some transcripts', async () => {
    const archive = path.join(dir, 'archive');
    const encoded = path.join(archive, encodeProjectDir(path.resolve(projectRoot)));
    await fs.mkdir(encoded, { recursive: true });
    const entry = (text: string) =>
      JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';
    const dbPath = resolveStorage(projectRoot).transcripts;

    await fs.writeFile(path.join(encoded, 'first.jsonl'), entry('an indexed session'));
    await runIndexPass({ projectRoot, dbPath, projectsDir: archive });

    await fs.writeFile(path.join(encoded, 'second.jsonl'), entry('a session never reached'));
    await runIndexPass({ projectRoot, dbPath, projectsDir: archive, deadline: Date.now() - 1 });

    const { sessions, indexComplete } = await listSessionDirectory({ projectId, projectRoot });

    // The premise: a whole session is missing from the listing, and every row that exists
    // says it is fully indexed.
    expect(sessions.map(s => s.sessionId)).toEqual(['first']);
    expect(indexComplete).toBe(false);
  });

  it('returns nothing and reports incomplete when there is no index', async () => {
    const result = await listSessionDirectory({ projectId, projectRoot: emptyRoot });

    expect(result.sessions).toEqual([]);
    expect(result.indexComplete).toBe(false);
  });

  it('does not create an index file when there is none to read', async () => {
    await listSessionDirectory({ projectId, projectRoot: emptyRoot });

    // A writable open would resurrect a database the user deleted by turning the feature off.
    await expect(fs.access(resolveStorage(emptyRoot).transcripts)).rejects.toThrow();
  });

  it('counts messages and reports the last activity per session', async () => {
    await seedSession('counted', {
      name: 'counted',
      lastActive: '2026-08-02T12:00:00Z',
      messages: [
        { role: 'user', text: 'one' },
        { role: 'assistant', text: 'two' },
        { role: 'user', text: 'three' },
      ],
    });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions[0].messages).toBe(3);
    expect(sessions[0].lastActiveAt).toBe('2026-08-02T12:00:00Z');
  });
});
