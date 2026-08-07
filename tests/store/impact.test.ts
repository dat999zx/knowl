import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { indexFile, listCodeSymbols } from '../../src/code/symbol-index.js';
import {
  detectCertainImpact,
  detectCertainImpactBestEffort,
  markFindingsDelivered,
  openFindingsForSession,
  resolveFinding,
} from '../../src/session/impact.js';

/**
 * The certain tier, tested as a *precision* claim rather than a feature.
 *
 * Half of these assert that nothing is emitted, and that is the point: the tier is the only one
 * allowed to push into an agent's context and the only one allowed to refuse a write, and
 * tool-side noise is measured at ~20.8% mean accuracy cost against the agent receiving it. A
 * false positive here does not merely waste context, it takes away someone's ability to save a
 * file. So "did not fire" is the behaviour under test at least as often as "fired".
 *
 * A real git repository per test, not a mock. `indexFile` shells out to `git check-ignore`, so a
 * stubbed `spawnSync` would test the fixture's idea of git rather than git.
 */

const SOURCE = 'src/session.ts';
const SYMBOL = `symbol://${SOURCE}#createSession`;
const FILE_LOCATOR = `file://${SOURCE}`;
const AT = '2026-08-05T00:00:00.000Z';

const V1 = `export function createSession(user: User): Session {
  return { user };
}
`;

/** The signature line moves: this is the change the certain tier exists to catch. */
const V2_SIGNATURE_CHANGED = `export function createSession(user: User, org: Organization): Session {
  return { user, org };
}
`;

/** Same signature, different body -- the file hash moves, `signature_hash` does not. */
const V1_BODY_EDITED = `export function createSession(user: User): Session {
  return { user, at: Date.now() };
}
`;

// One directory per test: on Windows the previous database file can still be locked when the
// next test starts, and a silently failed cleanup would carry its read-set rows over.
let testRoot = '';
let testIndex = 0;

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
}

async function write(relativePath: string, contents: string): Promise<void> {
  const full = path.join(testRoot, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
}

async function fileHashOf(relativePath: string): Promise<string> {
  // Byte-for-byte the digest `isEvidenceStale` takes, because that is the one the read side stores.
  return crypto.createHash('sha256').update(await fs.readFile(path.join(testRoot, relativePath))).digest('hex');
}

async function symbolHashOf(relativePath: string, qualifiedName: string): Promise<string> {
  const symbols = await listCodeSymbols(relativePath);
  const hash = symbols.find(symbol => symbol.qualifiedName === qualifiedName)?.signatureHash;
  if (!hash) throw new Error(`no indexed signature hash for ${qualifiedName} in ${relativePath}`);
  return hash;
}

/**
 * A read-set row written directly rather than through the capture API.
 *
 * The read side is another lane's file; what this suite owns is the detector's reaction to a row
 * that exists, so the row is the fixture. `activeReadersOf` is still the real one -- the released
 * case below only means anything because Lane D's query, not this helper, decides it.
 */
async function seedRead(input: {
  id: string;
  sessionId: string;
  locator: string;
  observedHash: string;
  releasedAt?: string;
}): Promise<string> {
  await getClient().execute({
    sql: `INSERT INTO work_read_sets (id, session_id, agent_id, locator, observed_hash, tool_name, read_at, released_at)
          VALUES (?, ?, NULL, ?, ?, 'Read', ?, ?)`,
    args: [input.id, input.sessionId, input.locator, input.observedHash, AT, input.releasedAt ?? null],
  });
  return input.id;
}

async function countFindings(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM impact_findings');
  return Number(rows.rows[0].total);
}

beforeEach(async () => {
  testRoot = path.join(os.tmpdir(), `knowl-impact-test-${testIndex++}`);
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(testRoot, '.knowl'), { recursive: true });

  git(testRoot, 'init', '-q', '.');
  git(testRoot, 'config', 'user.email', 'lane-e@example.test');
  git(testRoot, 'config', 'user.name', 'lane e');
  // The store lives inside the repo it indexes, so it has to be ignored or every working-tree
  // assertion below would be dominated by the database's own sidecar files.
  await write('.gitignore', '.knowl/\n');
  await write(SOURCE, V1);
  await write('src/doomed.ts', 'export function doomed(): void {}\n');
  await write('src/old name.ts', 'export function spaced(): void {}\n');
  await write('src/ünïcode.ts', 'export function accented(): void {}\n');
  git(testRoot, 'add', '-A');
  git(testRoot, 'commit', '-qm', 'fixture');

  await initDb(testRoot);
});

afterEach(async () => {
  await closeDb();
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
});

describe('certain-tier impact detection', () => {
  it('emits nothing when nobody was reading the file that changed', async () => {
    await indexFile(testRoot, SOURCE);

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    expect(await detectCertainImpact(testRoot, [SOURCE], 'sess-writer')).toEqual([]);
    expect(await countFindings()).toBe(0);
  });

  it('emits exactly one certain finding when a read symbol hash moved', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      causeLocator: SYMBOL,
      causeSession: 'sess-writer',
      affectedKind: 'work',
      affectedId: 'read-1',
      tier: 'certain',
      resolution: null,
      resolvedAt: null,
    });
    expect(await countFindings()).toBe(1);
  });

  it('accepts the absolute paths a host hook reports', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    // The candidate locators are built from the repo-relative form; an unnormalised absolute path
    // would build `symbol://D:/…/src/session.ts#createSession`, match no read-set row, and report
    // nothing at all against real staleness.
    const findings = await detectCertainImpact(testRoot, [path.join(testRoot, SOURCE)], 'sess-writer');

    expect(findings.map(finding => finding.affectedId)).toEqual(['read-1']);
  });

  it('stays silent when the signature the reader held did not move', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });

    await write(SOURCE, V1_BODY_EDITED);
    expect(await detectCertainImpact(testRoot, [SOURCE], 'sess-writer')).toEqual([]);
  });

  /**
   * The deliberate non-goal, pinned so nobody "fixes" it by accident: relevance is not judged, so
   * a body-only edit does move a `file://` hash and does fire. Whether that is a false positive is
   * the P-3 measurement's question (plan §10), not a heuristic's -- and the fix, if the number
   * says so, is to demote body-only edits to `likely`, which is a tier change rather than a
   * silent filter added here.
   */
  it('reports a body-only edit against a file:// reader, because relevance is not judged', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-symbol', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });
    await seedRead({ id: 'read-file', sessionId: 'sess-reader', locator: FILE_LOCATOR, observedHash: await fileHashOf(SOURCE) });

    await write(SOURCE, V1_BODY_EDITED);
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(findings.map(finding => finding.affectedId)).toEqual(['read-file']);
  });

  it('never reports a session against its own change', async () => {
    await indexFile(testRoot, SOURCE);
    const observedHash = await symbolHashOf(SOURCE, 'createSession');
    await seedRead({ id: 'read-writer', sessionId: 'sess-writer', locator: SYMBOL, observedHash });
    await seedRead({ id: 'read-other', sessionId: 'sess-other', locator: SYMBOL, observedHash });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(findings.map(finding => finding.affectedId)).toEqual(['read-other']);
  });

  it('ignores a read that has already been released', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({
      id: 'read-1',
      sessionId: 'sess-reader',
      locator: SYMBOL,
      observedHash: await symbolHashOf(SOURCE, 'createSession'),
      releasedAt: AT,
    });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    expect(await detectCertainImpact(testRoot, [SOURCE], 'sess-writer')).toEqual([]);
  });

  /**
   * The second run sees the same still-stale read -- the reader's hash is still the v1 one -- so
   * without suppression it would insert a second row and push the same notice into the same
   * agent's context on the next tool call.
   */
  it('does not re-report an impact that is already open, but does report again after it is closed', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });
    await write(SOURCE, V2_SIGNATURE_CHANGED);

    const first = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');
    const second = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await countFindings()).toBe(1);

    // Resolution is not suppression: a locator that moves again after the agent dismissed one is
    // new information, and the alternative -- one finding per pair forever -- would silence every
    // subsequent change to a symbol an agent ever dismissed.
    await resolveFinding(first[0].id, 'dismissed');
    expect(await detectCertainImpact(testRoot, [SOURCE], 'sess-writer')).toHaveLength(1);
    expect(await countFindings()).toBe(2);
  });

  it('reports a deleted file against its file:// reader, with no current hash', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: FILE_LOCATOR, observedHash: await fileHashOf(SOURCE) });

    await fs.rm(path.join(testRoot, SOURCE));
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(findings).toHaveLength(1);
    expect(findings[0].causeLocator).toBe(FILE_LOCATOR);
    expect(JSON.parse(findings[0].pathJson ?? '{}').currentHash).toBeNull();
  });

  it('carries the was/now pair the card cannot recompute later', async () => {
    await indexFile(testRoot, SOURCE);
    const observedHash = await symbolHashOf(SOURCE, 'createSession');
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const [finding] = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');
    const payload = JSON.parse(finding.pathJson ?? '{}');

    expect(payload.locator).toBe(SYMBOL);
    expect(payload.observedHash).toBe(observedHash);
    expect(payload.currentHash).toBe(await symbolHashOf(SOURCE, 'createSession'));
    expect(payload.currentHash).not.toBe(payload.observedHash);
    expect(payload.observedSignature).toContain('user: User)');
    expect(payload.observedSignature).not.toContain('Organization');
    expect(payload.currentSignature).toContain('Organization');
  });

  /**
   * The anti-fabrication guard. A `was:` line is only printable when the pre-change index row's
   * own hash matches what the reader recorded; otherwise the card would quote text the agent
   * never saw, in a notice whose only value is being trustworthy.
   */
  it('omits the was: text when the held hash matches no indexed signature', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: 'a-hash-from-some-older-index' });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const [finding] = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');
    const payload = JSON.parse(finding.pathJson ?? '{}');

    expect(payload.observedSignature).toBeNull();
    expect(payload.currentSignature).toContain('Organization');
  });

  /**
   * "Cannot read it" is not "it is gone", and collapsing the two manufactures exactly the false
   * positive `CurrentState` was written to prevent.
   *
   * This is reachable on the hot path, not in theory. Detection runs from a `PostToolUse` hook
   * microseconds after a write lands, which on Windows is precisely when an antivirus scanner or
   * an editor still holds the file open and `readFile` comes back `EBUSY`/`EACCES`. Reporting that
   * as a deletion fires the strongest notice the system has -- on the one tier allowed to interrupt
   * an agent, against a file that is sitting there intact.
   *
   * A directory standing in for the locked file, because it is the one non-`ENOENT` read failure
   * that reproduces identically on every platform CI runs. The error code differs; the question the
   * detector has to answer -- "does a failed read prove deletion?" -- does not.
   */
  it('stays silent when a read fails for a reason other than the file being gone', async () => {
    const unreadable = 'src/unreadable.ts';
    await fs.mkdir(path.join(testRoot, unreadable), { recursive: true });
    await seedRead({
      id: 'read-1',
      sessionId: 'sess-reader',
      locator: `file://${unreadable}`,
      observedHash: 'a-hash-recorded-when-it-was-still-a-file',
    });

    expect(await detectCertainImpact(testRoot, [unreadable], 'sess-writer')).toEqual([]);
    expect(await countFindings()).toBe(0);
  });

  /** A genuine deletion still reports, so the guard above buys silence only where it should. */
  it('still reports a file that is actually gone', async () => {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: FILE_LOCATOR, observedHash: await fileHashOf(SOURCE) });

    await fs.rm(path.join(testRoot, SOURCE));
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    expect(findings).toHaveLength(1);
    expect(JSON.parse(findings[0].pathJson ?? '{}').currentHash).toBeNull();
  });

  /**
   * The returned list is a claim about what was recorded, and `INSERT OR IGNORE` must not make it
   * a lie: an id that exists nowhere can be neither stamped delivered nor adjudicated.
   *
   * The lever is the one asymmetry between the two guards. `hasOpenFinding` narrows to
   * `affected_kind = 'work'`; `idx_impact_findings_unique_open` is on `(cause_locator, affected_id)`
   * alone. So an open finding of the other kind on the same pair is invisible to the check and
   * fatal to the insert -- which is the same end state a lost cross-process race produces, reached
   * deterministically instead of by timing. Detection writes only `work` rows today, so this is
   * the latent shape of the race rather than a defect reachable from the current call sites.
   */
  it('does not return a finding whose insert the open-finding constraint dropped', async () => {
    await indexFile(testRoot, SOURCE);
    const readId = await seedRead({
      id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession'),
    });
    await getClient().execute({
      sql: `INSERT INTO impact_findings
              (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, delivered_at, resolution, resolved_at)
            VALUES ('pre-existing', ?, NULL, 'knowledge', ?, 'certain', NULL, ?, NULL, NULL, NULL)`,
      args: [SYMBOL, readId, AT],
    });

    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const findings = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');

    // The seeded row is the only one the table may hold, so anything returned here is a phantom.
    expect(await countFindings()).toBe(1);
    expect(findings).toEqual([]);
  });

  it('never fails the caller in its best-effort form', async () => {
    // A closed store rather than a stub: this is the real condition the wrapper exists for --
    // detection is triggered from a `PostToolUse` hook and a session boundary, either of which can
    // fire against a database that is being swapped or has already been released. The raw form
    // throwing is half the assertion; the advisory form swallowing it is the contract.
    await closeDb();
    try {
      await expect(detectCertainImpact(testRoot, [SOURCE], 'sess-writer')).rejects.toThrow();
      expect(await detectCertainImpactBestEffort(testRoot, [SOURCE], 'sess-writer')).toEqual([]);
    } finally {
      await initDb(testRoot);
    }
  });
});

describe('marking findings delivered', () => {
  /**
   * The card hands over every open undelivered finding, not the handful it printed
   * (`host-lifecycle.ts:526` against `MAX_IMPACT_ENTRIES`), so the size of this list is bounded by
   * the session's staleness and nothing else.
   *
   * Measured, not assumed: this build of libSQL refuses at 32,767 bound variables. Past that the
   * statement throws inside `runToolEventImpact`, whose catch returns no card at all -- and because
   * the stamp never lands, the same oversized set comes back and throws again on the next tool
   * call. The stated design is that a repeated card beats a swallowed one; unchunked, the failure
   * is a card swallowed permanently.
   */
  it('stamps a set larger than the bind-parameter ceiling', async () => {
    const ids = Array.from({ length: 40_000 }, (_, index) => `finding-${index}`);
    await expect(markFindingsDelivered(ids)).resolves.toBeUndefined();
  });
});

describe('open findings for a session', () => {
  async function seedOneFinding(): Promise<string> {
    await indexFile(testRoot, SOURCE);
    await seedRead({ id: 'read-1', sessionId: 'sess-reader', locator: SYMBOL, observedHash: await symbolHashOf(SOURCE, 'createSession') });
    await write(SOURCE, V2_SIGNATURE_CHANGED);
    const [finding] = await detectCertainImpact(testRoot, [SOURCE], 'sess-writer');
    return finding.id;
  }

  it('answers for the session that owns the affected read, not the one that caused it', async () => {
    const id = await seedOneFinding();

    expect((await openFindingsForSession('sess-reader')).map(finding => finding.id)).toEqual([id]);
    expect(await openFindingsForSession('sess-writer')).toEqual([]);
  });

  it('filters by tier when asked and returns every tier when not', async () => {
    await seedOneFinding();

    expect(await openFindingsForSession('sess-reader', 'certain')).toHaveLength(1);
    expect(await openFindingsForSession('sess-reader', 'likely')).toEqual([]);
  });

  it('drops a finding from the open set once it is adjudicated', async () => {
    const id = await seedOneFinding();

    await resolveFinding(id, 'false_positive');

    expect(await openFindingsForSession('sess-reader')).toEqual([]);
    const row = (await getClient().execute({
      sql: 'SELECT resolution, resolved_at FROM impact_findings WHERE id = ?',
      args: [id],
    })).rows[0];
    expect(String(row.resolution)).toBe('false_positive');
    expect(row.resolved_at).not.toBeNull();
  });

  /**
   * The first verdict is final. Precision is `1 - false_positive/total`, and a later write
   * flipping a `false_positive` to `repaired` would move that number with no record it moved.
   */
  it('keeps the first adjudication when a finding is resolved twice', async () => {
    const id = await seedOneFinding();

    await resolveFinding(id, 'false_positive');
    await resolveFinding(id, 'repaired');

    const row = (await getClient().execute({
      sql: 'SELECT resolution FROM impact_findings WHERE id = ?',
      args: [id],
    })).rows[0];
    expect(String(row.resolution)).toBe('false_positive');
  });

  /**
   * Released is not resolved. A detector that filtered on `released_at IS NULL` would drop a
   * finding the moment its read was released -- unadjudicated, and therefore out of the precision
   * denominator -- and would silently delete `knowl_impact scope: 'all'`, whose whole purpose is
   * the findings nobody has judged yet. The write gate wants the narrower set and takes it by
   * intersecting the live read-set itself, at its own call site where the reason is stated.
   */
  it('still reports a finding whose read has since been released', async () => {
    const id = await seedOneFinding();
    await getClient().execute({
      sql: 'UPDATE work_read_sets SET released_at = ? WHERE id = ?',
      args: [AT, 'read-1'],
    });

    expect((await openFindingsForSession('sess-reader')).map(finding => finding.id)).toEqual([id]);
  });
});
