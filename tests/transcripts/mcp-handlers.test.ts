import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { clampInteger, handleTranscriptRead, handleTranscriptSearch } from '../../src/transcripts/mcp-handlers.js';
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
