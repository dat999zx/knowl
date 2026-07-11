import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { bootstrapAgentSession } from '../../src/store/context-bootstrap.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-context-bootstrap-test');

describe('agent context bootstrap', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Context bootstrap')).id;
    await repo.createKnowledgeItem(projectId, { category: 'decision', title: 'Use SQLite', content: 'Project memory is stored locally in SQLite.' });
  });

  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('starts then reuses a session with bounded recent-context fallback', async () => {
    const started = await bootstrapAgentSession({ projectId, title: 'Implement context bootstrap', query: 'context retrieval', agent: 'codex' });
    const reused = await bootstrapAgentSession({ projectId, title: 'ignored after reuse', sessionId: started.session.id });

    expect(started.session).toMatchObject({ status: 'active', title: 'Implement context bootstrap', agent: 'codex' });
    expect(reused.session.id).toBe(started.session.id);
    expect(started.context).toContain('# KNOWL - RECENT SESSION CONTEXT');
    expect(started.context).toContain('Use SQLite');
    expect(started.context.length).toBeLessThanOrEqual(6_000);
  });
});
