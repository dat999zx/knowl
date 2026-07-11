import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve('./.knowl-temporal-cli-test');
const CLI = path.resolve('./dist/index.js');

describe('temporal CLI', () => {
  let itemId = '';
  let createdAt = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
    execSync(`node "${CLI}" init --yes`, { cwd: ROOT, encoding: 'utf8' });
    execSync(`node "${CLI}" decide "Temporal storage" "SQLite is active." -r "Temporal test"`, { cwd: ROOT, encoding: 'utf8' });
    const client = createClient({ url: `file:${path.join(ROOT, '.knowl', 'knowl.db')}` });
    const row = (await client.execute('SELECT id, created_at FROM knowledge_items WHERE title = ?', ['Temporal storage'])).rows[0];
    itemId = String(row.id); createdAt = String(row.created_at); client.close();
  }, 15_000);
  afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('prints an item timeline and supports an as-of query', () => {
    const timeline = JSON.parse(execSync(`node "${CLI}" timeline ${itemId}`, { cwd: ROOT, encoding: 'utf8' }));
    const asOf = JSON.parse(execSync(`node "${CLI}" query storage --as-of ${createdAt}`, { cwd: ROOT, encoding: 'utf8' }));
    expect(timeline).toEqual([expect.objectContaining({ knowledgeItemId: itemId, content: 'SQLite is active.' })]);
    expect(asOf).toEqual([expect.objectContaining({ id: itemId, content: 'SQLite is active.' })]);
  }, 15_000);
});
