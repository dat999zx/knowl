import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import {
  captureChangeWatermark,
  consumeChangeNotice,
  resetChangeNotice,
} from '../../src/mcp/change-notice.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-mcp-change-notice');

let projectId = '';

/** One foreign write, as a sibling session would leave it. */
async function siblingCommit(title: string, itemId = title.toLowerCase().replace(/\s+/g, '-')): Promise<void> {
  await repo.createKnowledgeCommit(projectId, `Sibling: ${title}`, [
    { itemId, action: 'insert', after: { id: itemId, category: 'fact', title } },
  ]);
}

/** A full tool call: read the watermark, run the tool, then ask for the notice. */
async function toolCall(name: string, during?: () => Promise<void>): Promise<string | undefined> {
  const watermark = await captureChangeWatermark(ROOT);
  if (during) await during();
  return consumeChangeNotice(ROOT, name, watermark);
}

describe('MCP change notice', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    await getClient().execute('DELETE FROM knowledge_commits');
    projectId = (await repo.createProject(ROOT, 'mcp change notice')).id;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    resetChangeNotice();
  });

  it('says nothing on the first tool call, however much history exists', async () => {
    await siblingCommit('Ancient history');
    expect(await toolCall('knowl_query')).toBeUndefined();
  });

  it('reports a foreign commit on the next tool call', async () => {
    await toolCall('knowl_query');
    await siblingCommit('Sibling wrote this');

    const notice = await toolCall('knowl_query');
    expect(notice).toContain('KNOWL CHANGED');
    expect(notice).toContain('Sibling wrote this');
  });

  it('reports each foreign change once', async () => {
    await toolCall('knowl_query');
    await siblingCommit('Reported once');

    expect(await toolCall('knowl_query')).toContain('Reported once');
    expect(await toolCall('knowl_query')).toBeUndefined();
  });

  it('never reads a caller its own write back as news', async () => {
    await toolCall('knowl_query');

    // The commit lands during the write tool's own call, which is exactly the case the
    // hook path has to guess at by matching titles.
    const atWrite = await toolCall('knowl_store', () => siblingCommit('My own item', 'mine-1'));
    expect(atWrite).toBeUndefined();
    expect(await toolCall('knowl_query')).toBeUndefined();
  });

  it('does not swallow a foreign commit that lands while a read-only tool runs', async () => {
    await toolCall('knowl_query');

    const atRead = await toolCall('knowl_query', () => siblingCommit('Landed mid-read'));
    expect(atRead).toBeUndefined();

    // A read tool leaves the watermark where it started, so the racing write is still news.
    expect(await toolCall('knowl_query')).toContain('Landed mid-read');
  });

  it('reports a sibling write that lands during the callers own write, on the next call', async () => {
    await toolCall('knowl_query');
    await toolCall('knowl_store', () => siblingCommit('Mine', 'mine-2'));
    await siblingCommit('Theirs, after mine');

    expect(await toolCall('knowl_query')).toContain('Theirs, after mine');
  });

  // K-53: parking a baton commits a knowledge item, and knowl_handoff was missing from the
  // write set -- so the watermark stayed behind it and the very next call read the session
  // its own handoff back as somebody else's news.
  it('never reads a session its own parked baton back as news', async () => {
    await toolCall('knowl_query');

    const atHandoff = await toolCall('knowl_handoff', () => siblingCommit('My own baton', 'baton-1'));
    expect(atHandoff).toBeUndefined();
    expect(await toolCall('knowl_query')).toBeUndefined();
  });

  it('degrades to no notice rather than throwing when there is no project root', async () => {
    expect(await captureChangeWatermark(null)).toBeNull();
    expect(await consumeChangeNotice(null, 'knowl_query', null)).toBeUndefined();
  });
});
