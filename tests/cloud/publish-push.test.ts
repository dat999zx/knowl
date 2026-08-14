import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitArgs } from '../git-identity.js';
import { CloudApiError, type CloudApi, type CloudRole } from '../../src/cloud/api-client.js';
import type { PublishOutcome } from '../../src/cloud/sync-contract.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createEvidence, linkKnowledgeEvidence } from '../../src/store/evidence-repository.js';
import { listAssertions } from '../../src/store/assertions.js';
import { applySyncRows } from '../../src/cloud/sync-apply.js';
import { pushStaged, stagePublish } from '../../src/cloud/publish.js';
import { listStaged, publishedVersion, stageForPublish } from '../../src/cloud/ledger.js';
import { dropTeamStore, withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import { writeCredential, clearCredential } from '../../src/cloud/credentials.js';
import type { ProjectConfig } from '../../src/core/types.js';

const API_HOST = 'https://api.push.test';

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });

/**
 * Fresh directories and a fresh workspace id per test, rather than one pair wiped between them.
 *
 * Both halves are Windows-shaped. libSQL can hold the database file inside the clone, the `rm`
 * is then silently refused, and the next `git clone` into a non-empty directory fails -- leaving
 * the previous test's branch checked out and every later assertion failing for the wrong reason.
 * The replica is keyed on the workspace id and lives outside the clone entirely, so a role
 * recorded by one test would answer for every test after it.
 */
let run = 0;
let ORIGIN: string;
let CLONE: string;
let WS: string;
let connected: ProjectConfig;

let ids: { decision: string; fact: string };


/**
 * Gives every seeded atom a vector under this repo's CURRENT profile.
 *
 * `pushStaged` reads the vector rather than computing one, and refuses to send an atom that has
 * none -- so without this every case here would stop at `needs-embedding` instead of exercising
 * what it is about.
 *
 * Written directly rather than by embedding: these tests are about the publish protocol, and
 * running a real forward pass per atom would add a model download to a suite that needs no model
 * at all. The values are arbitrary; only their width and their fingerprint matter.
 */
async function seedEmbeddings(itemIds: string[]): Promise<void> {
  const { fingerprintProfile, resolveVectorProfile } = await import('../../src/core/vector-profile.js');
  const { upsertKnowledgeEmbeddings } = await import('../../src/store/vector.js');
  const profile = resolveVectorProfile(connected);
  await upsertKnowledgeEmbeddings(itemIds.map((id, index) => ({
    knowledgeItemId: id,
    provider: profile.provider,
    model: profile.model,
    profileFingerprint: fingerprintProfile(profile),
    dimensions: 384,
    vector: new Array(384).fill(0.01 * (index + 1)),
  })));
}

function fakeApi(outcomes: PublishOutcome[], onPublish?: (body: any) => void): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending' as const,
    refresh: async () => { throw new Error('unused'); },
    listWorkspaces: async () => [],
    fetchSyncPage: async () => { throw new Error('unused'); },
    publishItems: async (body: any) => { onPublish?.(body); return { outcomes, commitId: 'c1' }; },
    updateItem: async () => ({ outcome: null }),
  } as unknown as CloudApi;
}

async function commitToOrigin(name: string): Promise<void> {
  await fs.writeFile(path.join(ORIGIN, name), name, 'utf8');
  git(ORIGIN, ['add', '.']);
  git(ORIGIN, ['commit', '-qm', name]);
}

async function recordRole(role: CloudRole): Promise<void> {
  await withTeamStore(WS, CLONE, () => writeSyncState({
    apiHost: API_HOST, since: '1', cursor: null,
    lastSyncedAt: new Date().toISOString(), lastError: null, role,
  }));
}

const stagedIds = async (): Promise<string[]> => {
  await initDb(CLONE);
  try { return (await listStaged(WS)).map(row => row.itemId).sort(); }
  finally { await closeDb(); }
};

const publishedVersionOf = async (id: string): Promise<number | null> => {
  await initDb(CLONE);
  try { return await publishedVersion(id, WS); }
  finally { await closeDb(); }
};

/** Real rows, not bare ledger ids: the push sends atom bodies, so the items have to exist. */
async function stageMany(count: number): Promise<void> {
  await initDb(CLONE);
  try {
    const now = new Date().toISOString();
    for (let index = 0; index < count; index += 1) {
      await getClient().execute({
        sql: `INSERT INTO knowledge_items (id, category, title, content, origin_repo, created_at, updated_at)
              VALUES (?, 'fact', ?, ?, 'github.com/acme/web', ?, ?)`,
        args: [`bulk-${index}`, `Bulk atom ${index}`, `Body ${index}`, now, now],
      });
    }
    const bulkIds = Array.from({ length: count }, (_, index) => `bulk-${index}`);
    // Every atom needs a vector under the current profile, or `pushStaged` refuses the whole push
    // with `needs-embedding` and this test never reaches the chunking it is about.
    await seedEmbeddings(bulkIds);
    await stageForPublish(bulkIds, WS, 'main');
  } finally { await closeDb(); }
}

describe('pushStaged', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();

    run += 1;
    ORIGIN = path.resolve(`./.knowl-push-origin-${run}`);
    CLONE = path.resolve(`./.knowl-push-clone-${run}`);
    WS = `ws-push-${run}`;
    connected = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };

    await fs.mkdir(ORIGIN, { recursive: true });
    git(ORIGIN, ['init', '-q', '-b', 'main']);
    await commitToOrigin('a.txt');
    git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);

    await fs.mkdir(path.join(CLONE, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(CLONE, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(CLONE);
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    const projectId = (await repo.createProject(CLONE, 'push')).id;
    const decision = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Deploys roll back by tag',
      content: 'A failed deploy rolls back to the previous tag, never to a branch.',
    });
    const fact = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Local scratch note',
      content: 'A scratch observation that should stay in this repo.',
    });
    ids = { decision: decision.item.id, fact: fact.item.id };
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'github.com/acme/web'");
    await seedEmbeddings([ids.decision, ids.fact]);
    await closeDb();

    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await clearCredential(API_HOST).catch(() => {});
    await dropTeamStore(WS, CLONE).catch(() => {});
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('publishes from a feature branch, because adding knowledge is true from every vantage', async () => {
    // Reversed 2026-08-13. Publishing ADDS an atom, and the worst case is knowledge that is
    // premature -- which supersede and retract both undo. `reportDrift` keeps this gate because
    // it RETIRES someone else's atom, where a wrong vantage destroys instead of adding.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);
    let sent = false;

    const result = await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }], () => { sent = true; }),
    });

    expect(result).toMatchObject({ status: 'pushed', created: 1 });
    expect(sent).toBe(true);
  });

  it('publishes from a checkout behind its remote', async () => {
    // Being behind main makes CODE ambiguous -- deleted and not-yet-pulled look identical from
    // here. That ambiguity is a reason to withhold a drift report, not to withhold an atom.
    await commitToOrigin('b.txt');
    git(CLONE, ['fetch', '-q']);

    expect(await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }]),
    })).toMatchObject({ status: 'pushed', created: 1 });
  });

  it('refuses a reader before sending anything', async () => {
    // The role rides on every sync response. Building a batch and eating a 403 spends the
    // user's time to learn something already on disk.
    await recordRole('reader');
    let sent = false;

    const result = await pushStaged({
      projectRoot: CLONE, config: connected, api: fakeApi([], () => { sent = true; }),
    });

    expect(result).toMatchObject({ status: 'forbidden', role: 'reader' });
    expect(sent).toBe(false);
  });

  it('sends no expectedVersion the first time an atom is published', async () => {
    // A first publish has no remote version to be stale against, and sending one would be a
    // claim about a row that does not exist.
    let body: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }], sent => { body = sent; }),
    });

    expect(body.items[0].expectedVersion).toBeUndefined();
    expect(body.originRepo).toBe('github.com/acme/web');
  });

  it('sends expectedVersion from the ledger on a republish', async () => {
    // The server treats a republish with no expectedVersion as a conflict, deliberately, so an
    // older client cannot acquire overwrite rights by not knowing the field exists.
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }]),
    });
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });

    let body: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'updated', version: 2 }], sent => { body = sent; }),
    });

    expect(body.items[0].expectedVersion).toBe(1);
  });

  it('records the version the server returned, so the next republish is correct', async () => {
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 4 }]),
    });

    expect(await publishedVersionOf(ids.decision)).toBe(4);
  });

  it('reports a conflict without retrying, and leaves that atom staged', async () => {
    // A conflict means the local copy is stale. Retrying would overwrite whatever the other
    // writer landed, and the remedy is to re-read, not to insist.
    const result = await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'conflict', currentVersion: 9 }]),
    });

    expect((result as any).conflicts).toHaveLength(1);
    expect(await stagedIds()).toEqual([ids.decision]);
    expect(await publishedVersionOf(ids.decision)).toBeNull();
  });

  it('reports foreign_origin separately from conflict, because a retry would not help', async () => {
    const result = await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'foreign_origin', originRepo: 'github.com/acme/api' }]),
    });

    expect((result as any).rejected).toHaveLength(1);
    expect((result as any).conflicts).toHaveLength(0);
  });

  it('fails the whole batch on a secret, names the item, and quotes nothing', async () => {
    // A conflict means one atom is stale; a secret means the source is compromised. So this is
    // not an outcome per atom -- the server refuses the request -- and the rejection is
    // terminal: never retried, never retried in altered form.
    const api = {
      ...fakeApi([]),
      publishItems: async () => {
        throw new CloudApiError(422, `Secret detected in item ${ids.decision}`, 'secret_detected');
      },
    } as unknown as CloudApi;

    await expect(pushStaged({ projectRoot: CLONE, config: connected, api }))
      .rejects.toMatchObject({ code: 'secret_detected' });

    expect(await stagedIds()).toEqual([ids.decision]);
    expect(await publishedVersionOf(ids.decision)).toBeNull();
  });

  it('sends batches a cold server can finish inside the request timeout', async () => {
    // knowl#103. The old size was 200 -- the contract maximum -- which measured at 1564 MB and
    // 418s of server-side embedding, against a 30s client timeout. Any queue under 200 therefore
    // went as ONE request that a cold server could not finish, and a backlog was unpushable.
    await stageMany(60);
    const sizes: number[] = [];
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([], (body: any) => sizes.push(body.items.length)),
    });

    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(61);
  });

  it('halves the batch and retries when a send times out, instead of losing the push', async () => {
    // A timeout is the server saying "too much at once", so the client answers with less. Without
    // this a cold server fails the whole queue and every retry re-sends exactly what just failed.
    await stageMany(39);
    const attempted: number[] = [];
    let timeouts = 0;
    const api = {
      ...fakeApi([]),
      publishItems: async (body: any) => {
        attempted.push(body.items.length);
        // Fails anything above 10, like a server that cannot finish a big batch in the budget.
        if (body.items.length > 10) {
          timeouts += 1;
          throw new CloudApiError(408, '/knowledge timed out after 30000ms', 'timeout');
        }
        return { outcomes: [], commitId: 'c1' };
      },
    } as unknown as CloudApi;

    const result = await pushStaged({ projectRoot: CLONE, config: connected, api });

    expect(timeouts).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'pushed' });
    // Every atom still went, just in smaller pieces.
    const delivered = attempted.filter(size => size <= 10).reduce((a, b) => a + b, 0);
    expect(delivered).toBe(40);
  });

  it('records what landed before a timeout, so a retry does not start over', async () => {
    // The defect that made retrying pointless: nothing was written locally, so the next attempt
    // re-sent the entire queue and failed identically.
    await stageMany(39);
    let sent = 0;
    const api = {
      ...fakeApi([]),
      publishItems: async (body: any) => {
        sent += 1;
        // The first batch lands; everything after it times out, at every size.
        if (sent > 1) throw new CloudApiError(408, '/knowledge timed out after 30000ms', 'timeout');
        return {
          outcomes: body.items.map((item: any) => ({ id: item.id, status: 'created', version: 1 })),
          commitId: 'c1',
        };
      },
    } as unknown as CloudApi;

    await expect(pushStaged({ projectRoot: CLONE, config: connected, api })).rejects.toThrow();

    // The first batch is off the queue. Progress survives the failure.
    const left = await stagedIds();
    expect(left.length).toBe(40 - 20);
  });

  it('names how many atoms it was carrying when a timeout ends the push', async () => {
    // `Push failed: ... timed out after 30000ms` said nothing about size, so it pointed nowhere.
    await stageMany(9);
    const api = {
      ...fakeApi([]),
      publishItems: async () => {
        throw new CloudApiError(408, '/knowledge timed out after 30000ms', 'timeout');
      },
    } as unknown as CloudApi;

    await expect(pushStaged({ projectRoot: CLONE, config: connected, api }))
      .rejects.toThrow(/10 atom/);
  });

  it('chunks a batch larger than the contract maximum', async () => {
    // PublishRequest caps items at 200: an unbounded batch is an unbounded transaction and an
    // unbounded embedding job on the server.
    await stageMany(250);
    const sizes: number[] = [];
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([], (body: any) => sizes.push(body.items.length)),
    });

    expect(sizes.every(size => size <= 200)).toBe(true);
    // 250 staged bulk ids plus the decision the fixture already staged.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(251);
  });


  it('attaches the stored vector and the five-field fingerprint', async () => {
    let sent: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([], (body: any) => { sent = body; }),
    });

    const { fingerprintProfile, resolveVectorProfile } = await import('../../src/core/vector-profile.js');
    const { EMBED_RECIPE_VERSION } = await import('../../src/core/embed-recipe.js');
    const { encodeVector } = await import('../../src/cloud/vector-codec.js');
    const profile = resolveVectorProfile(connected);

    expect(sent.items[0].vector).toBe(encodeVector(new Array(384).fill(0.01)));
    expect(sent.items[0].profileFingerprint).toEqual({
      provider: profile.provider,
      model: profile.model,
      dtype: profile.dtype,
      pooling: profile.pooling,
      recipeVersion: EMBED_RECIPE_VERSION,
    });
    // Never `fingerprintProfile`'s hash on the wire: the server compares five values, not a hash
    // it has no way to reproduce.
    expect(JSON.stringify(sent)).not.toContain(fingerprintProfile(profile));
  });

  it('reads the vector rather than embedding at push time', async () => {
    const embeddings = await import('../../src/ai/embeddings.js');
    const spy = vi.spyOn(embeddings, 'createLocalEmbeddingProvider');

    try {
      await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([]) });
    } finally { spy.mockRestore(); }

    // The vector was built when the atom was written. Recomputing here would spend a forward pass
    // to reproduce a value already on disk -- and produce a DIFFERENT one if the profile moved.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to push an atom whose vector was built by a stale profile', async () => {
    await initDb(CLONE);
    try {
      await getClient().execute({
        sql: 'UPDATE knowledge_embeddings SET profile_fingerprint = ? WHERE knowledge_item_id = ?',
        args: ['a-fingerprint-from-another-profile', ids.decision],
      });
    } finally { await closeDb(); }

    let called = false;
    const result = await pushStaged({
      projectRoot: CLONE, config: connected, api: fakeApi([], () => { called = true; }),
    });

    // Not silence and not a lie: the atom stays staged and the message names the fix.
    expect(result.status).toBe('needs-embedding');
    expect((result as any).remedy).toContain('reindex');
    expect(called).toBe(false);
  });

  it('refuses to push an atom with no vector at all', async () => {
    await initDb(CLONE);
    try {
      await getClient().execute({
        sql: 'DELETE FROM knowledge_embeddings WHERE knowledge_item_id = ?',
        args: [ids.decision],
      });
    } finally { await closeDb(); }

    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([]) });
    expect(result.status).toBe('needs-embedding');
    expect((result as any).count).toBe(1);
  });

  it('sends evidence, and the citation survives a round trip into a replica', async () => {
    // The v1 design requires evidence to cross with a published item, and `sync-apply.ts` already
    // writes it on the way DOWN -- so omitting it here is a one-directional pipe that leaves every
    // atom this client publishes uncited, with nothing going red to say so.
    //
    // Asserted by round trip rather than against the schema. Comparing a hand-built payload to a
    // type proves the type; it proves nothing about what the loader actually reads.
    await initDb(CLONE);
    const evidence = await createEvidence({
      type: 'file',
      locator: 'src/deploy.ts',
      contentHash: 'sha256:deploy',
      excerpt: 'rollbackToTag()',
      observedAt: '2026-08-09T10:00:00.000Z',
      metadata: { line: 42 },
    });
    await linkKnowledgeEvidence({
      knowledgeItemId: ids.decision, evidenceId: evidence.id, relationship: 'supports',
    });
    await closeDb();

    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });

    let body: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }], sent => { body = sent; }),
    });

    const sent = body.items.find((item: any) => item.id === ids.decision);
    expect(sent.evidence).toHaveLength(1);
    expect(sent.evidence[0]).toMatchObject({
      id: evidence.id,
      // `type`, never `kind` -- the name the wire and the local column agree on, and the one the
      // sync fixtures already caught this client getting wrong once.
      type: 'file',
      locator: 'src/deploy.ts',
      excerpt: 'rollbackToTag()',
      // Carried from the LINK row, not from `evidence` -- the same citation can support one atom
      // and contradict another.
      relationship: 'supports',
    });

    // The other half of the round trip: what was sent has to be what a replica can apply.
    const applied = await withTeamStore(WS, CLONE, async () => {
      await applySyncRows([{
        op: 'upsert',
        seq: '1',
        item: {
          ...sent,
          originRepo: 'github.com/acme/web', authorUserId: 'u1', supersededById: null,
          version: 1, visibility: 'workspace', review: null,
          publishedAt: '2026-08-09T10:00:00.000Z',
          createdAt: '2026-08-09T10:00:00.000Z',
          updatedAt: '2026-08-09T10:00:00.000Z',
        },
      }]);
      const rows = await getClient().execute(
        'SELECT e.locator, ke.relationship FROM evidence e JOIN knowledge_evidence ke ON ke.evidence_id = e.id',
      );
      return rows.rows.map(row => `${row.locator}:${row.relationship}`);
    });

    expect(applied).toEqual(['src/deploy.ts:supports']);
  });

  it('sends the tier the atom earned, rather than letting the server default it', async () => {
    // Tier is EARNED -- promoted from real retrievals since `tier_since`. Dropping it discards the
    // quality signal at the exact moment of sharing, and it is the signal the publish policy in
    // the spec is built on.
    await initDb(CLONE);
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET tier = ? WHERE id = ?',
      args: ['verified', ids.decision],
    });
    await closeDb();

    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });

    let body: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }], sent => { body = sent; }),
    });

    expect(body.items.find((item: any) => item.id === ids.decision).tier).toBe('verified');
  });

  it('sends assertions, so a time-bounded sub-claim is not lost on the way up', async () => {
    // No assertion is created here, and that is the point: `storeKnowledgeItemDeduped` opens one
    // for every atom it writes. So this was not an exotic field lost on unusual items -- every
    // atom this client published was arriving with its open interval stripped.
    await initDb(CLONE);
    const [existing] = await listAssertions(ids.decision);
    expect(existing, 'fixture atom should already carry an open assertion').toBeDefined();
    await closeDb();

    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });

    let body: any;
    await pushStaged({
      projectRoot: CLONE, config: connected,
      api: fakeApi([{ id: ids.decision, status: 'created', version: 1 }], sent => { body = sent; }),
    });

    const sent = body.items.find((item: any) => item.id === ids.decision);
    expect(sent.assertions).toHaveLength(1);
    // `validTo: null` is an interval still open, not an unknown one -- the distinction the
    // assertion table exists to carry, and the one a dropped field erases.
    expect(sent.assertions[0]).toMatchObject({ id: existing.id, validTo: null });
    expect(typeof sent.assertions[0].validFrom).toBe('string');
    // `knowledgeItemId` is the local link and has no place on the wire: the assertion rides inside
    // the atom that owns it, so repeating the owner would be a second source of truth for it.
    expect(sent.assertions[0].knowledgeItemId).toBeUndefined();
  });
});
