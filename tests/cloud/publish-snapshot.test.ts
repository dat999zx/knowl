import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { computePushSnapshot, pushStaged, stagePublish } from '../../src/cloud/publish.js';
import type { CloudApi } from '../../src/cloud/api-client.js';
import { clearCredential, writeCredential } from '../../src/cloud/credentials.js';
import type { ProjectConfig } from '../../src/core/types.js';

const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });

let run = 0;
let ORIGIN: string;
let CLONE: string;
let WS: string;
let connected: ProjectConfig;
let projectId: string;

/** Records the titles the client actually sent, which is what every case here asks about. */
function recordingApi(sent: string[]): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending',
    refresh: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00.000Z', sessionId: 's' }),
    listWorkspaces: async () => [],
    me: async () => ({ email: 'dev@example.com', displayName: 'Dev' }),
    fetchSyncPage: async () => ({ rows: [], nextCursor: null, latestSeq: '0' }) as never,
    publishItems: async ({ items }) => {
      for (const item of items) sent.push(item.title);
      return {
        outcomes: items.map(item => ({ id: item.id, status: 'created' as const, version: 1 })),
        commitId: 'c1',
      };
    },
    updateItem: async () => ({ outcome: null }),
  } as CloudApi;
}

describe('a push bound to a snapshot', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();

    run += 1;
    ORIGIN = path.resolve(`./.knowl-snapshot-origin-${run}`);
    CLONE = path.resolve(`./.knowl-snapshot-clone-${run}`);
    WS = `ws-snapshot-${run}`;
    connected = {
      version: 1,
      cloud: {
        apiHost: 'https://api.knowl.test', workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
        // Off, so each case stages exactly what it means to rather than racing the seam.
        autoStage: false,
      },
    };

    await fs.mkdir(ORIGIN, { recursive: true });
    git(ORIGIN, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'one', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'one']);
    git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);

    await fs.mkdir(path.join(CLONE, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(CLONE, '.knowl', 'config.json'), JSON.stringify(connected), 'utf8');
    await initDb(CLONE);
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    projectId = (await repo.createProject(CLONE, 'snapshot')).id;
    await closeDb();

    await writeCredential('https://api.knowl.test', {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await clearCredential('https://api.knowl.test').catch(() => {});
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const seed = async (title: string): Promise<string> => {
    await initDb(CLONE);
    try {
      const stored = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title, content: `A durable observation about ${title}, long enough to be real.`,
      });
      await getClient().execute("UPDATE knowledge_items SET origin_repo = 'github.com/acme/web'");
      // A vector under this repo's current profile. `pushStaged` reads one rather than computing
      // it, and refuses any atom that has none -- so without this every case here stops at
      // `needs-embedding` instead of exercising the snapshot binding it is about.
      //
      // Written directly rather than embedded: these tests are about the push protocol, and a
      // real forward pass per atom would add a model download to a suite that needs no model.
      const { fingerprintProfile, resolveVectorProfile } = await import('../../src/core/vector-profile.js');
      const { upsertKnowledgeEmbeddings } = await import('../../src/store/vector.js');
      const profile = resolveVectorProfile(connected);
      await upsertKnowledgeEmbeddings([{
        knowledgeItemId: stored.item.id,
        provider: profile.provider,
        model: profile.model,
        profileFingerprint: fingerprintProfile(profile),
        dimensions: 384,
        vector: new Array(384).fill(0.02),
      }]);
      return stored.item.id;
    } finally { await closeDb(); }
  };

  const editContent = async (id: string, content: string): Promise<void> => {
    await initDb(CLONE);
    try {
      const { updateKnowledgeItemWithCommit } = await import('../../src/store/knowledge-actions.js');
      await updateKnowledgeItemWithCommit(projectId, id, { content });
    } finally { await closeDb(); }
  };

  it('sends only what the snapshot listed, ignoring an atom staged afterwards', async () => {
    const first = await seed('first');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [first], apply: true });
    const snapshot = await computePushSnapshot({ projectRoot: CLONE, config: connected });

    // Another process stages something while the prompt is open.
    const second = await seed('second');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [second], apply: true });

    const sent: string[] = [];
    const result = await pushStaged({ projectRoot: CLONE, config: connected, snapshot, api: recordingApi(sent) });

    expect(result.status).toBe('pushed');
    expect(sent).toEqual(['first']);
  });

  it('refuses when a listed atom changed under the prompt', async () => {
    const id = await seed('edited');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });
    const snapshot = await computePushSnapshot({ projectRoot: CLONE, config: connected });

    await editContent(id, 'Rewritten entirely while the prompt was open, saying something else.');

    const sent: string[] = [];
    const result = await pushStaged({ projectRoot: CLONE, config: connected, snapshot, api: recordingApi(sent) });

    expect(result.status).toBe('snapshot-stale');
    expect(result.status === 'snapshot-stale' && result.changed).toEqual([id]);
    expect(sent).toEqual([]);
  });

  it('reports an addition as stale under strict, rather than silently dropping it', async () => {
    const first = await seed('first');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [first], apply: true });
    const snapshot = await computePushSnapshot({ projectRoot: CLONE, config: connected });

    const second = await seed('second');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [second], apply: true });

    const sent: string[] = [];
    const result = await pushStaged({
      projectRoot: CLONE, config: connected, snapshot, strict: true, api: recordingApi(sent),
    });

    expect(result.status).toBe('snapshot-stale');
    expect(result.status === 'snapshot-stale' && result.added).toEqual([second]);
    expect(sent).toEqual([]);
  });

  it('sends the bytes the snapshot captured, not a fresh read of the row', async () => {
    // The second window a hash-only snapshot leaves open: even when the comparison passes, a
    // separate load at send time can pick up content written since. Only sending the captured
    // payload survives this, so the assertion is on what arrived, not on the verdict.
    const id = await seed('captured');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });
    const snapshot = await computePushSnapshot({ projectRoot: CLONE, config: connected });

    // Rewrite the title WITHOUT moving either hash, by writing the column directly.
    await initDb(CLONE);
    try {
      await getClient().execute({
        sql: 'UPDATE knowledge_items SET title = ? WHERE id = ?',
        args: ['tampered', id],
      });
    } finally { await closeDb(); }

    const sent: string[] = [];
    await pushStaged({ projectRoot: CLONE, config: connected, snapshot, api: recordingApi(sent) });

    expect(sent).toEqual(['captured']);
  });

  it('without a snapshot, behaves exactly as before', async () => {
    const first = await seed('first');
    const second = await seed('second');
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [first, second], apply: true });

    const sent: string[] = [];
    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: recordingApi(sent) });

    expect(result.status).toBe('pushed');
    expect(sent.sort()).toEqual(['first', 'second']);
  });
});
