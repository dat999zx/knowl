import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { clampInteger, handleSessionList, handleTranscriptRead, handleTranscriptSearch } from '../../src/transcripts/mcp-handlers.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import type { ProjectConfig } from '../../src/core/types.js';

let dir: string;
let homeBefore: { HOME?: string; USERPROFILE?: string };

const config = (over: Partial<{ enabled: boolean; share: boolean }> = {}): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled: true, ...over }, vector: { enabled: false } },
});

const line = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

/**
 * Every repo's transcripts live under the *default* archive path, which the fixture owns by
 * redirecting the home directory.
 *
 * The handlers take no `projectsDir`, and they should not: production always reads
 * `~/.claude/projects`. Seeding somewhere else and letting the handler look at the real archive
 * makes the search-time top-up see zero files, which it correctly reads as "every transcript
 * was deleted" -- so the fixture would delete its own index between indexing and searching.
 */
const projectsDirFor = () => path.join(dir, 'home', '.claude', 'projects');

async function makeRepo(name: string, body: string, share: boolean) {
  const root = path.join(dir, name);
  const projectsDir = projectsDirFor();
  const encoded = encodeProjectDir(path.resolve(root));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(path.join(projectsDir, encoded, 'session-abc.jsonl'), body);
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled: true, share }, vector: { enabled: false } },
    }),
  );
  await runIndexPass({ projectRoot: root, dbPath: path.join(root, '.knowl', 'transcripts.db'), projectsDir });
  return { name, root };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-handlers-'));
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so this redirects
  // defaultProjectsDir() into the fixture and keeps the suite off the developer's own archive.
  homeBefore = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  await fs.mkdir(projectsDirFor(), { recursive: true });
});
afterEach(async () => {
  process.env.HOME = homeBefore.HOME;
  process.env.USERPROFILE = homeBefore.USERPROFILE;
  if (homeBefore.HOME === undefined) delete process.env.HOME;
  if (homeBefore.USERPROFILE === undefined) delete process.env.USERPROFILE;
  await closeTranscriptDbs();
  // Only some tests open the knowledge database; closing it unconditionally keeps the
  // per-test temp root removable and is a no-op when nothing opened one.
  await closeDb().catch(() => {});
  // Swallowed: Windows keeps the databases locked for the life of the process.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('clampInteger', () => {
  it('falls back for non-numbers, NaN and Infinity', () => {
    for (const bad of [undefined, null, 'five', NaN, Infinity, -Infinity]) {
      expect(clampInteger(bad, 5, 1, 25)).toBe(5);
    }
  });

  it('clamps rather than rejecting, and truncates fractions', () => {
    expect(clampInteger(1e9, 5, 1, 25)).toBe(25);
    expect(clampInteger(-7, 2, 0, 10)).toBe(0);
    expect(clampInteger(3.9, 2, 0, 10)).toBe(3);
  });
});

describe('search to read round trip', () => {
  // The blocker this guards: a local hit rendered as transcript://local/... and the reader
  // rejected it as an unknown repo, so no local search result could be read at all.
  it('produces a local locator that read accepts', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);

    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching',
    });

    const locator = /transcript:\/\/\S+/.exec(output)?.[0];
    expect(locator).toBeDefined();
    expect(locator).not.toMatch(/transcript:\/\/local\//);

    const read = await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: locator!,
    });

    expect(read).toContain('a durable finding about caching');
    expect(read).not.toMatch(/unknown repo/i);
  });

  it('reports coverage and the promotion nudge', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching',
    });

    expect(output).toMatch(/Coverage \[.+\]: \d+\/\d+/);
    expect(output).toMatch(/knowl_store/);
  });

  it('refuses an empty query instead of scanning everything', async () => {
    const local = await makeRepo('local', line('anything'), false);
    expect(await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: '   ',
    })).toMatch(/empty query/i);
  });

  it('says the feature is off rather than searching when disabled', async () => {
    const local = await makeRepo('local', line('anything'), false);
    expect(await handleTranscriptSearch({
      config: config({ enabled: false }), projectRoot: local.root, query: 'anything',
    })).toMatch(/not enabled/i);
  });

  it('clamps an absurd limit rather than honouring it', async () => {
    const local = await makeRepo(
      'local',
      Array.from({ length: 40 }, (_, i) => line(`caching note ${i}`)).join(''),
      false,
    );

    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching', limit: 1e9,
    });

    expect((output.match(/transcript:\/\//g) ?? []).length).toBeLessThanOrEqual(25);
  });
});

describe('read authorization', () => {
  it('refuses a peer locator once that peer stops sharing', async () => {
    // A locator is a durable string: cached from an earlier turn, pasted, or fabricated.
    // Checking sharing only at search time would mean revocation does not revoke.
    const local = await makeRepo('local', line('local content'), false);
    await makeRepo('peer', line('peer content about caching'), false); // share: false

    const output = await handleTranscriptRead({
      config: config(),
      projectRoot: local.root,
      locator: 'transcript://peer/session-abc#L1',
    });

    expect(output).toMatch(/not sharing|unknown repo/i);
    expect(output).not.toContain('peer content');
  });

  it('refuses a locator naming a repo that is not linked at all', async () => {
    const local = await makeRepo('local', line('local content'), false);

    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://stranger/session-abc#L1',
    })).toMatch(/unknown repo/i);
  });
});

describe('session prefix resolution', () => {
  it('treats LIKE wildcards as literal characters', async () => {
    const local = await makeRepo('local', line('content here'), false);

    // `%` must not match everything; there is no session whose id contains it.
    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://%25#L1',
    })).toMatch(/no indexed session/i);
  });

  it('accepts an unambiguous session prefix', async () => {
    const local = await makeRepo('local', line('content here'), false);

    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://session-a#L1',
    })).toContain('content here');
  });
});

describe('handleSessionList', () => {
  /** The knowledge database the status and promotion joins read. */
  async function withProject(root: string): Promise<string> {
    await initDb(root);
    return (await repo.createProject(root, 'Session list')).id;
  }

  async function markIndexIncomplete(root: string) {
    const client = await openTranscriptDb(path.join(root, '.knowl', 'transcripts.db'));
    await client.execute('UPDATE transcript_files SET size_at_index = size_at_index + 9999');
  }

  it('renders each session with a locator-compatible id and a status', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    const projectId = await withProject(local.root);

    const output = await handleSessionList({ config: config(), projectRoot: local.root, projectId });

    expect(output).toContain('session-abc');
    expect(output).toMatch(/idle|active|interrupted/);
  });

  it('describes an unnamed session by its opening ask', async () => {
    const local = await makeRepo('local', line('why did the reindex run out of memory?'), false);
    const projectId = await withProject(local.root);

    expect(await handleSessionList({ config: config(), projectRoot: local.root, projectId }))
      .toContain('why did the reindex run out of memory?');
  });

  it('filters over intent rather than message bodies', async () => {
    const local = await makeRepo('local', line('a question about caching'), false);
    const projectId = await withProject(local.root);

    const output = await handleSessionList({
      config: config(), projectRoot: local.root, projectId, query: 'nothingmatchesthis',
    });

    expect(output).toMatch(/no sessions/i);
  });

  it('says the index is still warming rather than implying the list is whole', async () => {
    const local = await makeRepo('local', line('content'), false);
    const projectId = await withProject(local.root);
    await markIndexIncomplete(local.root);

    expect(await handleSessionList({ config: config(), projectRoot: local.root, projectId }))
      .toMatch(/still warming/i);
  });

  it('refuses when the on-disk config says disabled', async () => {
    const local = await makeRepo('local', line('content'), false);
    const projectId = await withProject(local.root);
    await fs.writeFile(
      path.join(local.root, '.knowl', 'config.json'),
      JSON.stringify({
        version: 1,
        security: { rejectSecrets: true, secretPatterns: [] },
        search: { transcripts: { enabled: false }, vector: { enabled: false } },
      }),
    );

    expect(await handleSessionList({ config: config(), projectRoot: local.root, projectId }))
      .toMatch(/not enabled/i);
  });

  it('refuses when the captured config says disabled, without touching the index', async () => {
    const local = await makeRepo('local', line('content'), false);
    const projectId = await withProject(local.root);

    expect(await handleSessionList({
      config: config({ enabled: false }), projectRoot: local.root, projectId,
    })).toMatch(/not enabled/i);
  });
});

describe('disabling revokes an already-running server', () => {
  // createMcpServer captures `config` once and registerTools closes over that snapshot, so a
  // long-lived server would otherwise answer from startup state forever -- serving searches
  // after the feature was turned off, and recreating the index a local read just deleted.
  // The handlers therefore re-read config from disk. `config()` below is the stale snapshot.
  it('refuses a search when the on-disk config says disabled', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    await fs.writeFile(
      path.join(local.root, '.knowl', 'config.json'),
      JSON.stringify({
        version: 1,
        security: { rejectSecrets: true, secretPatterns: [] },
        search: { transcripts: { enabled: false }, vector: { enabled: false } },
      }),
    );

    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching',
    });

    expect(output).toMatch(/not enabled/i);
    expect(output).not.toContain('a durable finding');
  });

  it('refuses a read when the on-disk config says disabled', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    await fs.writeFile(
      path.join(local.root, '.knowl', 'config.json'),
      JSON.stringify({
        version: 1,
        security: { rejectSecrets: true, secretPatterns: [] },
        search: { transcripts: { enabled: false }, vector: { enabled: false } },
      }),
    );

    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://session-a#L1',
    })).toMatch(/not enabled/i);
  });

  it('a read does not recreate an index that was deleted', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    const dbPath = path.join(local.root, '.knowl', 'transcripts.db');

    await closeTranscriptDbs();
    await fs.rm(dbPath, { force: true }).catch(() => {});
    // Windows keeps the file locked for the life of the process once opened; skip rather than
    // assert something the platform will not allow.
    if (await fs.access(dbPath).then(() => true, () => false)) return;

    const output = await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://session-a#L1',
    });

    expect(output).toMatch(/no transcript index/i);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });
});
