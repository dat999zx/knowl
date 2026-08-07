import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb, withClientTransaction } from '../../src/store/database.js';
import {
  READ_SET_CHUNK,
  activeReadSetForSession,
  activeReadersOf,
  normalizeLocator,
  recordRead,
  recordReads,
  releaseReadSet,
  sweepReadSets,
  sweepReadSetsBestEffort,
} from '../../src/store/read-set.js';

/**
 * The read-set store: what a session read, hashed at read time.
 *
 * The assertions that matter here are the ones about what is *not* stored and what is *not*
 * returned. A row that should not exist (a directory locator, a duplicate of an observation
 * already on file) and a row that should no longer be live (released, superseded) both become
 * false positives on the one tier allowed to interrupt an agent, which is the tier this table
 * exists to serve.
 */
const ROOT = path.join(os.tmpdir(), 'knowl-read-set-test');

const rowsFor = async (sessionId: string) =>
  (await getClient().execute({
    sql: 'SELECT id, locator, observed_hash, released_at FROM work_read_sets WHERE session_id = ? ORDER BY observed_hash',
    args: [sessionId],
  })).rows;

const countFor = async (sessionId: string): Promise<number> => (await rowsFor(sessionId)).length;

describe('work read-set store', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records a read and returns it with every field mapped', async () => {
    await recordRead({
      sessionId: 'sess-record',
      agentId: '__agent__:lane-d',
      locator: 'symbol://src/auth/session.ts#createSession',
      observedHash: 'h-sig-1',
      toolName: 'Read',
    });

    const [entry, ...rest] = await activeReadSetForSession('sess-record');
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      sessionId: 'sess-record',
      agentId: '__agent__:lane-d',
      locator: 'symbol://src/auth/session.ts#createSession',
      observedHash: 'h-sig-1',
      toolName: 'Read',
      releasedAt: null,
    });
    expect(entry.id).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.parse(entry.readAt)).not.toBeNaN();
  });

  /** The optional columns are absent, not empty strings, so a blank one never matches a lookup. */
  it('stores omitted and blank agent and tool as NULL', async () => {
    await recordRead({
      sessionId: 'sess-nulls',
      agentId: '   ',
      locator: 'file://src/plain.ts',
      observedHash: 'h-plain',
    });

    const [entry] = await activeReadSetForSession('sess-nulls');
    expect(entry.agentId).toBeNull();
    expect(entry.toolName).toBeNull();
  });

  /**
   * The capture path fires on every tool call and agents re-read constantly. Without this the
   * table grows with tool calls rather than with distinct observations, and the plan's own
   * steady-state-rows target is unmeetable by construction.
   */
  it('is idempotent when the same session re-reads the same locator at the same hash', async () => {
    const observation = {
      sessionId: 'sess-idem',
      locator: 'file://src/idem.ts',
      observedHash: 'h-same',
      toolName: 'Read',
    };
    await recordRead(observation);
    const [first] = await activeReadSetForSession('sess-idem');

    await recordRead(observation);
    await recordRead({ ...observation, toolName: 'Edit' });

    const live = await activeReadSetForSession('sess-idem');
    expect(live).toHaveLength(1);
    // The same row, not a replacement one: the first read is when the belief was formed.
    expect(live[0].id).toBe(first.id);
    expect(live[0].toolName).toBe('Read');
    expect(await countFor('sess-idem')).toBe(1);
  });

  /** Dedupe is scoped to unreleased rows, or a session that finishes a task and reads the same
   * file again would be treated as still holding the finished row and never record the new read. */
  it('records the read again once the earlier one has been released', async () => {
    await recordRead({ sessionId: 'sess-rearm', locator: 'file://src/rearm.ts', observedHash: 'h-rearm' });
    await releaseReadSet('sess-rearm');
    await recordRead({ sessionId: 'sess-rearm', locator: 'file://src/rearm.ts', observedHash: 'h-rearm' });

    expect(await activeReadSetForSession('sess-rearm')).toHaveLength(1);
    expect(await countFor('sess-rearm')).toBe(2);
  });

  /**
   * A changed hash is a genuinely new observation -- the agent has now seen a newer version -- and
   * the belief it replaces is retired in the same call. Leaving both live would let the certain
   * tier report the session as stale for a change it has already read: a guaranteed false positive
   * on the only tier permitted to push and gate.
   */
  it('records a new row at a changed hash and retires the belief it replaces', async () => {
    await recordRead({ sessionId: 'sess-moved', locator: 'file://src/moved.ts', observedHash: 'h-old' });
    await recordRead({ sessionId: 'sess-moved', locator: 'file://src/moved.ts', observedHash: 'h-new' });

    const live = await activeReadSetForSession('sess-moved');
    expect(live).toHaveLength(1);
    expect(live[0].observedHash).toBe('h-new');

    const stored = await rowsFor('sess-moved');
    expect(stored).toHaveLength(2);
    expect(String(stored[0].observed_hash)).toBe('h-new');
    expect(stored[0].released_at).toBeNull();
    expect(String(stored[1].observed_hash)).toBe('h-old');
    expect(stored[1].released_at).not.toBeNull();
  });

  /** Another session's belief about the same locator is its own; only the re-reader's is retired. */
  it('retires only the re-reading session, not every reader of the locator', async () => {
    await recordRead({ sessionId: 'sess-mine', locator: 'file://src/shared.ts', observedHash: 'h-1' });
    await recordRead({ sessionId: 'sess-theirs', locator: 'file://src/shared.ts', observedHash: 'h-1' });
    await recordRead({ sessionId: 'sess-mine', locator: 'file://src/shared.ts', observedHash: 'h-2' });

    const readers = await activeReadersOf(['file://src/shared.ts']);
    expect(readers.map(entry => [entry.sessionId, entry.observedHash]).sort()).toEqual([
      ['sess-mine', 'h-2'],
      ['sess-theirs', 'h-1'],
    ]);
  });

  /**
   * The load-bearing rejection. `Grep`'s `path` argument is allowlisted through the stdin filter
   * and arrives on the same stream every other tool's file path does, so a directory can reach
   * this call -- and a directory in the read-set makes every edit beneath it look like it
   * invalidated the session. Rejection is silent: this runs inside a capture path that must not
   * fail the tool call it is observing.
   */
  it('rejects directory and malformed locators without throwing', async () => {
    const refused = [
      'src/store',                    // a Grep `path` argument: no scheme, no extension
      'file://src/store',             // the same directory, correctly schemed
      'file://src/store/',            // trailing slash
      'file:///abs/leading.ts',       // leading slash: aliases the relative form
      'file://src/../store/a.ts',     // `..` segment: two locators for one file
      'file://src/./a.ts',            // `.` segment: likewise
      'file://',                      // empty path
      'file://src/a.ts#Name',         // a symbol locator wearing the file scheme
      'symbol://src/a.ts',            // no symbol name
      'symbol://src/a.ts#',           // empty symbol name
      'symbol://src/store#Name',      // symbol on a directory
      'http://example.com/a.ts',      // not a locator at all
      '',
      '   ',
      // Deliberate recall cost, not an oversight: extensionless names are rejected so that
      // directories are, and losing a `.gitignore` read is cheaper than a per-write false positive.
      'file://.gitignore',
      'file://Makefile',
    ];

    for (const locator of refused) {
      expect(normalizeLocator(locator), locator).toBeNull();
      await expect(recordRead({ sessionId: 'sess-junk', locator, observedHash: 'h' })).resolves.toBeUndefined();
    }
    expect(await countFor('sess-junk')).toBe(0);
  });

  /** A row that cannot answer the question the table exists to answer is not worth storing. */
  it('rejects a read with no session or no hash as of the read', async () => {
    await recordRead({ sessionId: '', locator: 'file://src/a.ts', observedHash: 'h' });
    await recordRead({ sessionId: 'sess-blank', locator: 'file://src/a.ts', observedHash: '  ' });
    expect(await countFor('')).toBe(0);
    expect(await countFor('sess-blank')).toBe(0);
  });

  /**
   * Windows separators are normalized rather than rejected. Storing both spellings would mean the
   * detector's equality never fires on the platform this repo is developed on.
   */
  it('canonicalises separators so a write and a read agree on one locator', async () => {
    expect(normalizeLocator('symbol://src\\auth\\session.ts#createSession'))
      .toBe('symbol://src/auth/session.ts#createSession');

    await recordRead({ sessionId: 'sess-win', locator: 'file://src\\win\\file.ts', observedHash: 'h-win' });
    const [entry] = await activeReadSetForSession('sess-win');
    expect(entry.locator).toBe('file://src/win/file.ts');
    // Found by either spelling, because both normalise to the stored one.
    expect(await activeReadersOf(['file://src\\win\\file.ts'])).toHaveLength(1);
  });

  /**
   * The detector hands over every locator a re-indexed file produced, which is unbounded in the
   * size of the file. An unbounded `IN (...)` is a hard bind-parameter error, not a slow query.
   */
  it('answers a locator list well past one chunk', async () => {
    const total = READ_SET_CHUNK + 50;
    expect(READ_SET_CHUNK).toBe(200);

    const locators = Array.from({ length: total }, (_, index) => `file://src/bulk/f${index}.ts`);
    // Seeded in one transaction rather than 250 calls to `recordRead`.
    //
    // What is under test is how `activeReadersOf` chunks its query, not how fast rows go in, and
    // a bare `execute` is its own implicit transaction -- so the loop was paying one fsync per
    // row and the test's runtime became a function of the `synchronous` pragma. It passed at
    // NORMAL and timed out at FULL, which made a chunking assertion silently dependent on an
    // unrelated engine setting. The insert matches `recordRead`'s own shape; the dedupe and
    // locator-rejection rules it enforces have their own tests above.
    // `getClient()` rather than the connection the helper hands over: a SQLite transaction
    // belongs to the connection, so statements issued on the base client between its BEGIN and
    // COMMIT are inside it -- which is what `withClientTransaction` documents about itself.
    await withClientTransaction(async () => {
      const client = getClient();
      for (const [index, locator] of locators.entries()) {
        await client.execute({
          sql: `INSERT INTO work_read_sets (id, session_id, agent_id, locator, observed_hash, tool_name, read_at, released_at)
                VALUES (?, 'sess-bulk', NULL, ?, ?, 'Read', ?, NULL)`,
          args: [`readbulk${String(index).padStart(4, '0')}`, locator, `h-${locator}`, new Date().toISOString()],
        });
      }
    });
    // One locator nobody read, and one duplicate: neither may change the count.
    const asked = [...locators, 'file://src/bulk/absent.ts', locators[0]];

    const readers = await activeReadersOf(asked);
    expect(readers).toHaveLength(total);
    expect(new Set(readers.map(entry => entry.locator)).size).toBe(total);
  });

  it('returns nothing for an empty or entirely invalid locator list', async () => {
    expect(await activeReadersOf([])).toEqual([]);
    expect(await activeReadersOf(['src/store', 'file://src/store'])).toEqual([]);
  });

  it('releases a whole session and reports how many rows it took', async () => {
    await recordRead({ sessionId: 'sess-rel', locator: 'file://src/rel1.ts', observedHash: 'h1' });
    await recordRead({ sessionId: 'sess-rel', locator: 'file://src/rel2.ts', observedHash: 'h2' });

    expect(await releaseReadSet('sess-rel')).toBe(2);
    expect(await activeReadSetForSession('sess-rel')).toEqual([]);
    expect(await activeReadersOf(['file://src/rel1.ts', 'file://src/rel2.ts'])).toEqual([]);
    // Released, not deleted: the row is the denominator the precision number is computed against.
    expect(await countFor('sess-rel')).toBe(2);
    // Nothing left to release, and saying so is not an error.
    expect(await releaseReadSet('sess-rel')).toBe(0);
  });

  /**
   * The capture path hands over one whole `Read` at a time -- up to 200 symbol observations from a
   * single file -- so the batch is the real call shape and the single-observation `recordRead` is
   * the special case. 250 crosses both boundaries that matter: `READ_SET_CHUNK` (200) for the
   * SELECT and the UPDATE, and `READ_SET_INSERT_CHUNK` (100) for the multi-row INSERT, which is
   * where an unchunked version would hit SQLite's bind-parameter ceiling as a hard error.
   */
  it('records a whole read in one batch, across every chunk boundary', async () => {
    const observations = Array.from({ length: 250 }, (_, index) => ({
      sessionId: 'sess-batch',
      locator: `symbol://src/batch/mod.ts#fn${String(index).padStart(4, '0')}`,
      observedHash: `h-${index}`,
      toolName: 'Read',
    }));

    await recordReads(observations);
    expect(await activeReadSetForSession('sess-batch')).toHaveLength(250);

    // Re-reading the same file unchanged learns nothing and must add nothing, which is what keeps
    // the table growing with distinct observations rather than with tool calls.
    await recordReads(observations);
    expect(await activeReadSetForSession('sess-batch')).toHaveLength(250);
    expect(await countFor('sess-batch')).toBe(250);

    // One symbol moved. The new belief is live, the old one is retired in the same pass, and the
    // rest of the batch is untouched -- so the session holds exactly one row per locator.
    await recordReads([{ ...observations[0], observedHash: 'h-0-changed' }]);
    const live = await activeReadSetForSession('sess-batch');
    expect(live).toHaveLength(250);
    expect(live.filter(entry => entry.locator === observations[0].locator).map(entry => entry.observedHash))
      .toEqual(['h-0-changed']);
    // Retired, not deleted: 250 originals plus the one replacement.
    expect(await countFor('sess-batch')).toBe(251);
  });

  /** A batch is one tool call, so two hashes for one locator means the file moved mid-read. */
  it('keeps the last observation when one batch names a locator twice', async () => {
    await recordReads([
      { sessionId: 'sess-dup', locator: 'file://src/dup.ts', observedHash: 'first' },
      { sessionId: 'sess-dup', locator: 'file://src/dup.ts', observedHash: 'second' },
    ]);

    expect((await activeReadSetForSession('sess-dup')).map(entry => entry.observedHash)).toEqual(['second']);
  });

  /** Callers are on the capture path and hand over whatever a tool named; a mixed batch must not
   * file one session's reads under another's name. */
  it('groups a mixed batch by session rather than assuming one', async () => {
    await recordReads([
      { sessionId: 'sess-mix-a', locator: 'file://src/mix1.ts', observedHash: 'h1' },
      { sessionId: 'sess-mix-b', locator: 'file://src/mix2.ts', observedHash: 'h2' },
      { sessionId: 'sess-mix-a', locator: 'file://src/mix3.ts', observedHash: 'h3' },
    ]);

    expect((await activeReadSetForSession('sess-mix-a')).map(entry => entry.locator).sort())
      .toEqual(['file://src/mix1.ts', 'file://src/mix3.ts']);
    expect((await activeReadSetForSession('sess-mix-b')).map(entry => entry.locator))
      .toEqual(['file://src/mix2.ts']);
  });

  /**
   * GC's half. The unreleased row is the case this whole subsystem exists for -- a long-lived
   * session is not garbage -- so age alone must never be enough to collect one.
   */
  it('sweeps released rows older than the cutoff and spares everything else', async () => {
    await recordRead({ sessionId: 'sess-gc', locator: 'file://src/gc-old.ts', observedHash: 'h-old' });
    await recordRead({ sessionId: 'sess-gc', locator: 'file://src/gc-recent.ts', observedHash: 'h-recent' });
    await recordRead({ sessionId: 'sess-gc', locator: 'file://src/gc-live.ts', observedHash: 'h-live' });
    await releaseReadSet('sess-gc');
    // Live again after the release, so the session has one unreleased row of real age.
    await recordRead({ sessionId: 'sess-gc', locator: 'file://src/gc-live.ts', observedHash: 'h-live-2' });

    // Backdated in SQL rather than by waiting: release stamps `new Date()`, and the property under
    // test is the cutoff comparison, not the clock.
    await getClient().execute({
      sql: 'UPDATE work_read_sets SET released_at = ? WHERE session_id = ? AND locator = ?',
      args: ['2026-01-01T00:00:00.000Z', 'sess-gc', 'file://src/gc-old.ts'],
    });
    // The earlier observation of the locator that is live again: a locator with both a collectable
    // row and a live one is the case a sweep written as "delete this session's old rows" fails.
    await getClient().execute({
      sql: `UPDATE work_read_sets SET released_at = ?
            WHERE session_id = ? AND locator = ? AND observed_hash = ?`,
      args: ['2026-01-01T00:00:00.000Z', 'sess-gc', 'file://src/gc-live.ts', 'h-live'],
    });

    expect(await sweepReadSets('2026-06-01T00:00:00.000Z')).toBe(2);

    const survivors = (await rowsFor('sess-gc')).map(row => String(row.locator)).sort();
    expect(survivors).toEqual(['file://src/gc-live.ts', 'file://src/gc-recent.ts']);
    // The live row survives at any cutoff, including one in the future. Asserted on this
    // session's surviving rows rather than on the returned count: the sweep is global by
    // design -- GC does not run per session -- so the count also collects released rows left
    // by every earlier case in this file, which share one database. A count assertion here
    // would pass or fail on the order and content of its siblings rather than on the cutoff.
    await sweepReadSets('2099-01-01T00:00:00.000Z');
    expect((await rowsFor('sess-gc')).map(row => String(row.locator))).toEqual(['file://src/gc-live.ts']);
    expect(await activeReadSetForSession('sess-gc')).toHaveLength(1);
  });

  describe('retention', () => {
    /**
     * The sweep had no caller before this. Asserted at the lifecycle boundary rather than by
     * calling `sweepReadSets` directly, because "the function works" was already true and was not
     * the bug -- nothing invoked it, so `work_read_sets` grew for as long as a repository was used.
     */
    it('collects released rows older than the window and spares everything else', async () => {
      const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
      const recent = new Date(Date.now() - 3_600_000).toISOString();

      await recordRead({ sessionId: 'sess-sweep', locator: 'file://src/old.ts', observedHash: 'h-old' });
      await recordRead({ sessionId: 'sess-sweep', locator: 'file://src/recent.ts', observedHash: 'h-recent' });
      await recordRead({ sessionId: 'sess-sweep', locator: 'file://src/live.ts', observedHash: 'h-live' });
      const client = getClient();
      await client.execute({ sql: 'UPDATE work_read_sets SET released_at = ? WHERE locator = ?', args: [old, 'file://src/old.ts'] });
      await client.execute({ sql: 'UPDATE work_read_sets SET released_at = ? WHERE locator = ?', args: [recent, 'file://src/recent.ts'] });

      const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
      const before = Number((await client.execute({ sql: "SELECT COUNT(*) AS n FROM work_read_sets WHERE session_id = 'sess-sweep'" })).rows[0].n);
      expect(before).toBe(3);
      await sweepReadSetsBestEffort(cutoff);

      // Scoped to this session: the suite shares one store, so asserting the whole table would
      // be asserting every other test's rows.
      const left = await client.execute({ sql: 'SELECT locator FROM work_read_sets WHERE session_id = ? ORDER BY locator', args: ['sess-sweep'] });
      expect(left.rows.map(row => String(row.locator))).toEqual(['file://src/live.ts', 'file://src/recent.ts']);
    });

    it('never collects a live row, however old the read', async () => {
      // The case the whole subsystem exists for: a session open for a week still holds its beliefs.
      await recordRead({ sessionId: 'sess-longlived', locator: 'file://src/ancient.ts', observedHash: 'h' });
      await getClient().execute({
        sql: "UPDATE work_read_sets SET read_at = ? WHERE locator = 'file://src/ancient.ts'",
        args: [new Date(Date.now() - 365 * 24 * 3_600_000).toISOString()],
      });

      await sweepReadSetsBestEffort(new Date().toISOString());
      expect(await activeReadSetForSession('sess-longlived')).toHaveLength(1);
    });
  });
});