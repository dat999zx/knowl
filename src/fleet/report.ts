import path from 'node:path';
import { inlineUntrusted } from '../core/untrusted.js';
import { focusOf, type SessionView } from './cards.js';
import { claudeConfigDirs, derivedSessionName, readHostSessionRegistry, REGISTRY_HOSTS, sameDir, type HostSessionRecord } from './roster.js';
import { listFleetSessions, openFleetClaimsForSession, type FleetClaim, type FleetSessionRow } from './store.js';

/** A turn still counts as in flight for this long after its last event; after that the session is idle. */
const WORKING_WINDOW_MS = 10 * 60 * 1000;

/**
 * How long a session on a host with no registry still counts as live after its last event.
 *
 * The registry hosts get an exact answer -- the process is there or it is not. Every other host
 * leaves only its hook events, so liveness is inferred from recency, and the number is the
 * whole precision of that inference. Two hours is chosen against what being wrong costs in each
 * direction: too long lists a session that has gone, and the roster tells the agent to
 * coordinate with nobody; too short drops a session parked mid-task, which is the exact one
 * worth knowing about. A session-end hook closes the row outright on every clean exit, so this
 * only decides how long a *crashed* session lingers.
 */
const UNREGISTERED_LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

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
  /**
   * The asking session's host. Decides whether any peer can be messaged at all: the messaging
   * channel the cards name belongs to the registry hosts, so a Codex session reading a roster
   * is told to tell the user rather than to make a call it does not have.
   */
  selfHost?: string;
  /** Overrides for tests. */
  registry?: HostSessionRecord[];
  rows?: FleetSessionRow[];
  claims?: FleetClaim[];
  now?: Date;
}

/**
 * The live sessions on this machine, as the cards see them.
 *
 * Two sources, and which one is authoritative depends on the host. A registry host answers for
 * its own sessions exactly -- the process is there or it is not -- so one of its store rows
 * that the registry does not list is dead and is dropped. Every other host publishes no such
 * file, and its sessions exist here only as the rows its hooks wrote; those are judged by
 * recency instead, which is what makes a Codex or Windsurf session visible to the Claude
 * session in the next terminal, and vice versa.
 *
 * A registry entry with no store row is a session Knowl has never heard from (no hooks
 * installed there, or a repo with no `.knowl`): listed, named by its folder, marked unknown.
 */
export async function describeFleet(input: DescribeFleetInput = {}): Promise<FleetReport> {
  const now = input.now ?? new Date();
  const registry = input.registry ?? readHostSessionRegistry(claudeConfigDirs());
  const rows = input.rows ?? await listFleetSessions();
  const byId = new Map(rows.map(row => [row.sessionId, row]));
  const registered = new Map(registry.map(record => [record.sessionId, record]));
  const selfRecord = input.selfSessionId ? registered.get(input.selfSessionId) : undefined;
  const selfDir = selfRecord?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? '';
  // A host outside the registry set has no way to address a peer; one inside it, or one we
  // were not told, is assumed able to and still has to share the peer's config directory.
  const selfCanMessage = input.selfHost === undefined || REGISTRY_HOSTS.has(input.selfHost);

  const view = (row: FleetSessionRow | undefined, record: HostSessionRecord | undefined): SessionView => {
    const turnEnded = row?.turnEndedAt ? Date.parse(row.turnEndedAt) : NaN;
    const updated = row ? Date.parse(row.updatedAt) : NaN;
    const cwd = record?.cwd ?? row!.projectRoot;
    const sessionId = record?.sessionId ?? row!.sessionId;
    const startedAt = record ? record.startedAt : Date.parse(row!.startedAt);
    return {
      name: record?.name ?? derivedSessionName(cwd, sessionId),
      sessionId,
      host: record?.host ?? row!.host,
      repo: row?.repo ?? path.basename(cwd),
      cwd,
      // Only a registry-backed peer can be reached, and only from a session under the same
      // config directory. Everything else the roster can see but not address.
      messageable: Boolean(record) && selfCanMessage && (selfDir ? sameDir(record!.configDir, selfDir) : true),
      ageMinutes: Number.isFinite(startedAt) ? Math.max(0, Math.round((now.getTime() - startedAt) / 60_000)) : 0,
      idleMinutes: Number.isFinite(turnEnded) ? Math.max(0, Math.round((now.getTime() - turnEnded) / 60_000)) : undefined,
      working: Boolean(row?.turnStartedAt) && !row?.turnEndedAt && Number.isFinite(updated) && now.getTime() - updated < WORKING_WINDOW_MS,
      ask: row?.ask ?? undefined,
      summary: row?.summary ?? undefined,
      writes: row?.writes ?? [],
      lastError: row?.lastError ?? undefined,
      known: Boolean(row),
      updatedAt: row?.updatedAt,
    };
  };

  const sessions: SessionView[] = registry.map(record => view(byId.get(record.sessionId), record));
  for (const row of rows) {
    if (registered.has(row.sessionId)) continue;
    // Its host answered for it and did not list it, so the process is gone.
    if (REGISTRY_HOSTS.has(row.host)) continue;
    const updated = Date.parse(row.updatedAt);
    if (!Number.isFinite(updated) || now.getTime() - updated > UNREGISTERED_LIVE_WINDOW_MS) continue;
    sessions.push(view(row, undefined));
  }

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
      ? `No live agent sessions in repo "${inlineUntrusted(options.repo)}".`
      : 'No live agent sessions on this machine.';
  }
  const claimsBySession = new Map<string, FleetClaim[]>();
  for (const claim of report.claims) {
    const list = claimsBySession.get(claim.sessionId) ?? [];
    list.push(claim);
    claimsBySession.set(claim.sessionId, list);
  }
  const lines = [`${sessions.length} live agent session${sessions.length === 1 ? '' : 's'}${options.repo ? ` in ${inlineUntrusted(options.repo)}` : ' on this machine'} (${report.generatedAt.slice(11, 16)} UTC):`];
  const ordered = [...sessions].sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  for (const session of ordered) {
    const you = report.self && session.sessionId === report.self.sessionId ? ' (you)' : '';
    const state = session.working ? 'working' : session.idleMinutes !== undefined ? `idle ${session.idleMinutes}m` : session.known ? 'idle' : 'unknown to knowl';
    const reach = session.messageable ? '' : ' · not messageable';
    lines.push(`- ${inlineUntrusted(session.name)}${you} [${inlineUntrusted(session.host)} · ${inlineUntrusted(session.repo)} · ${state} · up ${formatAge(session.ageMinutes)}${reach}]`);
    const focus = focusOf(session);
    if (focus) lines.push(`    on: ${focus}`);
    if (session.summary && session.ask) lines.push(`    last said: ${inlineUntrusted(session.summary).slice(0, 110)}`);
    if (session.writes.length > 0) lines.push(`    editing: ${session.writes.slice(0, 4).map(inlineUntrusted).join(', ')}${session.writes.length > 4 ? ` +${session.writes.length - 4}` : ''}`);
    if (session.lastError) lines.push(`    last error: ${inlineUntrusted(session.lastError).slice(0, 110)}`);
    for (const claim of (claimsBySession.get(session.sessionId) ?? []).slice(0, 2)) {
      lines.push(`    claims: ${inlineUntrusted(claim.head)}${claim.files.length > 0 ? ` → ${claim.files.slice(0, 3).map(inlineUntrusted).join(', ')}` : ''}${claim.machineWide ? ' (machine-wide)' : ''}`);
    }
  }
  if (sessions.some(session => session.messageable)) {
    lines.push('Message one with SendMessage(to:"<name>"); SendMessage(to:"<name>", notify_when_idle:true) waits for it to finish.');
  }
  return lines.join('\n');
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.floor(hours / 24)}d`;
}
