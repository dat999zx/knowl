import { describe, expect, it } from 'vitest';
import { describeFleet } from '../../src/fleet/report.js';
import type { HostSessionRecord } from '../../src/fleet/roster.js';
import type { FleetSessionRow } from '../../src/fleet/store.js';

/**
 * `describeFleet` with all three sources supplied is pure, so this is the one place the join
 * itself is asserted: which sessions are live, who may be messaged, and what a host with no
 * session registry contributes. The registry half is Claude Code's; every other host exists
 * here only as its store rows, which is exactly the case that used to be dropped.
 */
const NOW = new Date('2026-09-02T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const record = (over: Partial<HostSessionRecord> = {}): HostSessionRecord => ({
  host: 'claude',
  pid: 100,
  sessionId: 'claude-1',
  cwd: '/code/api',
  name: 'api-7f',
  startedAt: NOW.getTime() - 30 * 60_000,
  kind: 'interactive',
  configDir: '/home/u/.claude',
  ...over,
});

const row = (over: Partial<FleetSessionRow> = {}): FleetSessionRow => ({
  host: 'claude',
  sessionId: 'claude-1',
  projectRoot: '/code/api',
  repo: 'api',
  ask: null,
  summary: null,
  writes: [],
  lastError: null,
  lastErrorSig: null,
  lastErrorAt: null,
  turns: 1,
  turnStartedAt: null,
  turnEndedAt: null,
  startedAt: minutesAgo(30),
  updatedAt: minutesAgo(1),
  endedAt: null,
  ...over,
});

const describeWith = (registry: HostSessionRecord[], rows: FleetSessionRow[], extra = {}) =>
  describeFleet({ registry, rows, claims: [], now: NOW, ...extra });

describe('describeFleet across hosts', () => {
  it('lists a session from a host that keeps no registry, from its store row alone', async () => {
    const report = await describeWith([], [row({ host: 'codex', sessionId: 'codex-9', repo: 'web', projectRoot: '/code/web' })]);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      host: 'codex',
      repo: 'web',
      // Nothing named it, so it takes the folder-and-id form a nameless Claude session takes.
      name: 'web-co',
      known: true,
      // Reachable by nothing: the messaging channel the cards name belongs to the registry hosts.
      messageable: false,
    });
  });

  it('drops a registry host row the registry does not list, but keeps a quiet unregistered one', async () => {
    const report = await describeWith([], [
      // Claude answered for its own sessions and did not list this one: the process is gone.
      row({ sessionId: 'claude-dead', updatedAt: minutesAgo(1) }),
      // No registry could have listed this one, and it moved recently enough to still count.
      row({ host: 'windsurf', sessionId: 'windsurf-1', updatedAt: minutesAgo(45) }),
    ]);
    expect(report.sessions.map(session => session.sessionId)).toEqual(['windsurf-1']);
  });

  it('drops an unregistered session that has gone quiet past the live window', async () => {
    const report = await describeWith([], [row({ host: 'codex', sessionId: 'codex-old', updatedAt: minutesAgo(3 * 60) })]);
    expect(report.sessions).toEqual([]);
  });

  it('offers messaging only to a registry peer sharing the caller\'s config directory', async () => {
    const registry = [
      record({ sessionId: 'me' }),
      record({ pid: 101, sessionId: 'same-dir', name: 'api-aa' }),
      record({ pid: 102, sessionId: 'other-dir', name: 'api-bb', configDir: '/home/u/.claude-account-b' }),
    ];
    const report = await describeWith(registry, [], { selfSessionId: 'me', selfHost: 'claude' });
    const messageable = Object.fromEntries(report.sessions.map(session => [session.sessionId, session.messageable]));
    expect(messageable).toEqual({ me: true, 'same-dir': true, 'other-dir': false });
  });

  it('offers messaging to nobody when the asking session runs on a host that has none', async () => {
    const report = await describeWith([record()], [], { selfSessionId: 'codex-9', selfHost: 'codex' });
    expect(report.sessions.map(session => session.messageable)).toEqual([false]);
  });

  it('keeps a registry entry Knowl has never heard from, marked unknown', async () => {
    const report = await describeWith([record()], []);
    expect(report.sessions[0]).toMatchObject({ known: false, repo: 'api', host: 'claude' });
  });
});
