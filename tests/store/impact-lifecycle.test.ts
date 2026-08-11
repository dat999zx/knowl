import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { renderChangeCard } from '../../src/session/change-card.js';
import { listCodeSymbols } from '../../src/code/symbol-index.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent, type HostLifecycleResult } from '../../src/session/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

/**
 * The hook path, end to end: a tool event goes in, read-set rows and findings come out, and the
 * single mid-turn card carries the news.
 *
 * Driven through `handleHostLifecycleEvent` rather than through the helpers it calls, because
 * every claim this lane makes is about *wiring* -- which tool names count, what the config gate
 * covers, which boundary releases, and that the card the agent receives is still one card. A test
 * that called `recordRead` and `detectCertainImpact` directly would pass with none of that
 * connected.
 *
 * Real temp root, real git, real tree-sitter index, following `tests/store/impact.test.ts`: the
 * granularity decision under test *is* "what did the indexer actually produce for this file", and
 * a stubbed symbol list would be testing the fixture's opinion of that.
 *
 * Half of these assert silence -- flag off, `Grep`, a session's own write. That is the point. The
 * certain tier is the only tier allowed to push into an agent's context, and tool-side noise is
 * measured at ~20.8% mean accuracy cost against the agent receiving it, so "did not fire" is the
 * behaviour under test at least as often as "fired".
 */

const SOURCE = 'src/session.ts';

/**
 * Two symbols, and neither exported. The second is the control -- its hash must not move when the
 * first one's signature does, or "one row per symbol" would be indistinguishable from file
 * granularity wearing symbol locators. Unexported because an `export function` yields *two* index
 * symbols (the declaration and its `export:` wrapper), which would make every count below one
 * number away from what the extractor actually does and hide exactly this distinction.
 */
const V1 = `function createSession(user: User): Session {
  return { user };
}

function destroySession(id: string): void {
  void id;
}
`;
const V2_SIGNATURE_CHANGED = `function createSession(user: User, org: Organization): Session {
  return { user, org };
}

function destroySession(id: string): void {
  void id;
}
`;
const WAS_SIGNATURE = 'function createSession(user: User): Session';
const NOW_SIGNATURE = 'function createSession(user: User, org: Organization): Session';

// One directory per test: on Windows the previous database file can still be locked when the next
// test starts, and a silently failed cleanup would carry its read-set rows into the next case --
// where "records nothing" would pass or fail on the leftovers.
let testRoot = '';
let testIndex = 0;
let projectId = '';
let eventIndex = 0;

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
function git(...args: string[]): void {
  const result = spawnSync('git', gitArgs(args), { cwd: testRoot, encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
}

async function write(relativePath: string, contents: string): Promise<void> {
  const full = path.join(testRoot, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
}

/** The real gate: the lifecycle re-reads this file per event, so it can be flipped mid-test. */
async function setImpactEnabled(enabled: boolean): Promise<void> {
  await write('.knowl/config.json', JSON.stringify({ version: 1, impact: { enabled } }));
}

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  // `claude` because it is the host whose profile has a mid-turn channel; on `generic`,
  // `midTurnContext` returns undefined and every card assertion below would pass vacuously.
  host: 'claude',
  event: 'session-event',
  externalSessionId: 'session-a',
  projectRoot: testRoot,
  payload: {},
  ...input,
});

/**
 * One tool call. `captureKey` is unique per event because the debounce fingerprints on the
 * payload, and two reads of the same file inside 1500 ms would otherwise collapse into one --
 * the exact bug `captureKey` was added for.
 */
const toolEvent = (externalSessionId: string, toolName: string, changedPaths: string[]) =>
  handleHostLifecycleEvent(projectId, hook({
    externalSessionId,
    type: 'checkpoint',
    toolName,
    payload: { changedPaths },
    captureKey: `${toolName}:${changedPaths.join(',')}:${eventIndex++}`,
  }));

/** A tool event that touches no file: what the session is doing when the card reaches it. */
const idleEvent = (externalSessionId: string) =>
  handleHostLifecycleEvent(projectId, hook({
    externalSessionId,
    type: 'command',
    // Distinct per call so the skill-capture nudge, which fires on a repeated command, cannot
    // take the mid-turn slot and make a missing impact stanza look like a delivery failure.
    payload: { command: `noop-${eventIndex++}`, exitCode: 0 },
  }));

const card = (result: HostLifecycleResult): string =>
  String((result.hostOutput as Record<string, any> | undefined)?.hookSpecificOutput?.additionalContext ?? '');

const readSetRows = async () => (await getClient().execute(
  'SELECT id, session_id, locator, observed_hash, tool_name, released_at FROM work_read_sets ORDER BY locator',
)).rows;

const findingRows = async () => (await getClient().execute(
  'SELECT id, cause_locator, cause_session, affected_id, tier, delivered_at, resolution, resolved_at FROM impact_findings ORDER BY id',
)).rows;

const knowledgeChange = (title: string) => repo.createKnowledgeCommit(projectId, `Sibling: ${title}`, [
  { itemId: title.toLowerCase().replace(/\s+/g, '-'), action: 'insert', after: { id: title.toLowerCase().replace(/\s+/g, '-'), category: 'fact', title } },
]);

beforeEach(async () => {
  // Not a `.knowl-test-impact-*` name: `tests/store/impact.test.ts` owns that prefix, and two
  // suites sharing one prefix is how a future cleanup sweep deletes the other's live database.
  testRoot = path.join(os.tmpdir(), `knowl-impact-lifecycle-${testIndex++}`);
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(testRoot, '.knowl'), { recursive: true });

  git('init', '-q', '.');
  // The store lives inside the repo it indexes; without this, `git check-ignore` would let the
  // database's own sidecar files into the index.
  await write('.gitignore', '.knowl/\n');
  await write(SOURCE, V1);
  git('add', '-A');
  git('commit', '-qm', 'fixture');

  await initDb(testRoot);
  projectId = (await repo.createProject(testRoot, 'impact lifecycle')).id;
  await setImpactEnabled(true);
});

afterEach(async () => {
  await closeDb();
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
});

describe('change impact on the hook path', () => {
  /**
   * The contribution constraint, tested rather than asserted (plan §5 C-1): a repository that did
   * not opt in must be unable to tell this subsystem exists. Not just "no findings" -- the card
   * has to come out byte-identical, because the card is the only thing the agent ever sees, and
   * `renderChangeCard(summary)` with no second argument is exactly what it rendered before this
   * lane touched the file.
   */
  it('writes nothing and leaves the card byte-identical while the flag is off', async () => {
    await setImpactEnabled(false);

    await toolEvent('session-a', 'Read', [SOURCE]);
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    await toolEvent('session-b', 'Edit', [SOURCE]);

    expect(await readSetRows()).toHaveLength(0);
    expect(await findingRows()).toHaveLength(0);

    await knowledgeChange('Flag off');
    const result = await idleEvent('session-a');

    expect(result.changes?.count).toBe(1);
    expect(card(result)).toBe(renderChangeCard(result.changes));
    expect(card(result)).not.toContain('CODE IMPACT');
  });

  /**
   * The granularity decision. STORM's published limitation is that file-level granularity makes
   * two agents editing different functions in one file a false-positive rejection (plan §6); one
   * row per symbol, at that symbol's signature hash, is what buys the certain tier its ≥95% bar.
   */
  it('records one symbol row per indexed symbol, at the hash the index holds', async () => {
    const result = await toolEvent('session-a', 'Read', [SOURCE]);

    const symbols = await listCodeSymbols(SOURCE);
    expect(symbols.length).toBeGreaterThan(1);

    const rows = await readSetRows();
    expect(rows.map(row => String(row.locator)).sort())
      .toEqual(symbols.map(symbol => symbol.locator).sort());
    for (const row of rows) {
      expect(String(row.locator).startsWith('symbol://')).toBe(true);
      expect(String(row.observed_hash))
        .toBe(symbols.find(symbol => symbol.locator === String(row.locator))?.signatureHash);
      expect(String(row.tool_name)).toBe('Read');
      expect(String(row.session_id)).toBe(result.sessionId);
      expect(row.released_at).toBeNull();
    }
    // The coarse locator is the fallback, never a companion: a file row alongside symbol rows
    // would re-report every symbol read as changed on the first comment edit anywhere in the file.
    expect(rows.some(row => String(row.locator).startsWith('file://'))).toBe(false);
  });

  it('falls back to a single file:// row for a file the indexer yields no symbols for', async () => {
    await write('docs/notes.md', '# Notes\n');
    await toolEvent('session-a', 'Read', ['docs/notes.md']);

    expect((await readSetRows()).map(row => String(row.locator))).toEqual(['file://docs/notes.md']);
  });

  /** The cap, so one `Read` of a barrel file cannot write hundreds of rows per tool call. */
  it('falls back to a single file:// row above the symbol cap', async () => {
    const big = Array.from({ length: 201 }, (_, index) => `function f${index}() {}\n`).join('');
    await write('src/big.ts', big);

    await toolEvent('session-a', 'Read', ['src/big.ts']);

    expect((await listCodeSymbols('src/big.ts')).length).toBe(201);
    expect((await readSetRows()).map(row => String(row.locator))).toEqual(['file://src/big.ts']);
  });

  /**
   * `Grep` is excluded from the read set entirely, not merely protected from its directory case.
   * A directory locator would make every edit beneath it an invalidation, and a *file* locator
   * would claim the session saw every symbol in a file it only received matching lines from --
   * a belief it does not hold, invoiced to the tier that is allowed to interrupt.
   */
  it('records nothing for a Grep, whether it named a directory or a file', async () => {
    await toolEvent('session-a', 'Grep', ['src']);
    await toolEvent('session-a', 'Grep', [SOURCE]);
    await toolEvent('session-a', 'Glob', [SOURCE]);

    expect(await readSetRows()).toHaveLength(0);
  });

  it('reports another session write against this session read, in the card', async () => {
    const reader = await toolEvent('session-a', 'Read', [SOURCE]);
    const changed = (await readSetRows()).find(row => String(row.locator).endsWith('#createSession'));

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const writer = await toolEvent('session-b', 'Edit', [SOURCE]);

    // One finding, not two: the same edit rewrote the file `destroySession` lives in, and its
    // reader is untouched. That is the whole reason the rows are per symbol.
    const findings = await findingRows();
    expect(findings).toHaveLength(1);
    expect(String(findings[0].tier)).toBe('certain');
    expect(String(findings[0].affected_id)).toBe(String(changed?.id));
    expect(String(findings[0].cause_session)).toBe(writer.sessionId);
    expect(String(findings[0].cause_locator)).toBe(`symbol://${SOURCE}#createSession`);

    // The writing session is told nothing on its own next event: it holds no stale read, and the
    // notice would be pure tool-side noise in the context of the one actor that already knows.
    expect(card(await idleEvent('session-b'))).not.toContain('CODE IMPACT');

    const delivered = card(await idleEvent('session-a'));
    expect(delivered).toContain('CODE IMPACT');
    expect(delivered).toContain('createSession');
    // The was/now pair only survives because detection snapshots the pre-change signature before
    // it re-indexes; if this lane re-indexed the file first, both lines would be gone.
    expect(delivered).toContain('was: ');
    expect(delivered).toContain('now: ');
    expect(delivered).toContain('Organization');
    expect(reader.sessionId).not.toBe(writer.sessionId);
  });

  /**
   * The repeat window, closed. An open finding used to re-render on every subsequent tool event
   * until somebody adjudicated it, which spends the tool-side channel this subsystem's own
   * argument calls expensive. `delivered_at` is what stops it -- and the thing worth pinning is
   * that stopping the card did *not* close the finding: `resolution` stays NULL, so the finding is
   * still open for the gate and still in the denominator the precision number is computed from.
   * Quieting a card by spending `dismissed` would have corrupted that measurement.
   */
  it('shows a finding once, and leaves it open and unadjudicated after showing it', async () => {
    await toolEvent('session-a', 'Read', [SOURCE]);
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    await toolEvent('session-b', 'Edit', [SOURCE]);

    expect(card(await idleEvent('session-a'))).toContain('CODE IMPACT');
    // Every event after the first: silent.
    expect(card(await idleEvent('session-a'))).not.toContain('CODE IMPACT');
    expect(card(await idleEvent('session-a'))).not.toContain('CODE IMPACT');

    const [finding] = await findingRows();
    expect(finding.delivered_at).not.toBeNull();
    expect(finding.resolution).toBeNull();
    expect(finding.resolved_at).toBeNull();
  });

  it('never reports a session against its own write', async () => {
    await toolEvent('session-a', 'Read', [SOURCE]);
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    await toolEvent('session-a', 'Edit', [SOURCE]);

    expect(await findingRows()).toHaveLength(0);
    const result = await idleEvent('session-a');
    expect(result.hostOutput).toBeUndefined();
  });

  /**
   * The single-occupancy rule (`host-lifecycle.ts`: "At most one card per tool event, never two",
   * pinned by `tests/mcp/dual-channel-notification.test.ts`). Two kinds of news, one envelope.
   */
  it('carries knowledge changes and impact in one card, not two', async () => {
    await toolEvent('session-a', 'Read', [SOURCE]);
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    await toolEvent('session-b', 'Edit', [SOURCE]);
    await knowledgeChange('Both stanzas');

    const result = await idleEvent('session-a');
    const delivered = card(result);

    expect(Object.keys(result.hostOutput ?? {})).toEqual(['hookSpecificOutput']);
    expect(delivered.match(/KNOWL CHANGED:/g)).toHaveLength(1);
    expect(delivered.match(/CODE IMPACT:/g)).toHaveLength(1);
    expect(delivered).toBe(renderChangeCard(result.changes, [{
      locator: `symbol://${SOURCE}#createSession`,
      wasSignature: WAS_SIGNATURE,
      nowSignature: NOW_SIGNATURE,
    }]));
  });

  /**
   * Impact alone renders a card, which is why the renderer's summary is optional -- and it must
   * reset the drift counter exactly as a change card does, or the generic continuation reminder
   * fires later at an agent that was just handed something specific.
   */
  it('renders a card from impact alone, with no knowledge change to carry it', async () => {
    await toolEvent('session-a', 'Read', [SOURCE]);
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    await toolEvent('session-b', 'Edit', [SOURCE]);

    const result = await idleEvent('session-a');

    expect(result.changes).toBeUndefined();
    expect(card(result)).toContain('CODE IMPACT');
    expect(card(result)).not.toContain('KNOWL CHANGED');

    const counters = (await getClient().execute({
      sql: 'SELECT successful_tool_count FROM host_session_bindings WHERE memory_session_id = ?',
      args: [String(result.sessionId)],
    })).rows;
    expect(counters.map(row => Number(row.successful_tool_count))).toEqual([0]);
  });

  /**
   * Release follows the *memory session*, not the turn. A Claude `Stop` ends one response inside a
   * conversation that keeps its context: the agent still holds every file it read, and releasing
   * there would disarm the detector for the rest of the session.
   */
  it('keeps the read-set live across a turn stop and releases it at session stop', async () => {
    await handleHostLifecycleEvent(projectId, hook({ event: 'turn-start', externalSessionId: 'session-a', title: 'Agent turn' }));
    await toolEvent('session-a', 'Read', [SOURCE]);
    expect((await readSetRows()).length).toBeGreaterThan(0);

    await handleHostLifecycleEvent(projectId, hook({ event: 'turn-stop', externalSessionId: 'session-a', status: 'finished' }));
    for (const row of await readSetRows()) expect(row.released_at).toBeNull();

    await handleHostLifecycleEvent(projectId, hook({ event: 'session-stop', externalSessionId: 'session-a', status: 'finished' }));
    const rows = await readSetRows();
    expect(rows.length).toBeGreaterThan(0);
    // Released, never deleted: the row is the evidence a finding was justified and the denominator
    // the precision number is computed against.
    for (const row of rows) expect(row.released_at).not.toBeNull();
  });
});
