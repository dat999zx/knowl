import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_IDENTITY_FLAGS } from '../git-identity.js';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { checkKnowledgeDrift } from '../../src/store/drift.js';
import * as repo from '../../src/store/repository.js';

/**
 * Drift over paths git cannot report on.
 *
 * `listChangedFilesSince` is `git diff --name-only`, so the whole check sees TRACKED files. An
 * atom whose `affectedPaths` name an untracked or ignored working directory was therefore
 * unwatchable — the check ran, matched nothing, and reported the atom fresh indefinitely.
 *
 * The case these were written from, 2026-08-12: a state atom saying "STILL OPEN: final
 * atmosphere pick" pointed at `experiments/reskin/`, which is deliberately not in git. The
 * question was settled days later, that directory changed constantly throughout, the atom was
 * never revised, and a later session read it and acted on a question that had been closed.
 */
const ROOT = path.resolve('.knowl-drift-untracked-test');
const git = (args: string) => execSync(`git ${GIT_IDENTITY_FLAGS} ${args}`, { cwd: ROOT, encoding: 'utf-8' });

/** Written far enough in the past that a file touched during the test is unambiguously newer. */
const LONG_AGO = '2020-01-01T00:00:00.000Z';

describe('drift over untracked paths', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    git('init');
    await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'src/tracked.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(ROOT, '.gitignore'), 'experiments/\n');
    git('add -A');
    git('commit -m "base"');

    // The working directory the atom will point at: real on disk, invisible to git.
    await fs.mkdir(path.join(ROOT, 'experiments/reskin'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'experiments/reskin/note.txt'), 'first\n');

    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Drift untracked test')).id;
  });

  afterAll(async () => {
    await closeDb();
    // Swallowed for the same reason drift-auto.test.ts swallows it: on Windows the WAL
    // sidecars stay held briefly after close, and a teardown race must not fail a green run.
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  async function atom(title: string, affectedPaths: string[], updatedAt = LONG_AGO) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state', title, content: `${title} body`, affectedPaths,
    });
    // The mtime comparison is against `updated_at`, so the test has to control it directly
    // rather than depend on how fast the suite runs.
    await getDb().run(sql`UPDATE knowledge_items SET updated_at = ${updatedAt} WHERE id = ${item.id}`);
    return item;
  }

  it('flags an atom whose untracked directory moved after it was written', async () => {
    const item = await atom('atmosphere pick still open', ['experiments/reskin']);
    // Adding an entry moves a directory's own mtime, which is the signal used.
    await fs.writeFile(path.join(ROOT, 'experiments/reskin/second.txt'), 'added\n');

    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'HEAD', currentCommit: 'HEAD', changedFiles: [], projectRoot: ROOT,
    });

    expect(result.candidates.map(c => c.itemId)).toContain(item.id);
    const candidate = result.candidates.find(c => c.itemId === item.id);
    expect(candidate?.matchedPaths).toContain('experiments/reskin');
  });

  it('does not flag when the untracked path has not moved since the atom was written', async () => {
    // Written NOW, so the directory's existing mtime is older than the atom.
    const item = await atom('written after the directory settled', ['experiments/reskin'],
      new Date(Date.now() + 60_000).toISOString());

    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'HEAD', currentCommit: 'HEAD', changedFiles: [], projectRoot: ROOT,
    });

    expect(result.candidates.map(c => c.itemId)).not.toContain(item.id);
  });

  it('leaves tracked paths to git rather than reporting them twice', async () => {
    // src/tracked.ts is in the index, so the untracked check must ignore it entirely —
    // otherwise every atom about live source flags on every run rather than only inside
    // the commit window, which is the noise that keeps drift advisory in the first place.
    const item = await atom('about tracked source', ['src/tracked.ts']);

    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'HEAD', currentCommit: 'HEAD', changedFiles: [], projectRoot: ROOT,
    });

    expect(result.candidates.map(c => c.itemId)).not.toContain(item.id);
  });

  it('treats a directory containing tracked files as git territory', async () => {
    // `src/` holds a tracked file, so it is source rather than a working area even though
    // the directory itself is not an entry in the index.
    const item = await atom('about the src directory', ['src']);
    await fs.writeFile(path.join(ROOT, 'src/untracked-scratch.ts'), 'scratch\n');

    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'HEAD', currentCommit: 'HEAD', changedFiles: [], projectRoot: ROOT,
    });

    expect(result.candidates.map(c => c.itemId)).not.toContain(item.id);
  });

  it('is off unless a project root is supplied, so existing callers are unchanged', async () => {
    const item = await atom('no project root given', ['experiments/reskin']);
    await fs.writeFile(path.join(ROOT, 'experiments/reskin/third.txt'), 'added\n');

    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'HEAD', currentCommit: 'HEAD', changedFiles: [],
    });

    expect(result.candidates.map(c => c.itemId)).not.toContain(item.id);
  });
});
