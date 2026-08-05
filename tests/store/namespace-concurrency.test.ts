import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb, withDbPath } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';

const TEST_ROOT = path.resolve('./.knowl-namespace-concurrency-test');
const SESSION_DB = path.resolve('./.knowl-namespace-concurrency-session.db');

async function openFile(): Promise<string> {
  return String((await getClient().execute('PRAGMA database_list')).rows[0]?.file ?? '');
}

describe('namespace switching under concurrency', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${SESSION_DB}${suffix}`, { force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${SESSION_DB}${suffix}`, { force: true }).catch(() => {});
  });

  it('keeps a project write in the project database while a namespace switch is in flight', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Concurrency');

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });

    const switched = withDbPath(SESSION_DB, async () => {
      entered();
      await releasePromise;
    });

    await enteredPromise;
    await repo.createKnowledgeItem(project.id, {
      category: 'fact',
      title: 'Expected project write',
      content: 'Issued while a namespace switch was open.',
    });
    release();
    await switched;

    expect((await repo.listKnowledgeItems()).map(entry => entry.title)).toContain('Expected project write');

    let sessionTitles: string[] = [];
    await withDbPath(SESSION_DB, async () => {
      sessionTitles = (await repo.listKnowledgeItems()).map(entry => entry.title);
    });
    expect(sessionTitles).not.toContain('Expected project write');
  });

  it('reads the switched database inside the callback and the project database outside it', async () => {
    let inside = '';
    await withDbPath(SESSION_DB, async () => { inside = await openFile(); });
    expect(inside).toContain('namespace-concurrency-session');
    expect(await openFile()).toContain('.knowl-namespace-concurrency-test');
  });

  it('runs a transaction inside a namespace scope against that namespace', async () => {
    const { withClientTransaction } = await import('../../src/store/database.js');
    let inside = '';
    await withDbPath(SESSION_DB, async () => {
      await withClientTransaction(async () => { inside = await openFile(); });
    });
    expect(inside).toContain('namespace-concurrency-session');
  });
});
