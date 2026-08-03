import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { searchTranscriptsFederated } from '../../src/transcripts/federate.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import type { ActiveWorkspace, PeerRepo } from '../../src/workspace/resolve.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-fed-'));
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed: Windows keeps the databases locked for the life of the process.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (text: string) =>
  JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

type Repo = { name: string; root: string; dbPath: string };

/** Build a repo with its own transcripts and its own config, and index it. */
async function makeRepo(name: string, body: string, share: boolean): Promise<Repo> {
  const root = path.join(dir, name);
  const projectsDir = path.join(dir, `${name}-projects`);
  const encoded = encodeProjectDir(path.resolve(root));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(path.join(projectsDir, encoded, 's.jsonl'), line(body));
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled: true, share } },
    }),
  );
  const dbPath = path.join(root, '.knowl', 'transcripts.db');
  await runIndexPass({ projectRoot: root, dbPath, projectsDir });
  return { name, root, dbPath };
}

/** The real PeerRepo shape: `root`, not `path`. */
const peerOf = (repo: { name: string; root: string }): PeerRepo => ({
  name: repo.name,
  root: repo.root,
  databasePath: path.join(repo.root, '.knowl', 'knowl.db'),
  present: true,
});

const workspaceOf = (peers: Array<{ name: string; root: string }>): ActiveWorkspace => ({
  name: 'ws',
  repo: 'local',
  manifest: {} as never,
  peers: peers.map(peerOf),
});

describe('searchTranscriptsFederated', () => {
  it('returns hits from a sharing peer, tagged with its repo', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits.map(h => h.repo).sort()).toEqual(['local', 'peer']);
  });

  it('skips a peer that has not opted into sharing', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', false);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits.every(h => h.repo === 'local')).toBe(true);
    expect(result.skipped).toContainEqual({ repo: 'peer', reason: 'not-shared' });
  });

  it('narrows to the named repos', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
      repos: ['peer'],
    });

    expect(result.hits.every(h => h.repo === 'peer')).toBe(true);
  });

  it('skips a peer with no index rather than failing the search', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([{ name: 'ghost', root: path.join(dir, 'ghost') }]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.skipped).toContainEqual({ repo: 'ghost', reason: 'absent' });
  });

  // `present: false` is how resolveWorkspace reports a peer that is not checked out here.
  it('skips a peer the workspace reports as not present', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: { ...workspaceOf([peer]), peers: [{ ...peerOf(peer), present: false }] },
      query: 'caching',
      limit: 10,
    });

    expect(result.hits.every(h => h.repo === 'local')).toBe(true);
    expect(result.skipped).toContainEqual({ repo: 'peer', reason: 'absent' });
  });

  it('searches only the local repo when there is no workspace', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: null, query: 'caching', limit: 10,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].repo).toBe('local');
  });

  it('reports coverage per repo rather than summing it', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'caching', limit: 10,
    });

    expect(result.coverage.map(c => c.repo).sort()).toEqual(['local', 'peer']);
    for (const entry of result.coverage) expect(entry.indexed).toBeGreaterThan(0);
  });

  it('does not merge two repos\' hits that share a message id', async () => {
    // Both indexes are built identically, so both hold message_id 1. Keying fusion on the bare
    // message id would collapse them into a single hit.
    const local = await makeRepo('local', 'identical wording here', true);
    const peer = await makeRepo('peer', 'identical wording here', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'identical wording', limit: 10,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map(h => h.repo).sort()).toEqual(['local', 'peer']);
  });

  it('does not rank by repo order when both repos match equally well', async () => {
    // Identical corpora: whichever repo is visited first must not win by construction. RRF over
    // positions gives both rank-1 hits the same score, so neither is systematically ahead.
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peer = await makeRepo('peer', 'symmetric content about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'symmetric caching', limit: 10,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].score).toBeCloseTo(result.hits[1].score, 10);
  });

  // Equal scores are the normal case in federation, so the cutoff is where bias actually shows.
  // Asserting score equality alone passes even when local always wins.
  it('does not let the local repo win the cutoff purely by being searched first', async () => {
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peerA = await makeRepo('peer-a', 'symmetric content about caching', true);
    const peerB = await makeRepo('peer-b', 'symmetric content about caching', true);

    const winners = new Set<string>();
    for (const peers of [[peerA, peerB], [peerB, peerA]]) {
      const result = await searchTranscriptsFederated({
        projectRoot: local.root, workspace: workspaceOf(peers),
        query: 'symmetric caching', limit: 1,
      });
      expect(result.hits).toHaveLength(1);
      winners.add(result.hits[0].repo);
    }

    // Reversing the peer order must not change the winner -- the tiebreak is on the hit's
    // identity, not on which repo was visited first.
    expect(winners.size).toBe(1);
  });

  it('returns the same order whatever order the peers are listed in', async () => {
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peerA = await makeRepo('peer-a', 'symmetric content about caching', true);
    const peerB = await makeRepo('peer-b', 'symmetric content about caching', true);

    const order = async (peers: Array<{ name: string; root: string }>) =>
      (await searchTranscriptsFederated({
        projectRoot: local.root, workspace: workspaceOf(peers), query: 'symmetric caching', limit: 10,
      })).hits.map(hit => hit.repo);

    expect(await order([peerA, peerB])).toEqual(await order([peerB, peerA]));
  });

  it('names the local repo so a caller can omit it from a locator', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: null, query: 'caching', limit: 10,
    });

    expect(result.localRepo).toBe('local');
    expect(result.hits[0].repo).toBe(result.localRepo);
  });

  // A peer is read, never migrated or created: revoking sharing must leave no residue behind.
  it('does not write to a peer database it searches', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);
    await closeTranscriptDbs();

    const before = await fs.readFile(peer.dbPath);
    await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'caching', limit: 10,
    });
    await closeTranscriptDbs();

    expect(await fs.readFile(peer.dbPath)).toEqual(before);
  });
});
