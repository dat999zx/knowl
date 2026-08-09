import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { stagePublish } from '../../src/cloud/publish.js';
import { listStaged } from '../../src/cloud/ledger.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = path.resolve('./.knowl-publish-stage');
const WS = 'ws-pub';

const connected: ProjectConfig = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.dev', workspaceId: WS, workspaceName: 'Acme',
    repo: 'github.com/acme/web', remote: 'origin',
  },
};

let ids: { decision: string; fact: string };

describe('stagePublish', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    // Wiped rather than trusted to the directory removal: on Windows libSQL can hold the file,
    // the `rm` is silently refused, and a surviving row dedups the seed away.
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    const projectId = (await repo.createProject(ROOT, 'publish')).id;
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
    await closeDb();
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const stage = (over: Partial<Parameters<typeof stagePublish>[0]> = {}) =>
    stagePublish({ projectRoot: ROOT, config: connected, ...over });

  const staged = async (): Promise<string[]> => {
    await initDb(ROOT);
    try { return (await listStaged(WS)).map(row => row.itemId).sort(); }
    finally { await closeDb(); }
  };

  const execute = async (sql: string): Promise<void> => {
    await initDb(ROOT);
    try { await getClient().execute(sql); }
    finally { await closeDb(); }
  };

  it('refuses when the repo is not connected', async () => {
    expect(await stagePublish({ projectRoot: ROOT, config: { version: 1 }, ids: [ids.decision] }))
      .toEqual({ status: 'not-connected' });
  });

  it('refuses a bare call, because it would send the whole repo', async () => {
    await expect(stage()).rejects.toThrow(/--category|--id/);
  });

  it('refuses a category that cannot exist, and names the Windows comma trap', async () => {
    // Fires without a typo on Windows: `knowl.cmd` runs through cmd.exe, which splits an
    // unquoted `--category a,b,c` on the commas, so only `a` arrives.
    await expect(stage({ categories: ['desicion' as never] })).rejects.toThrow(/quote the list/i);
  });

  it('is a dry run by default, entering nothing in the ledger', async () => {
    const result = await stage({ categories: ['decision'] });

    expect(result).toMatchObject({ status: 'staged', applied: false });
    expect(await staged()).toEqual([]);
  });

  it('stages the selected items when applied', async () => {
    await stage({ categories: ['decision'], apply: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('counts foreign items rather than silently returning fewer rows', async () => {
    // "1 item belongs to api" is actionable; a short list with no explanation is not.
    await execute(`UPDATE knowledge_items SET origin_repo = 'github.com/acme/api' WHERE id = '${ids.fact}'`);

    const result = await stage({ categories: ['decision', 'fact'], apply: true });

    expect(result).toMatchObject({ skippedForeign: 1 });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('stages from a feature branch, because the gate belongs to the push', async () => {
    // Staging is an intent and can be formed at any time. Only sending is gated -- refusing to
    // stage would mean the work has to be remembered by a human until the merge lands.
    const result = await stage({ ids: [ids.decision], apply: true });

    expect(result).toMatchObject({ status: 'staged', applied: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('stages an item already at workspace visibility, since the two acts are different', async () => {
    // `promote` shares with linked local repos; publishing shares with the company. An item
    // that did the first must still be able to do the second.
    await execute(`UPDATE knowledge_items SET visibility = 'workspace' WHERE id = '${ids.decision}'`);

    await stage({ ids: [ids.decision], apply: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('re-stages an already-pushed item when its id is named, so a correction can be sent', async () => {
    // Naming an id is a deliberate act about an item the caller has in hand, and it is the only
    // route a correction has. Doing nothing here would make `knowl publish --id x --apply`
    // report success and send nothing.
    await stage({ ids: [ids.decision], apply: true });
    await execute(`UPDATE cloud_published SET pushed_at = '2026-01-01T00:00:00.000Z', remote_version = 4`);

    await stage({ ids: [ids.decision], apply: true });

    expect(await staged()).toEqual([ids.decision]);
  });

  it('leaves an already-pushed item alone on a category sweep', async () => {
    // A sweep means "publish the decisions that are not published". Re-staging what is already
    // up there would spend a version bump and a server-side embedding job per atom on identical
    // content, every time anyone ran the command.
    await stage({ categories: ['decision'], apply: true });
    await execute(`UPDATE cloud_published SET pushed_at = '2026-01-01T00:00:00.000Z', remote_version = 4`);

    await stage({ categories: ['decision'], apply: true });

    expect(await staged()).toEqual([]);
  });

  it('does not change visibility', async () => {
    // Decision ee191dd7db024bec: publication state lives in the ledger, and `visibility` keeps
    // meaning "readable by linked local repos on this machine" exactly as before.
    await stage({ ids: [ids.decision], apply: true });

    await initDb(ROOT);
    try {
      const row = await getClient().execute(
        `SELECT visibility FROM knowledge_items WHERE id = '${ids.decision}'`,
      );
      expect(String(row.rows[0].visibility)).toBe('repo');
    } finally { await closeDb(); }
  });
});
