import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudApi, SendMailbox, SendPreview } from '../../src/cloud/api-client.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { clearCredential, writeCredential } from '../../src/cloud/credentials.js';
import { deriveMailboxId } from '../../src/cloud/send/code.js';
import {
  listSends, previewSend, receiveKnowledge, refusalMessage, revokeSend, sendKnowledge,
} from '../../src/cloud/send/transfer.js';
import type { ProjectConfig } from '../../src/core/types.js';

const API_HOST = 'https://api.send.test';
const HOME = path.resolve('./.knowl-send-home');
const CODE = 'owl-cascade-ridge-plum-tin';

let counter = 0;
let SENDER = '';
let RECEIVER = '';
let config: ProjectConfig;

const preview: SendPreview = {
  senderLabel: 'github.com/acme/web',
  itemCount: 1,
  createdAt: '2026-08-14T10:00:00.000Z',
  expiresAt: '2026-08-15T10:00:00.000Z',
};

/**
 * A drop box that only answers for the id it was told to hold.
 *
 * Which id that is, is the whole subject of this file: it is what the derivation change moved, and
 * a fake that answered any id would pass whether or not the fallback worked.
 */
function fakeApi(over: Partial<CloudApi> = {}): CloudApi {
  return {
    refresh: async () => { throw new Error('unused'); },
    ...over,
  } as unknown as CloudApi;
}

function drop(mailboxId: string, calls: string[]): Partial<CloudApi> {
  return {
    peekSend: async ({ mailboxId: asked }) => {
      calls.push(asked);
      return asked === mailboxId ? preview : null;
    },
  };
}

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('finding a bundle when the derivation changed underneath it', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    config = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: 'ws-send', workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };
    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(async () => {
    await clearCredential(API_HOST).catch(() => {});
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('asks for the v2 mailbox first, and stops there', async () => {
    const calls: string[] = [];
    const resolved = await previewSend({
      config, code: CODE, api: fakeApi(drop(deriveMailboxId(CODE, 2), calls)),
    });

    expect(resolved).toMatchObject({ version: 2, mailboxId: deriveMailboxId(CODE, 2) });
    // One round trip for the common case. A walk that asked v1 first, or asked both regardless,
    // would make every receive pay for a compatibility path nothing needs.
    expect(calls).toEqual([deriveMailboxId(CODE, 2)]);
  });

  it('falls back to v1, so a bundle from a 5.1.0 sender is still collectable', async () => {
    const calls: string[] = [];
    const resolved = await previewSend({
      config, code: CODE, api: fakeApi(drop(deriveMailboxId(CODE, 1), calls)),
    });

    expect(resolved).toMatchObject({ version: 1, mailboxId: deriveMailboxId(CODE, 1) });
    expect(calls).toEqual([deriveMailboxId(CODE, 2), deriveMailboxId(CODE, 1)]);
  });

  it('gives up after both, rather than reporting a miss as an error', async () => {
    const calls: string[] = [];
    expect(await previewSend({ config, code: CODE, api: fakeApi(drop('nothing-lives-here', calls)) }))
      .toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('says which of the two preconditions is missing before it derives anything', async () => {
    expect(await previewSend({ config: { version: 1 }, code: CODE, api: fakeApi() }))
      .toBe('not-connected');
    await clearCredential(API_HOST);
    expect(await previewSend({ config, code: CODE, api: fakeApi() })).toBe('not-logged-in');
  });
});

describe('a refusal the client does not recognise', () => {
  it('reads back what the server said, rather than the wrong known answer', () => {
    // The bug this replaced: `rate_limited` arrives, the lookup misses, and a sender at their
    // quota is told the bundle they just minted does not exist.
    expect(refusalMessage('rate_limited')).toContain('too many bundles in flight');
    expect(refusalMessage('conflict')).toContain('fresh code');

    // A member added to the server's enum after this build shipped.
    expect(refusalMessage('quarantined', 'That workspace is under review.'))
      .toBe('That workspace is under review.');
  });

  it('still says something when the server sends a reason and no message', () => {
    expect(refusalMessage('quarantined')).toBe('The server refused that: quarantined.');
  });

  it('keeps the wording the receiver already relies on', () => {
    expect(refusalMessage('not_found')).toContain('Check what you typed');
    expect(refusalMessage('expired')).toContain('expired');
    expect(refusalMessage('already_claimed')).toContain('already collected');
  });
});

describe('the sender looking at what is in flight', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    config = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: 'ws-send', workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };
    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(async () => {
    await clearCredential(API_HOST).catch(() => {});
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('reports the claimed-yet column, which is the tamper evidence', async () => {
    const mailboxes: SendMailbox[] = [{
      mailboxId: 'a'.repeat(32), itemCount: 3,
      createdAt: preview.createdAt, expiresAt: preview.expiresAt,
      claimedAt: '2026-08-14T11:00:00.000Z',
    }];
    expect(await listSends({ config, api: fakeApi({ listSends: async () => mailboxes }) }))
      .toEqual(mailboxes);
  });

  it('revokes a raw id exactly as given, deriving nothing', async () => {
    // The path for an id copied out of --list, where there is no code to derive from. Treating it
    // as a code would derive from the id's own text and delete nothing.
    const asked: string[] = [];
    const id = 'b'.repeat(32);
    const revoked = await revokeSend({
      config, target: id.toUpperCase(),
      api: fakeApi({ revokeSend: async ({ mailboxId }) => { asked.push(mailboxId); return true; } }),
    });
    expect(revoked).toBe(true);
    expect(asked).toEqual([id]);
  });

  it('revokes a code through the same walk a receiver uses', async () => {
    // A sender revoking one they minted on 5.1.0 holds a v1 id whether they know it or not.
    const asked: string[] = [];
    const revoked = await revokeSend({
      config, target: CODE,
      api: fakeApi({
        revokeSend: async ({ mailboxId }) => {
          asked.push(mailboxId);
          return mailboxId === deriveMailboxId(CODE, 1);
        },
      }),
    });
    expect(revoked).toBe(true);
    expect(asked).toEqual([deriveMailboxId(CODE, 2), deriveMailboxId(CODE, 1)]);
  });

  it('reports nothing revoked rather than throwing, when there was nothing there', async () => {
    expect(await revokeSend({
      config, target: 'c'.repeat(32), api: fakeApi({ revokeSend: async () => false }),
    })).toBe(false);
  });
});

describe('a bundle all the way there and back', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});

    counter += 1;
    SENDER = path.resolve(`./.knowl-send-src${counter}`);
    RECEIVER = path.resolve(`./.knowl-send-dst${counter}`);
    for (const dir of [SENDER, RECEIVER]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await makeRepo(dir);
    }
    config = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: 'ws-send', workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };
    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await clearCredential(API_HOST).catch(() => {});
    delete process.env.KNOWL_HOME;
    for (const dir of [SENDER, RECEIVER, HOME]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('seals under v2, and the receiver opens what the sender sealed', async () => {
    // The property no unit test of the crypto can reach: the id the sender registered, the
    // version the receiver resolved and the key it unsealed with all have to be the same
    // derivation, threaded through three modules and a fake wire.
    await initDb(SENDER);
    const projectId = (await repo.createProject(SENDER, 'sender')).id;
    const written = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Argon2id, not raw HKDF',
      content: 'The cost per guess is what defends a human-typed code.',
    });
    await closeDb();

    // The drop box: one row, whatever id the sender hands it.
    const box = new Map<string, string>();
    const api = fakeApi({
      createSend: async ({ mailboxId, ciphertext }) => {
        box.set(mailboxId, ciphertext);
        return { mailboxId, expiresAt: preview.expiresAt };
      },
      peekSend: async ({ mailboxId }) => (box.has(mailboxId) ? preview : null),
      claimSend: async ({ mailboxId }) => {
        const ciphertext = box.get(mailboxId);
        if (!ciphertext) return { refused: 'not_found' as const };
        box.delete(mailboxId); // Single claim, like the real one.
        return { ciphertext, preview };
      },
    });

    const sent = await sendKnowledge({
      projectRoot: SENDER, projectId, config, itemIds: [written.item.id],
      senderLabel: 'github.com/acme/web', expiresInHours: 24, api,
    });
    expect(sent.status).toBe('sent');
    if (sent.status !== 'sent') return;

    // Registered under the v2 id, and under no other.
    expect([...box.keys()]).toEqual([deriveMailboxId(sent.code, 2)]);

    const resolved = await previewSend({ config, code: sent.code, api });
    expect(resolved).toMatchObject({ version: 2 });
    if (!resolved || typeof resolved === 'string') return;

    const received = await receiveKnowledge({ projectRoot: RECEIVER, config, resolved, api });
    expect(received.status).toBe('received');
    if (received.status !== 'received') return;
    expect(received.imported.inserted).toBe(1);

    // Spent, and the second attempt refuses rather than replaying.
    expect(await previewSend({ config, code: sent.code, api })).toBeNull();
  });

  it('refuses a code nobody sent, without touching the store', async () => {
    const api = fakeApi({ peekSend: async () => null });
    expect(await previewSend({ config, code: CODE, api })).toBeNull();
    // No database was opened for a bundle that does not exist.
    await expect(fs.access(path.join(RECEIVER, '.knowl', 'knowl.db'))).rejects.toThrow();
  });

  it('carries a refusal up rather than throwing, when the sender is at their quota', async () => {
    await initDb(SENDER);
    const projectId = (await repo.createProject(SENDER, 'sender')).id;
    const written = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'quota', content: 'anything',
    });
    await closeDb();

    const result = await sendKnowledge({
      projectRoot: SENDER, projectId, config, itemIds: [written.item.id],
      senderLabel: 'x', expiresInHours: 24,
      api: fakeApi({
        createSend: async () => ({ refused: 'rate_limited', message: 'Too many in flight.' }),
      }),
    });
    expect(result).toEqual({ status: 'refused', reason: 'rate_limited', message: 'Too many in flight.' });
  });
});
