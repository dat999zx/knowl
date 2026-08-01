import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-search-synonym-guard');

// The synonym table is an object literal, so a token that names an inherited
// Object.prototype member resolves to that member rather than to undefined. The
// member is truthy and not iterable, so the expansion loop throws. Error text and
// commit bodies routinely contain "constructor", and this path runs inside session
// finalization, where a throw loses the whole session's capture.
const PROTOTYPE_TOKENS = ['constructor', '__proto__'];

describe('search synonym expansion ignores inherited prototype members', () => {
  let projectId = '';

  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });

    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'p')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Constructor injection wires the container',
      content: 'The constructor receives every dependency the service needs.',
    });
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it.each(PROTOTYPE_TOKENS)('does not throw on the token %s', async (token) => {
    await expect(searchKnowledgeItems('local', { query: `${token} injection`, limit: 5 })).resolves.toBeDefined();
  });

  it('still returns the match for a query containing such a token', async () => {
    const found = await searchKnowledgeItems('local', { query: 'constructor injection', limit: 5 });

    expect(found.map((item) => item.title)).toContain('Constructor injection wires the container');
  });

  it('still expands a real synonym, so the guard did not disable the table', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Persistence layer uses libSQL',
      content: 'Rows are written through the libSQL client.',
    });

    // No seeded item contains "database", and the query carries no other token, so
    // only the synonym expansion to "persistence" can find this.
    const found = await searchKnowledgeItems('local', { query: 'database', limit: 5 });

    expect(found.map((item) => item.title)).toContain('Persistence layer uses libSQL');
  });
});
