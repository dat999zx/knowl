import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { stagePublish } from '../../src/cloud/publish.js';
import { writeAutoPushConsent } from '../../src/cloud/consent.js';
import { clearCredential, writeCredential } from '../../src/cloud/credentials.js';
import { maybeAutoPush } from '../../src/cli/auto-push.js';
import type { ProjectConfig } from '../../src/core/types.js';

const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });
const API_HOST = 'https://api.knowl.test';

let run = 0;
let ORIGIN: string;
let CLONE: string;
let HOME: string;
let WS: string;
let connected: ProjectConfig;
let projectId: string;

describe('maybeAutoPush', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();

    run += 1;
    ORIGIN = path.resolve(`./.knowl-autopush-origin-${run}`);
    CLONE = path.resolve(`./.knowl-autopush-clone-${run}`);
    HOME = path.resolve(`./.knowl-autopush-home-${run}`);
    WS = `ws-autopush-${run}`;
    process.env.KNOWL_HOME = HOME;
    await fs.mkdir(HOME, { recursive: true });

    connected = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin', autoStage: false,
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
    projectId = (await repo.createProject(CLONE, 'autopush')).id;
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Queued', content: 'Something worth sending, at a believable length.',
    });
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'github.com/acme/web'");
    await closeDb();

    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [stored.item.id], apply: true });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    delete process.env.KNOWL_HOME;
    await clearCredential(API_HOST).catch(() => {});
    for (const dir of [ORIGIN, CLONE, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('does not send without consent', async () => {
    expect(await maybeAutoPush({ projectRoot: CLONE, config: connected }))
      .toEqual({ status: 'skipped', reason: 'no-consent' });
  });

  it('does not send when the repo is not connected', async () => {
    expect(await maybeAutoPush({ projectRoot: CLONE, config: { version: 1 } }))
      .toEqual({ status: 'skipped', reason: 'not-connected' });
  });

  it('is not stopped by a feature branch, so the branch no longer decides what is sent', async () => {
    await writeAutoPushConsent(WS, true);
    git(CLONE, ['checkout', '-qb', 'feature/whatever']);

    // The queue is emptied so this asserts about the BRANCH and nothing else: reaching
    // `nothing-staged` proves the push ran and looked, where the gate used to refuse before
    // looking at all. It also keeps the case offline -- `maybeAutoPush` takes no injectable api.
    await initDb(CLONE);
    try { await getClient().execute('DELETE FROM cloud_published'); }
    finally { await closeDb(); }

    expect(await maybeAutoPush({ projectRoot: CLONE, config: connected }))
      .toEqual({ status: 'skipped', reason: 'nothing-staged' });
  });

  it('reports nothing-staged rather than attempting an empty send', async () => {
    await writeAutoPushConsent(WS, true);
    await initDb(CLONE);
    try { await getClient().execute('DELETE FROM cloud_published'); }
    finally { await closeDb(); }

    expect(await maybeAutoPush({ projectRoot: CLONE, config: connected }))
      .toEqual({ status: 'skipped', reason: 'nothing-staged' });
  });

  it('consent is per workspace, so another workspace does not inherit it', async () => {
    await writeAutoPushConsent('some-other-workspace', true);

    expect(await maybeAutoPush({ projectRoot: CLONE, config: connected }))
      .toEqual({ status: 'skipped', reason: 'no-consent' });
  });
});
