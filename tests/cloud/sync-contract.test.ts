import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSyncPage, SyncContractError } from '../../src/cloud/sync-contract.js';

const fixture = async (name: string) =>
  JSON.parse(await fs.readFile(path.resolve('tests/fixtures/sync', `${name}.json`), 'utf8'));

describe('sync contract mirror', () => {
  it('parses a page of upserts produced by the real server serializer', async () => {
    const page = parseSyncPage(await fixture('snapshot-page'));

    expect(page.rows.length).toBeGreaterThan(0);
    const first = page.rows[0];
    expect(first.op).toBe('upsert');
    if (first.op !== 'upsert') throw new Error('unreachable');
    expect(typeof first.seq).toBe('string');
    expect(typeof first.item.id).toBe('string');
    expect(typeof first.item.version).toBe('number');
  });

  it('accepts a null contentHash, because the server really sends one', async () => {
    // Not a relaxation for its own sake: `snapshot-page.json` comes straight from the server's
    // serializer and carries `contentHash: null`, while `atom-full.json` carries a string. A
    // mirror that demanded a string would refuse the majority of real pages -- the fixture
    // check catching this is the entire reason it is pinned to generated output.
    const nullable = parseSyncPage(await fixture('snapshot-page'));
    const first = nullable.rows[0];
    if (first.op !== 'upsert') throw new Error('unreachable');
    expect(first.item.contentHash).toBeNull();

    const full = parseSyncPage(await fixture('atom-full'));
    const populated = full.rows[0];
    if (populated.op !== 'upsert') throw new Error('unreachable');
    expect(populated.item.contentHash).toBe('sha256:content');
  });

  it('keeps seq and nextSeq as strings, because a bigint does not survive a JS number', async () => {
    // The server sends a decimal bigint. Above 2^53 a float loses digits silently, and a
    // watermark that is one short skips a commit permanently -- the exact failure the
    // gapless sequence exists to prevent.
    const page = parseSyncPage(await fixture('snapshot-page'));

    expect(typeof page.nextSeq).toBe('string');
    for (const row of page.rows) expect(typeof row.seq).toBe('string');
  });

  it('carries a mid-traversal cursor through untouched', async () => {
    // The cursor is opaque by contract. Parsing or rebuilding it here would couple this client
    // to the server's encoding, which is the coupling the opacity exists to prevent.
    const page = parseSyncPage(await fixture('snapshot-page'));
    expect(page.cursor).toBe('c3luY3wxfGI');

    const final = parseSyncPage(await fixture('snapshot-final'));
    expect(final.cursor).toBeNull();
  });

  it('parses a delete row', async () => {
    const page = parseSyncPage(await fixture('delta-mixed'));
    const deletion = page.rows.find(row => row.op === 'delete');

    expect(deletion).toBeDefined();
    if (deletion?.op !== 'delete') throw new Error('unreachable');
    expect(typeof deletion.id).toBe('string');
    expect(typeof deletion.deletedAt).toBe('string');
  });

  it('parses a page that mixes a delete and an upsert, in feed order', async () => {
    // Deletes are ordered with everything else rather than batched at either end, so the
    // applier must not assume a page is homogeneous.
    const page = parseSyncPage(await fixture('delta-mixed'));
    expect(page.rows.map(row => row.op)).toEqual(['delete', 'upsert']);
  });

  it('reads an empty delta as a completed traversal, not as an error', async () => {
    const page = parseSyncPage(await fixture('delta-empty'));
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBeNull();
    expect(page.resyncRequired).toBe(false);
  });

  it('recognises the retention refusal as a page shape, not as an error to retry', async () => {
    // A `since` below the oldest retained commit is answered with resyncRequired rather than
    // a short page. Reading it as a normal empty page would advance the watermark past
    // commits that were never delivered.
    const page = parseSyncPage(await fixture('resync-required'));
    expect(page.resyncRequired).toBe(true);
  });

  it('carries the caller role, so publish can fail fast later', async () => {
    const page = parseSyncPage(await fixture('snapshot-page'));
    expect(['owner', 'admin', 'editor', 'reader']).toContain(page.role);
  });

  it('carries evidence with the server\'s `type` field, matching the local column', async () => {
    // The payload names it `type`, and so does the local `evidence` table. Mirroring it as
    // `kind` would leave every citation with a NOT NULL violation at apply time.
    const page = parseSyncPage(await fixture('atom-full'));
    const row = page.rows[0];
    if (row.op !== 'upsert') throw new Error('unreachable');

    expect(row.item.evidence?.[0]).toMatchObject({
      id: 'e1',
      type: 'file',
      locator: 'src/deploy.ts',
      relationship: 'supports',
    });
  });

  it('refuses a shape the mirror does not recognise rather than half-applying it', async () => {
    // Drift between the two repos must stop sync, not produce a replica missing whatever
    // field was added. A silently dropped column is the failure this whole file exists for.
    expect(() => parseSyncPage({ rows: [{ op: 'sideways', seq: '1' }] })).toThrow(SyncContractError);
    expect(() => parseSyncPage({ rows: [{ op: 'upsert', seq: 1, item: {} }] })).toThrow(SyncContractError);
    expect(() => parseSyncPage(null)).toThrow(SyncContractError);
  });
});
