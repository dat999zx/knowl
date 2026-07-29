import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import {
  readHostSeenPeerCommits,
  setHostSeenPeerCommits,
  type HostSessionKey,
} from '../../src/store/host-session-bindings.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-fedchange-home');
const LOCAL = path.resolve('./.knowl-fedchange-local');
const PEER = path.resolve('./.knowl-fedchange-peer');

let projectId = '';
let sharedId = '';
let privateId = '';
let tick = 0;

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'claude',
  event: 'turn-start',
  externalSessionId: 'fed-session',
  externalTurnId: 'fed-turn',
  projectRoot: LOCAL,
  payload: {},
  ...input,
});

/** A tool event. The payload varies so the capture debounce never folds two together. */
const toolEvent = () => handleHostLifecycleEvent(projectId, hook({
  event: 'session-event',
  type: 'command',
  payload: { command: `npm test --run=${tick++}`, exitCode: 0 },
}));

const cardFrom = (result: Awaited<ReturnType<typeof toolEvent>>): string =>
  String((result.hostOutput as any)?.hookSpecificOutput?.additionalContext ?? '');

async function seed(root: string, name: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const id = (await repo.createProject(root, name)).id;
  if (name === 'peer') {
    const shared = await storeKnowledgeItemDeduped(id, {
      category: 'decision', title: 'Auth token TTL is fifteen minutes',
      content: 'Access tokens expire after fifteen minutes.',
    });
    const secret = await storeKnowledgeItemDeduped(id, {
      category: 'fact', title: 'Peer private scratch note',
      content: 'Never leaves the peer repo.',
    });
    sharedId = shared.item.id;
    privateId = secret.item.id;
    await getClient().execute({
      sql: "UPDATE knowledge_items SET visibility = 'workspace', origin_repo = 'peer' WHERE id = ?",
      args: [sharedId],
    });
  } else {
    projectId = id;
    // Commit history before the binding is made. `seen_commit_rowid = 0` is the
    // "uninitialised" sentinel, so a repo bound at zero commits adopts its first commit
    // silently -- real about a fresh repo, but not the case under test here.
    await repo.createKnowledgeCommit(id, 'Baseline', [
      { itemId: 'baseline', action: 'insert', after: { id: 'baseline', category: 'fact', title: 'Baseline local item' } },
    ]);
  }
  await closeDb();
}

/** Commit into the peer's own database, then hand the ambient connection back. */
async function commitInPeer(message: string, changes: Parameters<typeof repo.createKnowledgeCommit>[2]): Promise<void> {
  await closeDb();
  await initDb(PEER);
  await repo.createKnowledgeCommit('local', message, changes);
  await closeDb();
  await initDb(LOCAL);
}

describe('federated change notification', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, LOCAL, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(LOCAL, 'local');
    await seed(PEER, 'peer');
    await joinWorkspace({ projectRoot: LOCAL, workspaceName: 'ws', repoName: 'local' });
    await joinWorkspace({ projectRoot: PEER, workspaceName: 'ws', repoName: 'peer' });
    await initDb(LOCAL);
    await handleHostLifecycleEvent(projectId, hook({ title: 'Agent turn' }));
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, LOCAL, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('adopts peer heads silently on the first tool event', async () => {
    const result = await toolEvent();
    expect(cardFrom(result)).not.toContain('KNOWL CHANGED');

    const key: HostSessionKey = {
      host: 'claude', projectRoot: LOCAL, externalSessionId: 'fed-session', externalTurnId: 'fed-turn',
    };
    expect(await readHostSeenPeerCommits(key)).toMatchObject({ peer: expect.any(Number) });
  });

  it('reports a peer repo change, tagged with the repo that made it', async () => {
    await commitInPeer('Peer changed the TTL', [
      { itemId: sharedId, action: 'update', after: { id: sharedId, category: 'decision', title: 'Auth token TTL is five minutes' } },
    ]);

    const card = cardFrom(await toolEvent());
    expect(card).toContain('KNOWL CHANGED');
    expect(card).toContain('[peer]');
    expect(card).toContain('Auth token TTL is five minutes');
  });

  it('reports each peer change once', async () => {
    expect(cardFrom(await toolEvent())).not.toContain('KNOWL CHANGED');
  });

  it('never leaks a peer repo-private change', async () => {
    await commitInPeer('Peer changed something private', [
      { itemId: privateId, action: 'update', after: { id: privateId, category: 'fact', title: 'Peer private scratch note' } },
    ]);

    const card = cardFrom(await toolEvent());
    expect(card).not.toContain('scratch');
    expect(card).not.toContain('KNOWL CHANGED');
  });

  it('merges a local and a peer change into one card', async () => {
    await commitInPeer('Peer moved again', [
      { itemId: sharedId, action: 'update', after: { id: sharedId, category: 'decision', title: 'Auth token TTL is one minute' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Sibling wrote locally', [
      { itemId: 'local-1', action: 'insert', after: { id: 'local-1', category: 'fact', title: 'Local sibling item' } },
    ]);

    const card = cardFrom(await toolEvent());
    expect(card).toContain('KNOWL CHANGED: 2 items');
    // Local first, peer after, and only the peer line carries a repo tag.
    expect(card).toContain('- fact: Local sibling item');
    expect(card).toContain('- [peer] decision (update): Auth token TTL is one minute');
  });

  it('retries a peer window rather than skipping it when the peer is unreadable', async () => {
    const key: HostSessionKey = {
      host: 'claude', projectRoot: LOCAL, externalSessionId: 'fed-session', externalTurnId: 'fed-turn',
    };
    const stored = await readHostSeenPeerCommits(key);
    await commitInPeer('Peer change to replay', [
      { itemId: sharedId, action: 'update', after: { id: sharedId, category: 'decision', title: 'Auth token TTL is replayed' } },
    ]);

    // Rewind this session's watermark: the same effect as a window that failed to load.
    await setHostSeenPeerCommits(key, stored!);
    expect(cardFrom(await toolEvent())).toContain('Auth token TTL is replayed');
  });
});
