import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import {
  resetWriteWorkspaceCache, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped,
} from '../../src/store/knowledge-writer.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * A caller that passes no `validationOptions` gets the project's own secret detectors.
 *
 * The plugin, the skill indexer and session-candidate promotion all called the writer with
 * nothing in the fourth slot, and each fell through to the built-in default -- `secretPatterns`
 * empty -- so the same atom was refused by `knowl store` and accepted by the plugin in one
 * repository. The default now lives in the writer, which every one of them passes through.
 */

let counter = 0;
let ROOT = '';

const CONFIGURED = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
  security: { rejectSecrets: true, secretPatterns: ['zzz-house-token'] },
};

describe('the security default on the write path', () => {
  let projectId = '';

  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteWorkspaceCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-wsec${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, CONFIGURED);
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, `wsec${counter}`)).id;
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteWorkspaceCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('a single write with no options is judged by the configured patterns', async () => {
    await expect(storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Deploy reads a house token', content: 'Boot reads zzz-house-token from the environment.',
    })).rejects.toThrow(/configured-pattern/i);

    const clean = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Deploy reads its settings', content: 'Boot takes every setting from the environment.',
    });
    expect(clean.action).toBe('inserted');
  });

  it('a batch write with no options is judged the same way', async () => {
    await expect(storeKnowledgeAtomsDeduped(projectId, [{
      category: 'fact', title: 'Batched house token', content: 'The value zzz-house-token is set at boot.',
    }])).rejects.toThrow(/configured-pattern/i);
  });

  it('explicit options still win over the project default', async () => {
    const relaxed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Deploy reads a house token', content: 'Boot reads zzz-house-token from the environment.',
    }, undefined, { secretPatterns: [] });
    expect(relaxed.action).toBe('inserted');
  });
});
