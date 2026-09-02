import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeFleetDb, endFleetSession, fleetCardReport, fleetDbPath, getFleetSession, listFleetSessions, markFleetSeen,
  matchingFleetClaims, openFleetClaim, openFleetClaimsForSession, readFleetSeen, recordFleetCard, recordFleetError,
  recordFleetTurnStart, recordFleetTurnStop, recordFleetWrite, releaseFleetClaims, resolveFleetCard, sweepFleet,
  touchFleetSession,
} from '../../src/fleet/store.js';

const home = path.resolve('./.knowl-fleet-store-test');
const previousHome = process.env.KNOWL_HOME;

const a = { host: 'claude', sessionId: 'session-a' };
const b = { host: 'claude', sessionId: 'session-b' };
const root = 'C:\\Code\\DuckPrep-server';

beforeAll(async () => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.KNOWL_HOME = home;
});

afterAll(async () => {
  await closeFleetDb();
  if (previousHome === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = previousHome;
  // Windows may hold the WAL sidecars a beat after close; the global teardown sweeps what this misses.
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* swept later */ }
});

describe('fleet sessions', () => {
  it('lives under the Knowl home, not inside a repo', () => {
    expect(fleetDbPath()).toBe(path.join(home, 'fleet.db'));
  });

  it('upserts a session, tracks a turn, and clears the writes when the turn ends', async () => {
    await touchFleetSession({ ...a, projectRoot: root, repo: 'duckprep' });
    await touchFleetSession({ ...a, projectRoot: root, repo: 'duckprep' });
    await recordFleetTurnStart({ ...a, ask: 'fix the SQLITE_BUSY flake in the session directory' });
    await recordFleetWrite({ ...a, paths: ['src/store/session-directory.ts'] });
    await recordFleetWrite({ ...a, paths: ['src/store/database.ts', 'src/store/session-directory.ts'] });

    const during = await getFleetSession(a);
    expect(during).toMatchObject({ repo: 'duckprep', turns: 1, ask: 'fix the SQLITE_BUSY flake in the session directory', endedAt: null });
    expect(during!.writes).toEqual(['src/store/database.ts', 'src/store/session-directory.ts']);
    expect(during!.turnStartedAt).toBeTruthy();
    expect(during!.turnEndedAt).toBeNull();

    const stopped = await recordFleetTurnStop({ ...a, summary: 'Added retry-with-backoff around the directory read.' });
    expect(stopped.writes).toEqual(['src/store/database.ts', 'src/store/session-directory.ts']);
    const after = await getFleetSession(a);
    expect(after!.writes).toEqual([]);
    expect(after!.summary).toBe('Added retry-with-backoff around the directory read.');
    expect(after!.turnEndedAt).toBeTruthy();
  });

  it('keeps a bounded, deduplicated write list', async () => {
    await touchFleetSession({ ...b, projectRoot: root, repo: 'duckprep' });
    await recordFleetTurnStart(b);
    const many = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const writes = await recordFleetWrite({ ...b, paths: many });
    expect(writes).toHaveLength(20);
    expect(writes[0]).toBe('src/file-10.ts');
    expect(writes[19]).toBe('src/file-29.ts');
  });

  it('lists live sessions and drops ended ones', async () => {
    const before = await listFleetSessions();
    expect(before.map(row => row.sessionId).sort()).toEqual(['session-a', 'session-b']);
    await endFleetSession(b);
    const after = await listFleetSessions();
    expect(after.map(row => row.sessionId)).toEqual(['session-a']);
    // A resumed session is the same conversation: touching it again brings it back.
    await touchFleetSession({ ...b, projectRoot: root, repo: 'duckprep' });
    expect((await getFleetSession(b))!.endedAt).toBeNull();
  });

  it('records the last error head and signature', async () => {
    await recordFleetError({ ...a, head: 'sqlite_busy: database is locked (<path>)', sig: 'abc123' });
    expect(await getFleetSession(a)).toMatchObject({ lastError: 'sqlite_busy: database is locked (<path>)', lastErrorSig: 'abc123' });
  });
});

describe('fleet claims', () => {
  it('opens one claim per session and signature, accumulating files', async () => {
    const first = await openFleetClaim({ ...a, projectRoot: root, repo: 'duckprep', sig: 'sig-1', head: 'sqlite_busy: database is locked', machineWide: false, files: ['src/x.ts'] });
    const second = await openFleetClaim({ ...a, projectRoot: root, repo: 'duckprep', sig: 'sig-1', head: 'sqlite_busy: database is locked', machineWide: false, files: ['src/y.ts'] });
    expect(second.id).toBe(first.id);
    expect(second.files).toEqual(['src/x.ts', 'src/y.ts']);
    expect(await openFleetClaimsForSession(a)).toHaveLength(1);
  });

  it('matches another session on the exact signature or a fuzzy head, within scope', async () => {
    const exact = await matchingFleetClaims({ sig: 'sig-1', head: 'anything', projectRoot: root, excludeSessionId: 'session-b' });
    expect(exact.map(claim => claim.sessionId)).toEqual(['session-a']);

    const fuzzy = await matchingFleetClaims({ sig: 'other', head: 'error: sqlite_busy: database is locked', projectRoot: root, excludeSessionId: 'session-b' });
    expect(fuzzy.map(claim => claim.sessionId)).toEqual(['session-a']);

    const otherRepo = await matchingFleetClaims({ sig: 'sig-1', head: 'sqlite_busy: database is locked', projectRoot: 'C:\\Code\\Other', excludeSessionId: 'session-b' });
    expect(otherRepo).toEqual([]);

    const self = await matchingFleetClaims({ sig: 'sig-1', head: 'sqlite_busy: database is locked', projectRoot: root, excludeSessionId: 'session-a' });
    expect(self).toEqual([]);
  });

  it('a machine-wide claim is visible from any repo', async () => {
    await openFleetClaim({ ...b, projectRoot: 'C:\\Code\\knowl-cloud', repo: 'knowl-cloud', sig: 'engine-1', head: 'ebusy: resource busy or locked, knowl serve', machineWide: true, files: [] });
    const seen = await matchingFleetClaims({ sig: 'engine-1', head: 'x', projectRoot: root, excludeSessionId: 'session-a' });
    expect(seen.map(claim => claim.sessionId)).toEqual(['session-b']);
  });

  it('releases only the claims whose files went untouched, then everything on demand', async () => {
    await openFleetClaim({ ...a, projectRoot: root, repo: 'duckprep', sig: 'sig-2', head: 'typeerror: cannot read properties of undefined', machineWide: false, files: ['src/z.ts'] });
    expect(await releaseFleetClaims({ ...a, untouchedBy: ['src/x.ts'] })).toBe(1);
    const left = await openFleetClaimsForSession(a);
    expect(left.map(claim => claim.sig)).toEqual(['sig-1']);
    expect(await releaseFleetClaims(a)).toBe(1);
    expect(await openFleetClaimsForSession(a)).toEqual([]);
  });

  it('ending a session releases its claims', async () => {
    expect(await openFleetClaimsForSession(b)).toHaveLength(1);
    await endFleetSession(b);
    expect(await openFleetClaimsForSession(b)).toEqual([]);
  });
});

describe('fleet cards and watermarks', () => {
  it('records a card once per subject and measures precision from adjudications', async () => {
    const first = await recordFleetCard({ kind: 'same-problem', ...a, subject: 'sig-1', mode: 'enforce' });
    const repeat = await recordFleetCard({ kind: 'same-problem', ...a, subject: 'sig-1', mode: 'enforce' });
    const shadow = await recordFleetCard({ kind: 'shared-surface', ...a, subject: '.knowl/config.json', mode: 'shadow' });
    expect(first.first).toBe(true);
    expect(repeat).toEqual({ id: first.id, first: false });
    expect(shadow.first).toBe(true);

    expect(await resolveFleetCard(first.id, 'acted')).toBe(true);
    expect(await resolveFleetCard(first.id, 'false_positive')).toBe(false);
    expect(await resolveFleetCard(shadow.id, 'false_positive')).toBe(true);

    expect(await fleetCardReport()).toEqual({ shown: 1, shadowed: 1, adjudicated: 2, falsePositives: 1, precision: 0.5 });
    expect(await fleetCardReport('same-problem')).toMatchObject({ shown: 1, shadowed: 0, precision: 1 });
  });

  it('remembers what a session has seen of the others', async () => {
    expect(await readFleetSeen(a)).toEqual(new Map());
    await markFleetSeen({ ...a, seen: [{ otherSessionId: 'session-b', updatedAt: '2026-09-02T10:00:00.000Z' }] });
    await markFleetSeen({ ...a, seen: [{ otherSessionId: 'session-b', updatedAt: '2026-09-02T10:05:00.000Z' }] });
    expect(await readFleetSeen(a)).toEqual(new Map([['session-b', '2026-09-02T10:05:00.000Z']]));
  });

  it('sweeps stale sessions with everything hanging off them', async () => {
    expect(await sweepFleet(new Date(Date.now() - 60_000).toISOString())).toBe(0);
    expect(await sweepFleet(new Date(Date.now() + 60_000).toISOString())).toBe(2);
    expect(await listFleetSessions()).toEqual([]);
    expect(await readFleetSeen(a)).toEqual(new Map());
  });
});
