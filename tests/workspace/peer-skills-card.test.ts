import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { bootstrapAgentSession } from '../../src/store/context-bootstrap.js';
import { listPeerSkillItems } from '../../src/workspace/peer-skills.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { releaseAll } from '../../src/store/connection-pool.js';

const HOME = path.resolve('./.knowl-peerskill-home');
const A = path.resolve('./.knowl-peerskill-a');
const B = path.resolve('./.knowl-peerskill-b');

type Seed = { title: string; content: string; visibility: string; source?: string };

/**
 * A skill row exactly as `indexSkillPackage` writes one -- `.knowl/skills/<name>/SKILL.md` as
 * the source, and a `Purpose:` second line. The source matters more than it looks: it is what
 * makes a peer row *look* runnable, which is the bug this file exists to hold shut.
 */
const skill = (title: string, purpose: string, visibility: string): Seed => ({
  title,
  content: `File-backed learned skill package at \`.knowl/skills/${title}/SKILL.md\`.\nPurpose: ${purpose}`,
  visibility,
  source: `.knowl/skills/${title}/SKILL.md`,
});

async function seed(root: string, name: string, items: Seed[]) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'skill', title: item.title, content: item.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ?, source = ? WHERE id = ?',
      args: [item.visibility, name, item.source ?? null, stored.item.id],
    });
  }
  await closeDb();
}

describe('a linked repo\'s shared skills on the session-start card', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', []);
    await seed(B, 'duckprep', [
      skill('mascot-art', 'style-anchored generation with a judge loop.', 'workspace'),
      skill('private-chore', 'not for sharing.', 'repo'),
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'duckprep' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads a peer\'s workspace-visible skill and leaves its private one behind', async () => {
    await initDb(A);
    try {
      const active = (await resolveWorkspace(A))!;
      const found = await listPeerSkillItems(active);

      expect(found.map(entry => entry.item.title)).toEqual(['mascot-art']);
      expect(found[0].repo).toBe('duckprep');
    } finally {
      await closeDb();
    }
  });

  it('puts the peer skill on the card, attributed and marked unrunnable', async () => {
    await initDb(A);
    try {
      const projectId = (await repo.createProject(A, 'a')).id;
      const { context } = await bootstrapAgentSession({ projectId, title: 'peer skills' });

      // The whole incident in one assertion: an agent in this repo now learns the pipeline
      // exists without having known to query for it.
      expect(context).toContain('mascot-art');
      expect(context).toContain('(in duckprep, not runnable here)');
      expect(context).not.toContain('private-chore');
    } finally {
      await closeDb();
    }
  });

  /*
   * Both skip branches, driven through the workspace shape rather than the filesystem.
   *
   * The obvious version of this test deletes the peer's database and asserts the card survives.
   * It cannot be written that way here: a process cannot unlink a libsql file it has opened, so
   * on Windows the delete fails rather than the read. Handing `listPeerSkillItems` an absent peer
   * and an unreadable one exercises the same two branches without asking the platform for
   * something it does not do.
   */
  it('skips a peer that is absent or whose store will not open', async () => {
    await initDb(A);
    try {
      const active = (await resolveWorkspace(A))!;
      const broken = {
        ...active,
        peers: [
          { ...active.peers[0], name: 'gone', present: false },
          { ...active.peers[0], name: 'unreadable', present: true, databasePath: path.join(A, 'no', 'such.db') },
        ],
      };

      await expect(listPeerSkillItems(broken)).resolves.toEqual([]);
    } finally {
      await closeDb();
    }
  });
});
