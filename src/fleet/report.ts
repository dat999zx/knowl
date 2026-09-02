import path from 'node:path';
import { inlineUntrusted } from '../core/untrusted.js';
import { focusOf, type SessionView } from './cards.js';
import { claudeConfigDirs, readHostSessionRegistry, sameDir, type HostSessionRecord } from './roster.js';
import { listFleetSessions, openFleetClaimsForSession, type FleetCardReport, type FleetClaim, type FleetSessionRow } from './store.js';

/** A turn still counts as in flight for this long after its last event; after that the session is idle. */
const WORKING_WINDOW_MS = 10 * 60 * 1000;

export interface FleetReport {
  self: { sessionId: string; repo: string } | null;
  sessions: SessionView[];
  claims: FleetClaim[];
  generatedAt: string;
}

export interface DescribeFleetInput {
  /** The asking session's host session id; its own row is included and marked. */
  selfSessionId?: string;
  selfRepo?: string;
  /** Overrides for tests. */
  registry?: HostSessionRecord[];
  rows?: FleetSessionRow[];
  claims?: FleetClaim[];
  now?: Date;
}

/**
 * The live sessions on this machine, as the cards see them.
 *
 * The host's registry is the truth about liveness -- a process that is gone is not a session,
 * whatever the store still says -- and the store is the truth about activity. A registry entry
 * with no store row is a session Knowl has never heard from (no hooks installed there, or a
 * repo with no `.knowl`): listed, named by its folder, and marked unknown. A store row with no
 * registry entry is a dead session and is dropped.
 */
export async function describeFleet(input: DescribeFleetInput = {}): Promise<FleetReport> {
  const now = input.now ?? new Date();
  const registry = input.registry ?? readHostSessionRegistry(claudeConfigDirs());
  const rows = input.rows ?? await listFleetSessions();
  const byId = new Map(rows.map(row => [row.sessionId, row]));
  const selfRecord = input.selfSessionId ? registry.find(record => record.sessionId === input.selfSessionId) : undefined;
  const selfDir = selfRecord?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? '';

  const sessions: SessionView[] = registry.map(record => {
    const row = byId.get(record.sessionId);
    const turnEnded = row?.turnEndedAt ? Date.parse(row.turnEndedAt) : NaN;
    const updated = row ? Date.parse(row.updatedAt) : NaN;
    const working = Boolean(row?.turnStartedAt) && !row?.turnEndedAt && Number.isFinite(updated) && now.getTime() - updated < WORKING_WINDOW_MS;
    return {
      name: record.name,
      sessionId: record.sessionId,
      repo: row?.repo ?? path.basename(record.cwd),
      cwd: record.cwd,
      messageable: selfDir ? sameDir(record.configDir, selfDir) : true,
      ageMinutes: Math.max(0, Math.round((now.getTime() - record.startedAt) / 60_000)),
      idleMinutes: Number.isFinite(turnEnded) ? Math.max(0, Math.round((now.getTime() - turnEnded) / 60_000)) : undefined,
      working,
      ask: row?.ask ?? undefined,
      summary: row?.summary ?? undefined,
      writes: row?.writes ?? [],
      lastError: row?.lastError ?? undefined,
      known: Boolean(row),
      updatedAt: row?.updatedAt,
    };
  });

  const live = new Set(sessions.map(session => session.sessionId));
  let claims = input.claims;
  if (!claims) {
    claims = [];
    for (const session of sessions) {
      if (!session.known) continue;
      const row = byId.get(session.sessionId)!;
      claims.push(...await openFleetClaimsForSession({ host: row.host, sessionId: row.sessionId }));
    }
  }
  claims = claims.filter(claim => live.has(claim.sessionId));

  const selfRepo = input.selfRepo ?? (input.selfSessionId ? sessions.find(session => session.sessionId === input.selfSessionId)?.repo : undefined);
  return {
    self: input.selfSessionId ? { sessionId: input.selfSessionId, repo: selfRepo ?? '' } : null,
    sessions,
    claims,
    generatedAt: now.toISOString(),
  };
}

/** The whole picture as text, for the MCP tool and the CLI. */
export function renderFleetReport(report: FleetReport, options: { repo?: string } = {}): string {
  const sessions = options.repo ? report.sessions.filter(session => session.repo === options.repo) : report.sessions;
  if (sessions.length === 0) {
    return options.repo
      ? `No live Claude Code sessions in repo "${inlineUntrusted(options.repo)}".`
      : 'No live Claude Code sessions on this machine.';
  }
  const claimsBySession = new Map<string, FleetClaim[]>();
  for (const claim of report.claims) {
    const list = claimsBySession.get(claim.sessionId) ?? [];
    list.push(claim);
    claimsBySession.set(claim.sessionId, list);
  }
  const lines = [`${sessions.length} live Claude Code session${sessions.length === 1 ? '' : 's'}${options.repo ? ` in ${inlineUntrusted(options.repo)}` : ' on this machine'} (${report.generatedAt.slice(11, 16)} UTC):`];
  const ordered = [...sessions].sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  for (const session of ordered) {
    const you = report.self && session.sessionId === report.self.sessionId ? ' (you)' : '';
    const state = session.working ? 'working' : session.idleMinutes !== undefined ? `idle ${session.idleMinutes}m` : session.known ? 'idle' : 'unknown to knowl';
    const reach = session.messageable ? '' : ' · not messageable (other config dir)';
    lines.push(`- ${inlineUntrusted(session.name)}${you} [${inlineUntrusted(session.repo)} · ${state} · up ${formatAge(session.ageMinutes)}${reach}]`);
    const focus = focusOf(session);
    if (focus) lines.push(`    on: ${focus}`);
    if (session.summary && session.ask) lines.push(`    last said: ${inlineUntrusted(session.summary).slice(0, 110)}`);
    if (session.writes.length > 0) lines.push(`    editing: ${session.writes.slice(0, 4).map(inlineUntrusted).join(', ')}${session.writes.length > 4 ? ` +${session.writes.length - 4}` : ''}`);
    if (session.lastError) lines.push(`    last error: ${inlineUntrusted(session.lastError).slice(0, 110)}`);
    for (const claim of (claimsBySession.get(session.sessionId) ?? []).slice(0, 2)) {
      lines.push(`    claims: ${inlineUntrusted(claim.head)}${claim.files.length > 0 ? ` → ${claim.files.slice(0, 3).map(inlineUntrusted).join(', ')}` : ''}${claim.machineWide ? ' (machine-wide)' : ''}`);
    }
  }
  lines.push('Message one with SendMessage(to:"<name>"); SendMessage(to:"<name>", notify_when_idle:true) waits for it to finish.');
  return lines.join('\n');
}

/**
 * The precision ledger as text, in the shape `knowl status` gives the write gate and for the
 * same reason: a count of cards alone invites "it fired a lot, it must be useful", and a
 * ledger nobody adjudicated reads as *not yet measured* rather than as a perfect score.
 */
export function renderFleetCardLedger(report: FleetCardReport): string {
  const precision = report.precision === null
    ? 'not yet measured'
    : `${(report.precision * 100).toFixed(1)}%`;
  return [
    'Fleet cards:',
    `  shown:            ${report.shown}`,
    `  shadowed:         ${report.shadowed}`,
    `  adjudicated:      ${report.adjudicated} of ${report.shown + report.shadowed}`,
    `  false positives:  ${report.falsePositives}`,
    `  precision:        ${precision}`,
  ].join('\n');
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.floor(hours / 24)}d`;
}
