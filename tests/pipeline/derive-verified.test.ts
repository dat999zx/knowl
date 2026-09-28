import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The full shape `tests/pipeline/pipeline.test.ts` mocks: a partial mock fails any transitive
// import of another export.
vi.mock('../../src/ai/provider.js', () => ({
  initAI: vi.fn(),
  filterInput: vi.fn(),
  extractKnowledge: vi.fn(),
  compareKnowledge: vi.fn(),
  askQuestion: vi.fn(),
  deriveTruth: vi.fn(),
}));

import { deriveTruth } from '../../src/ai/provider.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runDeriveTruth } from '../../src/pipeline/derive.js';

const ROOT = path.resolve('./.knowl-derive-verified-test');
let projectId = '';

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'derive')).id;
});
afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

describe('runDeriveTruth (#165)', () => {
  it('does not overwrite a verified state item', async () => {
    const state = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'db engine', content: 'PostgreSQL 16', provenance: 'user_stated',
    });
    const source = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Production database engine', content: 'MySQL 5.7',
    });
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'db engine', value: 'MySQL 5.7' }]);

    await runDeriveTruth(projectId, [source]);

    expect((await repo.getKnowledgeItem(state.id))!.content).toBe('PostgreSQL 16');
  });

  it('still overwrites an unverified state item', async () => {
    const state = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'cache ttl', content: '5 minutes',
    });
    const source = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Cache layer', content: 'Hot reads cached for 10 minutes.',
    });
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'cache ttl', value: '10 minutes' }]);

    await runDeriveTruth(projectId, [source]);

    expect((await repo.getKnowledgeItem(state.id))!.content).toBe('10 minutes');
  });

  it('does not overwrite an unverified exclusive state item', async () => {
    const state = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'queue broker', content: 'RabbitMQ',
      conflictKey: 'queue.broker', conflictExclusive: true,
    });
    const source = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Message queue', content: 'Jobs are queued on Redis streams.',
    });
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'queue broker', value: 'Redis' }]);

    await runDeriveTruth(projectId, [source]);

    expect((await repo.getKnowledgeItem(state.id))!.content).toBe('RabbitMQ');
  });
});
