import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { readCommitHead } from '../../src/store/change-watermark.js';
import {
  bindHostSession,
  closeHostSessionBinding,
  closeHostSessionBindings,
  closeInactiveHostSessionBindings,
  findHostSession,
  getOrCreateHostSession,
  HostSessionKey,
  readHostSeenCommit,
  setHostSeenCommit,
} from '../../src/session/host-session-bindings.js';
import { finishMemorySession, startMemorySession } from '../../src/store/session-repository.js';
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

  // Windows paths are case-insensitive but case-preserving, and the same project reaches
  // us with different drive-letter case depending on the source: a hook payload's `cwd`
  // reports `D:\project` while `process.cwd()` reports `d:\project`. Keying on the
  // unfolded path split one agent across two binding rows, each with its own change
  // watermark, so a write advanced one row while the next tool event read the other,
  // found it stale, and reported the agent's own write back to it.
  it.skipIf(process.platform !== 'win32')('treats drive-letter case as the same project', async () => {
    const upper = ROOT.replace(/^([a-z]):/i, (_match, drive) => `${String(drive).toUpperCase()}:`);
    const lower = ROOT.replace(/^([a-z]):/i, (_match, drive) => `${String(drive).toLowerCase()}:`);
    expect(upper).not.toBe(lower);

    const input = {
      projectId,
      projectRoot: upper,
      host: 'generic',
      externalSessionId: 'drive-case-session',
      externalTurnId: 'turn-1',
      title: 'Agent turn',
    };
    const created = await getOrCreateHostSession(input);

    // The same agent, reached through the other casing, must resolve to one row.
    const viaLower = await findHostSession({ ...input, projectRoot: lower });
    expect(viaLower?.id).toBe(created.session.id);

    const head = await readCommitHead();
    await setHostSeenCommit({ ...input, projectRoot: upper }, head);
    expect(await readHostSeenCommit({ ...input, projectRoot: lower })).toBe(head);
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

  it('closes bindings whose memory sessions are terminal', async () => {
    const input = { projectId, projectRoot: ROOT, host: 'codex', externalSessionId: 'session-4', externalTurnId: '__session__', title: 'Codex session' };
    const started = await getOrCreateHostSession(input);
    await finishMemorySession(started.session.id, 'finished');

    expect(await closeInactiveHostSessionBindings()).toBeGreaterThanOrEqual(1);
    await expect(findHostSession(input)).resolves.toBeNull();
  });

  it('initialises the watermark to the current commit head when binding', async () => {
    await repo.createKnowledgeCommit(projectId, 'First commit', [
      { itemId: 'item-a', action: 'insert', after: { id: 'item-a', title: 'A' } },
    ]);
    const head = await readCommitHead();
    expect(head).toBeGreaterThan(0);

    const session = await startMemorySession({ title: 'Watermark bind' });
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-session',
      externalTurnId: '__agent__:agent-1',
    };
    await bindHostSession(key, session.id);

    expect(await readHostSeenCommit(key)).toBe(head);
  });

  it('advances and reads the watermark, and returns null for an unknown row', async () => {
    const session = await startMemorySession({ title: 'Watermark advance' });
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-advance-session',
      externalTurnId: '__agent__:agent-2',
    };
    await bindHostSession(key, session.id);

    await setHostSeenCommit(key, 99);
    expect(await readHostSeenCommit(key)).toBe(99);

    expect(await readHostSeenCommit({ ...key, externalTurnId: '__agent__:missing' })).toBeNull();
  });
});
