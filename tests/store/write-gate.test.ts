import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { listCodeSymbols, indexFile } from '../../src/code/symbol-index.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import { detectCertainImpact } from '../../src/store/impact.js';
import { recordRead } from '../../src/store/read-set.js';
import * as repo from '../../src/store/repository.js';
import { shouldRefuseWrite } from '../../src/store/write-gate.js';

/**
 * The write gate, tested as a *refusal* claim: what it blocks, and far more often what it does not.
 *
 * Two thirds of these assert that a write went through. That is the shape of the thing -- a gate
 * that wrongly refuses does not cost recall on an advisory notice, it costs a person the ability
 * to edit a file, and the design's answer to every uncertain case is to allow. So the suite is
 * mostly a list of ways to *not* be blocked: flag off, own change, released read, a sibling symbol,
 * a different file, a broken store, a host that cannot refuse.
 *
 * The remaining claim is the one that decides whether this feature is tolerable at all: a refusal
 * cannot repeat. An agent that is blocked, does what it was told, and is blocked again has been
 * trapped by its memory server, which is strictly worse than never having had a gate.
 *
 * Real git repo, real tree-sitter index and the real detector, following `tests/store/impact.test
 * .ts`. Every condition the gate refuses on is `impact.ts`'s verdict rather than this suite's, and
 * a seeded finding row would test this file's idea of staleness instead of the one that ships.
 */

const SOURCE = 'src/session.ts';
const OTHER = 'src/other.ts';

/**
 * Two symbols, neither exported -- the fixture `tests/store/impact-lifecycle.test.ts` uses, for
 * its reason: `export function` yields two index symbols (the declaration and its `export:`
 * wrapper), which hides exactly the per-symbol distinction the sibling-symbol case turns on.
 */
const V1 = `function createSession(user: User): Session {
  return { user };
}

function destroySession(id: string): void {
  void id;
}
`;
const V2 = `function createSession(user: User, org: Organization): Session {
  return { user, org };
}

function destroySession(id: string): void {
  void id;
}
`;
const V3 = `function createSession(user: User, org: Organization, at: number): Session {
  return { user, org, at };
}

function destroySession(id: string): void {
  void id;
}
`;
const WAS_SIGNATURE = 'function createSession(user: User): Session';
const NOW_SIGNATURE = 'function createSession(user: User, org: Organization): Session';

const READER = 'sess-reader';
const WRITER = 'sess-writer';
const AT = '2026-08-05T00:00:00.000Z';

// One directory per test: on Windows the previous database file can still be locked when the next
// test starts, and a silently failed cleanup would carry read-set rows into the next case, where
// "allowed the write" would pass or fail on the leftovers.
let testRoot = '';
let testIndex = 0;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: testRoot, encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
}

async function write(relativePath: string, contents: string): Promise<void> {
  const full = path.join(testRoot, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
}

/** The real gate: the config is re-read per call, so it can be flipped mid-test. */
async function setImpactEnabled(enabled: boolean): Promise<void> {
  await write('.knowl/config.json', JSON.stringify({ version: 1, impact: { enabled } }));
}

async function symbolHashOf(relativePath: string, qualifiedName: string): Promise<string> {
  const symbols = await listCodeSymbols(relativePath);
  const hash = symbols.find(symbol => symbol.qualifiedName === qualifiedName)?.signatureHash;
  if (!hash) throw new Error(`no indexed signature hash for ${qualifiedName} in ${relativePath}`);
  return hash;
}

/**
 * A read-set row written directly rather than through the capture path.
 *
 * The capture path is another branch of this lane and is exercised by `impact-lifecycle.test.ts`;
 * what this suite owns is the gate's reaction to a belief that exists. The row is therefore the
 * fixture -- but only the row: which rows still count is `activeReadSetForSession`'s answer, not
 * this helper's, which is what makes the released case below mean anything.
 */
async function seedRead(id: string, sessionId: string, locator: string, observedHash: string): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO work_read_sets (id, session_id, agent_id, task_id, locator, observed_hash, tool_name, read_at, released_at)
          VALUES (?, ?, NULL, NULL, ?, ?, 'Read', ?, NULL)`,
    args: [id, sessionId, locator, observedHash, AT],
  });
}

const readRow = async (id: string) => (await getClient().execute({
  sql: 'SELECT released_at FROM work_read_sets WHERE id = ?',
  args: [id],
})).rows[0];

/**
 * The situation the gate exists for: READER read `createSession`, somebody else changed it.
 *
 * Returns after asserting the detector actually produced the finding, so a fixture that stopped
 * reproducing staleness fails here rather than as a mystery "allowed the write" three lines later.
 */
async function makeStale(causeSession = WRITER): Promise<void> {
  await indexFile(testRoot, SOURCE);
  await seedRead('read-1', READER, `symbol://${SOURCE}#createSession`, await symbolHashOf(SOURCE, 'createSession'));
  await write(SOURCE, V2);
  const findings = await detectCertainImpact(testRoot, [SOURCE], causeSession);
  if (causeSession !== READER && findings.length !== 1) {
    throw new Error(`fixture produced ${findings.length} findings, expected 1`);
  }
}

beforeEach(async () => {
  testRoot = path.resolve(`./.knowl-test-write-gate-${testIndex++}`);
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(testRoot, '.knowl'), { recursive: true });

  git('init', '-q', '.');
  git('config', 'user.email', 'lane-l@example.test');
  git('config', 'user.name', 'lane l');
  // The store lives inside the repo it indexes, so it has to be ignored.
  await write('.gitignore', '.knowl/\n');
  await write(SOURCE, V1);
  await write(OTHER, 'function unrelated(): void {}\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');

  await initDb(testRoot);
  await setImpactEnabled(true);
});

afterEach(async () => {
  await closeDb();
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
});

describe('write gate — refusing', () => {
  it('refuses a write to a file whose read symbol moved, and says what moved', async () => {
    await makeStale();

    const decision = await shouldRefuseWrite(testRoot, READER, [path.join(testRoot, SOURCE)]);

    expect(decision.deny).toBe(true);
    const reason = decision.reason ?? '';
    // The file, because the agent has to know where to look; the pair, because a refusal without
    // the diff is the bare announcement measured at no consistent improvement over silence.
    expect(reason).toContain(SOURCE);
    expect(reason).toContain(`was: ${WAS_SIGNATURE}`);
    expect(reason).toContain(`now: ${NOW_SIGNATURE}`);
    // The instruction is the payload's third part: an agent told "no" with no next step retries.
    expect(reason).toContain(`Re-read ${SOURCE}`);
  });

  it('re-arms after the belief is observed again, so the block is per stale read and not per file', async () => {
    await makeStale();
    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(true);

    // The agent does what it was told: re-reads, and now holds the current signature.
    await recordRead({
      sessionId: READER,
      locator: `symbol://${SOURCE}#createSession`,
      observedHash: await symbolHashOf(SOURCE, 'createSession'),
    });
    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);

    // A *second* foreign change to the same symbol is a new stale belief, and must block again --
    // otherwise the one-shot would be a permanent disarm of the file it fired on.
    await write(SOURCE, V3);
    await detectCertainImpact(testRoot, [SOURCE], WRITER);
    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(true);
  });
});

describe('write gate — allowing', () => {
  it('never refuses the same write twice: the retry goes through', async () => {
    await makeStale();

    const first = await shouldRefuseWrite(testRoot, READER, [SOURCE]);
    expect(first.deny).toBe(true);
    // The one-shot has to be durable and not merely intended: the row it named is released, which
    // is what makes the second answer independent of the agent having re-read anything. An agent
    // that re-reads with `cat` updates no read-set row, and without this would be refused forever
    // for doing exactly what it was asked.
    expect(first.releasedReadIds).toEqual(['read-1']);
    expect((await readRow('read-1')).released_at).not.toBeNull();

    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows when nothing this session read has moved', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead('read-1', READER, `symbol://${SOURCE}#createSession`, await symbolHashOf(SOURCE, 'createSession'));
    expect(await detectCertainImpact(testRoot, [SOURCE], WRITER)).toEqual([]);

    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows when this session made the change itself', async () => {
    // The common case, not an exotic one: an agent reads a file and then edits it twice. Without
    // self-exclusion every second edit in that sequence is refused.
    await makeStale(READER);

    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows when the repository never turned impact detection on', async () => {
    await makeStale();
    await setImpactEnabled(false);

    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows when the read that justified the finding was already released', async () => {
    await makeStale();
    await getClient().execute({
      sql: 'UPDATE work_read_sets SET released_at = ? WHERE id = ?',
      args: [AT, 'read-1'],
    });

    // A finished task or session no longer holds the belief, and `openFindingsForSession`
    // deliberately does not filter on release -- so the gate, not the query, has to decide this.
    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows a write to a file this session has no stale read in', async () => {
    await makeStale();

    expect((await shouldRefuseWrite(testRoot, READER, [OTHER])).deny).toBe(false);
    expect((await readRow('read-1')).released_at).toBeNull();
  });

  it('allows an edit to a file where a different symbol moved than the one this session read', async () => {
    // STORM's own stated limitation, and the single reason this is symbol-granular: two agents
    // editing different functions in one file must not block each other.
    await indexFile(testRoot, SOURCE);
    await seedRead('read-1', READER, `symbol://${SOURCE}#destroySession`, await symbolHashOf(SOURCE, 'destroySession'));
    await write(SOURCE, V2);
    expect(await detectCertainImpact(testRoot, [SOURCE], WRITER)).toEqual([]);

    expect((await shouldRefuseWrite(testRoot, READER, [SOURCE])).deny).toBe(false);
  });

  it('allows, rather than throwing, when the store cannot answer', async () => {
    await makeStale();
    await getClient().execute('DROP TABLE impact_findings');

    await expect(shouldRefuseWrite(testRoot, READER, [SOURCE])).resolves.toMatchObject({ deny: false });
  });
});

describe('write gate — on the hook path', () => {
  /**
   * `generic` because it is the host with no native hook protocol at all, so it has no pre-tool
   * callback to refuse through. Pinning the degradation to a host that could later gain one would
   * make this test flip from "degrades correctly" to "fails" the day it did.
   */
  const precheck = (sessionId: string, toolName: string, changedPaths: string[]): NormalizedHostHook => ({
    host: 'generic',
    event: 'tool-precheck',
    externalSessionId: sessionId,
    projectRoot: testRoot,
    toolName,
    payload: { changedPaths },
  });

  it('degrades to allowing on a host that cannot refuse, and spends nothing doing it', async () => {
    const projectId = (await repo.createProject(testRoot, 'write gate')).id;
    const started = await handleHostLifecycleEvent(projectId, {
      host: 'generic',
      event: 'session-start',
      externalSessionId: 'host-session',
      projectRoot: testRoot,
      payload: {},
    });
    const sessionId = started.sessionId ?? '';
    expect(sessionId).not.toBe('');

    await indexFile(testRoot, SOURCE);
    await seedRead('read-1', sessionId, `symbol://${SOURCE}#createSession`, await symbolHashOf(SOURCE, 'createSession'));
    await write(SOURCE, V2);
    await detectCertainImpact(testRoot, [SOURCE], WRITER);

    const result = await handleHostLifecycleEvent(projectId, precheck('host-session', 'Edit', [SOURCE]));

    expect(result.accepted).toBe(true);
    expect(result.hostOutput).toBeUndefined();
    // The refusal was never attempted, so the one-shot is still armed for a host that can deliver
    // one. Asking the gate first and discarding the answer would silently disarm it here.
    expect((await readRow('read-1')).released_at).toBeNull();
  });

  it('does not treat a pre-tool event as a session boundary', async () => {
    const projectId = (await repo.createProject(testRoot, 'write gate')).id;
    await handleHostLifecycleEvent(projectId, {
      host: 'generic',
      event: 'session-start',
      externalSessionId: 'host-session',
      projectRoot: testRoot,
      payload: {},
    });

    // Every unrecognised event falls through to the session-stop handler, which finishes the
    // memory session and promotes it. A pre-tool event arriving before every write would end the
    // session on the agent's first edit.
    const result = await handleHostLifecycleEvent(projectId, precheck('host-session', 'Read', [SOURCE]));

    expect(result).toEqual({ accepted: true });
  });
});
