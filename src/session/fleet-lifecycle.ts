import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedHostHook } from '../core/host-hook-types.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import type { ProjectConfig } from '../core/types.js';
import { getClient } from '../store/database.js';
import { repoRelativePath } from '../store/read-set.js';
import {
  renderFleetDigest, renderFleetRoster, renderSameProblemCard, renderSharedSurfaceCard, renderStaleReadNudge,
  type SessionView, type StaleReadView,
} from '../fleet/cards.js';
import { fleetCardsMode, fleetNudgeMode, isFleetDigestEnabled, isFleetEnabled } from '../fleet/config.js';
import { describeFleet, type FleetReport } from '../fleet/report.js';
import { errorSignature } from '../fleet/signature.js';
import {
  endFleetSession, getFleetSession, markFleetSeen, matchingFleetClaims, openFleetClaim, readFleetSeen, recordFleetCard,
  recordFleetError, recordFleetTurnStart, recordFleetTurnStop, recordFleetWrite, releaseFleetClaims, sweepFleet,
  touchFleetSession, FLEET_SESSION_RETENTION_HOURS,
} from '../fleet/store.js';
import { classifySharedSurfaceCommand, classifySharedSurfacePath, type SurfaceHit } from '../fleet/surfaces.js';

/**
 * The fleet's hooks into the lifecycle, each best-effort.
 *
 * Every function here runs inside a hook the host is waiting on, beside capture paths that
 * already have their own work to do. None of them may fail that hook: a fleet that cannot be
 * read is a session that is simply alone for one event, which is exactly what it was before
 * this file existed. So every entry point swallows and returns nothing, and the caller treats
 * "nothing" as "say nothing".
 */

/** A failure this session saw is still "the problem it is on" for this long after it was seen. */
const PENDING_ERROR_WINDOW_MS = 15 * 60 * 1000;

/** Errors from the engine, its hooks or its store hit every session on the machine, not one repo. */
const MACHINE_WIDE_ERROR = /\bknowl\b|agent-hook|agent-reminder|\.knowl[\\/]|hooks?[\\/]|\.claude[\\/]/i;

const fleetKey = (input: { host: string; externalSessionId: string }) =>
  ({ host: String(input.host), sessionId: input.externalSessionId });

/**
 * A line of host text that is allowed to reach the fleet store, or nothing.
 *
 * The fleet keeps the first 240 characters of what a turn was asked and what it answered, and
 * one normalised error line -- the only place in Knowl that stores any of the conversation, and
 * a deliberate, bounded exception: a roster that cannot say what a session is *on* answers the
 * question nobody asked. The exception buys no exemption from the write gate every knowledge
 * item passes. A line the secret validator refuses is dropped whole, not trimmed, because a
 * secret is not made safe by being shorter.
 */
function storable(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  try {
    validateKnowledgeWrite({ title: 'fleet', content: text });
    return text;
  } catch {
    return undefined;
  }
}

export function fleetRepoName(config: ProjectConfig | null | undefined, projectRoot: string): string {
  return config?.workspace?.repo ?? path.basename(projectRoot);
}

function changedPathsOf(input: NormalizedHostHook): string[] {
  const raw = input.payload.changedPaths;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
}

/** Repo-relative, forward-slashed, or dropped: a path outside the repo is not one a peer read. */
function relativePaths(root: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const candidate of paths) {
    const relative = repoRelativePath(root, path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate));
    if (relative && !out.includes(relative)) out.push(relative);
  }
  return out;
}

async function fileHash(root: string, relativePath: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(path.resolve(root, relativePath))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Which live host sessions are still standing on these repo-relative paths, from the project
 * store's read set. Rows are keyed by memory session id; the host session id is what the fleet
 * knows, so the two are joined through the active bindings. A `file://` row whose hash still
 * matches the file is a copy that is current now and stale after the write; a `symbol://` row
 * says the session read the file at symbol granularity and is counted as a reader outright.
 */
async function readersOf(root: string, relative: string[], excludeSessionId: string): Promise<Map<string, string[]>> {
  const readers = new Map<string, string[]>();
  if (relative.length === 0) return readers;
  const client = getClient();
  for (const file of relative) {
    const rows = await client.execute({
      sql: `SELECT r.session_id, r.locator, r.observed_hash, b.external_session_id
            FROM work_read_sets r
            JOIN host_session_bindings b ON b.memory_session_id = r.session_id AND b.active = 1
            WHERE r.released_at IS NULL AND (r.locator = ? OR r.locator LIKE ?)`,
      args: [`file://${file}`, `symbol://${file}#%`],
    });
    if (rows.rows.length === 0) continue;
    const current = await fileHash(root, file);
    for (const row of rows.rows) {
      const external = String(row.external_session_id);
      if (external === excludeSessionId) continue;
      const locator = String(row.locator);
      const holdsCurrent = locator.startsWith('symbol://') || (current !== null && String(row.observed_hash) === current);
      if (!holdsCurrent) continue;
      const list = readers.get(external) ?? [];
      if (!list.includes(file)) list.push(file);
      readers.set(external, list);
    }
  }
  return readers;
}

async function liveFleet(input: Pick<NormalizedHostHook, 'externalSessionId'>, repo: string): Promise<FleetReport> {
  return describeFleet({ selfSessionId: input.externalSessionId, selfRepo: repo });
}

const sessionsById = (report: FleetReport): Map<string, SessionView> =>
  new Map(report.sessions.map(session => [session.sessionId, session]));

/**
 * SessionStart: register this session, sweep what nobody will read again, and hand back the
 * roster section for the card. Empty when the session is alone or the feature is off.
 */
export async function fleetSessionStartBestEffort(input: NormalizedHostHook, config: ProjectConfig | null): Promise<string> {
  try {
    if (!isFleetEnabled(config)) return '';
    const repo = fleetRepoName(config, input.projectRoot);
    await touchFleetSession({ ...fleetKey(input), projectRoot: input.projectRoot, repo });
    await sweepFleet(new Date(Date.now() - FLEET_SESSION_RETENTION_HOURS * 3_600_000).toISOString()).catch(() => 0);
    const report = await liveFleet(input, repo);
    return renderFleetRoster({ sessionId: input.externalSessionId, repo }, report.sessions);
  } catch {
    return '';
  }
}

/**
 * The prompt hook: record what this turn was asked, and in maximal posture say which other
 * sessions moved since this session last looked. Returns the digest text, or nothing.
 */
export async function fleetTurnStartBestEffort(
  input: { host: string; externalSessionId: string; projectRoot: string; prompt?: string },
  config: ProjectConfig | null,
): Promise<string | undefined> {
  try {
    if (!isFleetEnabled(config)) return undefined;
    const repo = fleetRepoName(config, input.projectRoot);
    const key = fleetKey(input);
    await touchFleetSession({ ...key, projectRoot: input.projectRoot, repo });
    await recordFleetTurnStart({ ...key, ask: storable(input.prompt) ?? null });
    if (!isFleetDigestEnabled(config)) return undefined;

    const report = await liveFleet(input, repo);
    const seen = await readFleetSeen(key);
    const others = report.sessions.filter(session => session.sessionId !== input.externalSessionId && session.known && session.updatedAt);
    const changed = others.filter(session => {
      const last = seen.get(session.sessionId);
      return !last || session.updatedAt! > last;
    });
    await markFleetSeen({ ...key, seen: others.map(session => ({ otherSessionId: session.sessionId, updatedAt: session.updatedAt! })) });
    const digest = renderFleetDigest(changed);
    if (digest) await recordFleetCard({ kind: 'digest', ...key, subject: new Date().toISOString().slice(0, 16), mode: 'enforce' });
    return digest || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every tool event, before anything is said: record writes and failures, and open or extend
 * this session's claim on the problem it is fixing. Split from the card below because this
 * half must run on every event -- failed ones included, and ones whose slot the change card
 * has already taken -- while the card may only be computed when it will be shown.
 */
export async function fleetObserveToolEventBestEffort(input: NormalizedHostHook, config: ProjectConfig | null): Promise<void> {
  try {
    if (!isFleetEnabled(config)) return;
    const repo = fleetRepoName(config, input.projectRoot);
    const key = fleetKey(input);
    await touchFleetSession({ ...key, projectRoot: input.projectRoot, repo });

    const failed = input.status === 'failed';
    const errorText = input.errorText ?? (failed && typeof input.payload.message === 'string' ? input.payload.message : undefined);
    if (errorText) {
      const signature = errorSignature(errorText);
      if (signature && storable(signature.head)) await recordFleetError({ ...key, head: signature.head, sig: signature.sig });
    }

    const writes = relativePaths(input.projectRoot, changedPathsOf(input));
    const wroteFiles = writes.length > 0 && !failed && /edit|write|patch/i.test(input.toolName ?? '');
    if (!wroteFiles) return;
    await recordFleetWrite({ ...key, paths: writes });
    const row = await getFleetSession(key);
    const pendingSince = row?.lastErrorAt ? Date.parse(row.lastErrorAt) : NaN;
    if (row?.lastErrorSig && row.lastError && Number.isFinite(pendingSince) && Date.now() - pendingSince < PENDING_ERROR_WINDOW_MS) {
      await openFleetClaim({
        ...key, projectRoot: input.projectRoot, repo, sig: row.lastErrorSig, head: row.lastError,
        machineWide: MACHINE_WIDE_ERROR.test(row.lastError) || writes.some(file => MACHINE_WIDE_ERROR.test(file)),
        files: writes,
      });
    }
  } catch {
    // Nothing: an unrecorded write is one the fleet does not know about, which is the prior state.
  }
}

/**
 * The card for a tool event, at most one: another session already on the same problem first,
 * a shared surface that just moved second. Only called when the host's mid-turn slot is open
 * and free -- a card recorded as shown that was never shown would spend its one appearance on
 * nothing, so the ledger is written here and nowhere earlier.
 */
export async function fleetToolCardBestEffort(input: NormalizedHostHook, config: ProjectConfig | null): Promise<string | undefined> {
  try {
    const mode = fleetCardsMode(config);
    if (mode === 'off') return undefined;
    const repo = fleetRepoName(config, input.projectRoot);
    const key = fleetKey(input);
    const failed = input.status === 'failed';

    // Same problem, someone else already on it.
    const row = await getFleetSession(key);
    const pendingSince = row?.lastErrorAt ? Date.parse(row.lastErrorAt) : NaN;
    if (row?.lastErrorSig && row.lastError && Number.isFinite(pendingSince) && Date.now() - pendingSince < PENDING_ERROR_WINDOW_MS) {
      const matches = await matchingFleetClaims({ sig: row.lastErrorSig, head: row.lastError, projectRoot: input.projectRoot, excludeSessionId: input.externalSessionId });
      if (matches.length > 0) {
        const report = await liveFleet(input, repo);
        const live = sessionsById(report);
        const match = matches.find(claim => live.has(claim.sessionId));
        if (match) {
          const card = await recordFleetCard({ kind: 'same-problem', ...key, subject: match.sig, mode });
          if (card.first && mode === 'enforce') {
            return renderSameProblemCard({
              session: live.get(match.sessionId)!,
              head: match.head,
              minutesAgo: Math.max(0, Math.round((Date.now() - Date.parse(match.startedAt)) / 60_000)),
              files: match.files,
            });
          }
        }
      }
    }

    // A shared surface that already moved: the engine install, run from a shell.
    const command = typeof input.payload.command === 'string' ? input.payload.command : '';
    const hit = command && !failed ? classifySharedSurfaceCommand(command) : undefined;
    if (hit) {
      const report = await liveFleet(input, repo);
      const affected = report.sessions.filter(session => session.sessionId !== input.externalSessionId && (hit.machineWide || session.repo === repo));
      if (affected.length > 0) {
        const card = await recordFleetCard({ kind: 'shared-surface', ...key, subject: hit.target, mode });
        if (card.first && mode === 'enforce') {
          return renderSharedSurfaceCard({ hit, affected, readers: [], after: true, incident: engineIncident(hit) });
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one stored incident worth repeating verbatim. The engine's own upgrade path is the
 * change with the widest blast radius on the machine, and it looks like routine maintenance.
 */
function engineIncident(hit: SurfaceHit): string | undefined {
  if (hit.kind !== 'knowl-engine') return undefined;
  return 'a global install while serve processes were running half-installed, hit EBUSY on the SQLite binary, and turned every open tab\'s knowl red; the order that works is: stop every serve, install, then knowl-sync.';
}

/**
 * PreToolUse on a write: the pre-flight card. Advisory, and returned as text for the caller
 * to wrap in the host's pre-tool advice envelope -- never a refusal.
 */
export async function fleetPrecheckBestEffort(input: NormalizedHostHook, config: ProjectConfig | null): Promise<string | undefined> {
  try {
    if (!isFleetEnabled(config)) return undefined;
    const mode = fleetCardsMode(config);
    if (mode === 'off') return undefined;
    const relative = relativePaths(input.projectRoot, changedPathsOf(input));
    if (relative.length === 0) return undefined;
    const repo = fleetRepoName(config, input.projectRoot);
    const key = fleetKey(input);

    let hit: SurfaceHit | undefined;
    for (const file of relative) {
      hit = classifySharedSurfacePath(path.resolve(input.projectRoot, file), input.projectRoot);
      if (hit) break;
    }
    const readers = await readersOf(input.projectRoot, relative, input.externalSessionId);
    if (!hit && readers.size === 0) return undefined;

    const report = await liveFleet(input, repo);
    const live = sessionsById(report);
    const readerViews = [...readers.keys()].map(id => live.get(id)).filter((view): view is SessionView => Boolean(view));
    if (!hit && readerViews.length === 0) return undefined;

    const surface: SurfaceHit = hit ?? {
      kind: 'live-read',
      target: relative[0],
      reason: 'another live session read this file and still holds a current copy; your edit will make it stale',
      machineWide: false,
    };
    const affected = hit
      ? report.sessions.filter(session => session.sessionId !== input.externalSessionId && (hit!.machineWide || session.repo === repo))
      : readerViews;
    if (affected.length === 0 && readerViews.length === 0) return undefined;

    const card = await recordFleetCard({ kind: 'shared-surface', ...key, subject: surface.target, mode });
    if (!card.first || mode !== 'enforce') return undefined;
    return renderSharedSurfaceCard({ hit: surface, affected, readers: readerViews, incident: engineIncident(surface) });
  } catch {
    return undefined;
  }
}

/**
 * Stop: close the turn in the fleet store, drop claims the turn did not touch, and -- when
 * this turn's writes invalidated what another live session read -- hand back the nudge text
 * for the caller's stop envelope. Shadow records the nudge and returns nothing.
 */
export async function fleetTurnStopBestEffort(
  input: NormalizedHostHook,
  config: ProjectConfig | null,
  /** False when another verdict already holds this stop: the turn is still closed, but no nudge is computed or ledgered. */
  deliverable = true,
): Promise<string | undefined> {
  try {
    if (!isFleetEnabled(config)) return undefined;
    const key = fleetKey(input);
    const repo = fleetRepoName(config, input.projectRoot);
    await touchFleetSession({ ...key, projectRoot: input.projectRoot, repo });
    const { writes } = await recordFleetTurnStop({ ...key, summary: storable(input.assistantMessage) ?? null });
    await releaseFleetClaims({ ...key, untouchedBy: writes });

    const mode = fleetNudgeMode(config);
    if (mode === 'off' || !deliverable || writes.length === 0 || input.status === 'failed') return undefined;

    // After the write, "holds a current copy" means the reader re-read since; those are fine.
    // A reader whose copy no longer matches is the one to tell.
    const stale = await staleReadersOf(input.projectRoot, writes, input.externalSessionId);
    if (stale.size === 0) return undefined;
    const report = await liveFleet(input, repo);
    const live = sessionsById(report);
    const views: StaleReadView[] = [];
    for (const [sessionId, paths] of stale) {
      const session = live.get(sessionId);
      if (!session) continue;
      const fresh: string[] = [];
      for (const file of paths) {
        const card = await recordFleetCard({ kind: 'stale-read', ...key, subject: `${sessionId}:${file}`, mode });
        if (card.first) fresh.push(file);
      }
      if (fresh.length > 0) views.push({ session, paths: fresh });
    }
    if (views.length === 0 || mode !== 'enforce') return undefined;
    return renderStaleReadNudge(views);
  } catch {
    return undefined;
  }
}

/** Readers whose recorded copy of a path no longer matches the file on disk. */
async function staleReadersOf(root: string, relative: string[], excludeSessionId: string): Promise<Map<string, string[]>> {
  const stale = new Map<string, string[]>();
  const client = getClient();
  for (const file of relative) {
    const rows = await client.execute({
      sql: `SELECT r.locator, r.observed_hash, b.external_session_id
            FROM work_read_sets r
            JOIN host_session_bindings b ON b.memory_session_id = r.session_id AND b.active = 1
            WHERE r.released_at IS NULL AND (r.locator = ? OR r.locator LIKE ?)`,
      args: [`file://${file}`, `symbol://${file}#%`],
    });
    if (rows.rows.length === 0) continue;
    const current = await fileHash(root, file);
    for (const row of rows.rows) {
      const external = String(row.external_session_id);
      if (external === excludeSessionId) continue;
      const locator = String(row.locator);
      const isStale = locator.startsWith('symbol://') || current === null || String(row.observed_hash) !== current;
      if (!isStale) continue;
      const list = stale.get(external) ?? [];
      if (!list.includes(file)) list.push(file);
      stale.set(external, list);
    }
  }
  return stale;
}

export async function fleetSessionStopBestEffort(input: NormalizedHostHook, config: ProjectConfig | null): Promise<void> {
  try {
    if (!isFleetEnabled(config)) return;
    await endFleetSession(fleetKey(input));
  } catch {
    // Nothing: a session that could not be marked ended is swept by retention.
  }
}
