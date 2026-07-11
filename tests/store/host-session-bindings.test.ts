import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import {
  closeHostSessionBinding,
  closeHostSessionBindings,
  findHostSession,
  getOrCreateHostSession,
} from '../../src/store/host-session-bindings.js';
import { finishMemorySession } from '../../src/store/session-repository.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-host-session-bindings-test');

describe('host session bindings', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Host bindings')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('idempotently reuses one active session for an external turn', async () => {
    const input = {
      projectId,
      projectRoot: ROOT,
      host: 'generic',
      externalSessionId: 'session-1',
      externalTurnId: 'turn-1',
      title: 'Agent turn',
    };
    const first = await getOrCreateHostSession(input);
    const reused = await getOrCreateHostSession({ ...input, title: 'ignored' });

    expect(first.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(reused.session.id).toBe(first.session.id);
    await expect(findHostSession(input)).resolves.toMatchObject({ id: first.session.id, status: 'active' });
  });

  it('rotates bindings after a turn finishes', async () => {
    const input = {
      projectId,
      projectRoot: ROOT,
      host: 'generic',
      externalSessionId: 'session-2',
      externalTurnId: 'turn-1',
      title: 'First turn',
    };
    const first = await getOrCreateHostSession(input);
    await finishMemorySession(first.session.id, 'finished');
    await closeHostSessionBinding(input);
    expect(await findHostSession(input)).toBeNull();

    const second = await getOrCreateHostSession({ ...input, title: 'Second turn' });
    expect(second.created).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it('closes every active turn for one external host session', async () => {
    const base = { projectId, projectRoot: ROOT, host: 'cursor', externalSessionId: 'session-3', title: 'Cursor turn' };
    await getOrCreateHostSession({ ...base, externalTurnId: 'turn-a' });
    await getOrCreateHostSession({ ...base, externalTurnId: 'turn-b' });

    expect(await closeHostSessionBindings(base)).toBe(2);
    await expect(findHostSession({ ...base, externalTurnId: 'turn-a' })).resolves.toBeNull();
    await expect(findHostSession({ ...base, externalTurnId: 'turn-b' })).resolves.toBeNull();
  });
});
