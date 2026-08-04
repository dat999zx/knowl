import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeSymbol } from '../core/types.js';
import { indexFile, listCodeSymbols } from '../code/symbol-index.js';
import { getClient } from './database.js';
import { normalizePathForKnowledge } from './freshness.js';
import { activeReadersOf, normalizeLocator } from './read-set.js';

/**
 * Certain-tier change impact: something moved, and a session that provably read it has not been
 * told and cannot know.
 *
 * The tier names a precision claim, not a confidence adjective. A finding is emitted only when
 * both halves are demonstrable from stored state: a session recorded a read of *this exact
 * locator*, and the hash of that locator has *moved since that read*. Nothing here infers, walks
 * an edge, matches a path against a title, or scores a similarity -- those are the `likely` and
 * `possible` tiers of `docs/change-impact-plan.md` §7.3 and they are deliberately absent.
 *
 * The reason for the asymmetry is measured, not stylistic. Certain findings are the only tier
 * allowed to push into the agent's context and to gate `knowl_task_finish`, and that channel is
 * tool-side context, which AgentNoiseBench measures at ~20.8% mean accuracy cost when polluted --
 * agents being *more* sensitive to tool-side noise than to user-side noise. So a false positive
 * here is not a wasted line, it is a measured accuracy hit against the agent receiving it, and
 * the bar is Tricorder's <10% effective false positives tightened to ≥95% precision (plan §5 C-3,
 * §9). This repo has already conceded the same point in the other direction: `drift-auto.ts:17-40`
 * records that one commit window matched 36/301 atoms and fifteen windows matched a third of the
 * store, and runs `apply: false` forever because of it.
 *
 * **Where this chooses silence over a guess** -- each of these is a recall loss taken knowingly:
 *
 * - A symbol whose current `signature_hash` is NULL (the extractor produced no signature) is
 *   never reported, even against a reader holding a non-null hash. "No hash now" cannot be
 *   distinguished from "the extractor changed", and reporting the extractor's own behaviour as
 *   someone else's edit is a false positive with no cause to point at.
 * - A symbol that the change *deleted* is not in the candidate set, because the set is built from
 *   the symbols the file has now. A vanished symbol is often a rename, and `evidence-repository
 *   .ts:158-170` already shows what saying so responsibly costs: a name-similarity search that
 *   only speaks when exactly one candidate scores ≥0.6. Until that resolution exists here, a
 *   deleted symbol is reported by nothing rather than reported wrongly. A deleted *file* is
 *   different and is caught: `file://` has no name to recover, so its absence is unambiguous.
 * - A read-set entry with no `observedHash` proves nothing about movement and is skipped.
 * - A locator that is neither `symbol://` nor `file://` gets no verdict at all.
 *
 * **Deliberate non-goal: relevance.** A comment-only edit moves a file's content hash, and this
 * will report it. Whether the change *mattered* is not judged here, and that is not an oversight
 * -- it is plan §10's open question, to be settled by the P-3 precision measurement rather than
 * by a heuristic written before the measurement exists. If relevance false positives run high,
 * the answer already sketched is to shrink the certain tier to signature-hash movement only and
 * drop body-only edits to `likely`. Guessing that now would pre-empt the one number this whole
 * phase exists to produce.
 */

export type ImpactTier = 'certain' | 'likely' | 'possible';

export type ImpactResolution = 'repaired' | 'dismissed' | 'expired' | 'false_positive';

export interface ImpactFinding {
  id: string;
  causeLocator: string;
  causeSession: string | null;
  affectedKind: 'knowledge' | 'work';
  affectedId: string;
  tier: ImpactTier;
  pathJson: string | null;
  detectedAt: string;
  resolution: ImpactResolution | null;
  resolvedAt: string | null;
}

/**
 * What `path_json` carries for a certain finding, and why it is written at detection time.
 *
 * The delivery layer renders "was: … / now: …" (plan §7.5), and it cannot recompute the `was`
 * side: by the time a card is drawn, the only surviving record of the old state is the hash in
 * the read-set row, and a hash does not render. The signature text has to be captured in the one
 * moment both versions are knowable -- immediately around the re-index -- or it is gone.
 */
interface CertainImpactPath {
  locator: string;
  observedHash: string;
  /** NULL when the locator's target no longer exists. */
  currentHash: string | null;
  /** The text the reader observed, and NULL unless that can be proven. See `provenSignature`. */
  observedSignature: string | null;
  currentSignature: string | null;
}

const generateId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/**
 * The current state of a locator, with "no verdict" distinguished from "gone".
 *
 * Collapsing these two would be the single easiest way to manufacture false positives: `null`
 * means we cannot say whether anything moved and must stay quiet, while `gone` is itself proof of
 * movement -- the thing the session read is not there any more.
 */
type CurrentState =
  | { kind: 'hash'; hash: string; signature: string | null }
  | { kind: 'gone' }
  | null;

/**
 * Repo-relative, forward-slashed -- the one form `code_files.path` and every locator use.
 *
 * A near-copy of `indexFile`'s own guard (`symbol-index.ts:257-260`) because `relativeCodePath`
 * is private to that module and this lane does not edit it. Callers hand this whatever a tool
 * event named, which on the hook path is an absolute path; without the same normalisation the
 * candidate locators would be built from a form that appears in no read-set row, and detection
 * would return empty against real staleness.
 */
function repoRelative(root: string, filePath: string): string | null {
  const relative = normalizePathForKnowledge(path.relative(root, path.resolve(root, filePath)));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

async function fileContentHash(root: string, relativePath: string): Promise<string | null> {
  try {
    // Hashed as bytes, matching `isEvidenceStale` (`evidence-repository.ts:180`) exactly. Any
    // other digest of the same file -- utf-8 normalised, line-ending normalised, trimmed -- would
    // disagree with the hash the read side stored and make every `file://` read look moved.
    const content = await fs.readFile(path.resolve(root, relativePath));
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

async function currentStateOf(
  root: string,
  locator: string,
  symbolsNow: Map<string, CodeSymbol>,
  fileHashes: Map<string, string | null>,
): Promise<CurrentState> {
  if (locator.startsWith('symbol://')) {
    const symbol = symbolsNow.get(locator);
    // Absent from the post-index snapshot, or present with nothing to hash: no verdict. See the
    // silence notes in the module comment -- this is the deleted/renamed-symbol case.
    if (!symbol?.signatureHash) return null;
    return { kind: 'hash', hash: symbol.signatureHash, signature: symbol.signature };
  }

  if (locator.startsWith('file://')) {
    const relativePath = locator.slice('file://'.length);
    if (!fileHashes.has(relativePath)) fileHashes.set(relativePath, await fileContentHash(root, relativePath));
    const hash = fileHashes.get(relativePath) ?? null;
    return hash === null ? { kind: 'gone' } : { kind: 'hash', hash, signature: null };
  }

  return null;
}

/**
 * The signature text the reader saw -- or NULL, which is the common case and the safe one.
 *
 * Returned only when the pre-change index row's own hash equals the hash the reader recorded,
 * which is what makes it *that reader's* `was:` line rather than merely the previous contents of
 * a table. Without the guard, a locator re-indexed between the read and the change would print a
 * "was:" the agent never saw -- a fabricated quote in a card whose entire value is being
 * trustworthy, and strictly worse than printing no quote at all.
 */
function provenSignature(before: Map<string, CodeSymbol>, locator: string, observedHash: string): string | null {
  const previous = before.get(locator);
  return previous && previous.signatureHash === observedHash ? previous.signature : null;
}

async function hasOpenFinding(causeLocator: string, affectedId: string): Promise<boolean> {
  // Seeks `idx_impact_findings_affected(affected_kind, affected_id, resolution)`; `cause_locator`
  // filters the handful of rows that survive it.
  const rows = await getClient().execute({
    sql: `SELECT 1 FROM impact_findings
          WHERE affected_kind = 'work' AND affected_id = ? AND resolution IS NULL AND cause_locator = ?
          LIMIT 1`,
    args: [affectedId, causeLocator],
  });
  return rows.rows.length > 0;
}

async function insertFinding(finding: ImpactFinding): Promise<ImpactFinding> {
  await getClient().execute({
    sql: `INSERT INTO impact_findings
            (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, resolution, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    args: [
      finding.id,
      finding.causeLocator,
      finding.causeSession,
      finding.affectedKind,
      finding.affectedId,
      finding.tier,
      finding.pathJson,
      finding.detectedAt,
    ],
  });
  return finding;
}

function rowToFinding(row: Record<string, unknown>): ImpactFinding {
  return {
    id: String(row.id),
    causeLocator: String(row.cause_locator),
    causeSession: row.cause_session === null || row.cause_session === undefined ? null : String(row.cause_session),
    affectedKind: String(row.affected_kind) as ImpactFinding['affectedKind'],
    affectedId: String(row.affected_id),
    tier: String(row.tier) as ImpactTier,
    pathJson: row.path_json === null || row.path_json === undefined ? null : String(row.path_json),
    detectedAt: String(row.detected_at),
    resolution: row.resolution === null || row.resolution === undefined ? null : String(row.resolution) as ImpactResolution,
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
  };
}

/**
 * Detect every certain-tier impact of a set of just-changed paths, and record it.
 *
 * Ordering is load-bearing and is the reason this reads the symbol table twice. The *pre*-index
 * snapshot is the only place the old signature text still exists; the re-index is what makes the
 * comparison current; the *post*-index snapshot is the candidate set. Re-indexing first and
 * asking for the old text afterwards is not a slower version of this -- the text is simply gone.
 *
 * `causeSession` is optional because not every trigger knows who wrote (a session-boundary sweep
 * does not). When it is absent nothing is self-excluded, which is correct: an unattributed change
 * has no session to spare.
 *
 * Not wrapped in a transaction. `indexFile` opens its own and `withClientTransaction` refuses to
 * nest, so a transaction here would throw on the first changed file; and findings are independent
 * rows where a partial write costs at most a missed notice, never a corrupt record.
 */
export async function detectCertainImpact(
  root: string,
  changedPaths: string[],
  causeSession?: string,
): Promise<ImpactFinding[]> {
  const relativePaths = Array.from(new Set(
    changedPaths.map(changed => repoRelative(root, changed)).filter((value): value is string => value !== null)
  ));
  if (relativePaths.length === 0) return [];

  // Keyed by the read-set's canonical locator form, not by the index's raw one, and looked up
  // later by the locator a read-set row hands back. The two spellings agree today; keying by the
  // shared normaliser is what keeps them agreeing, which is the divergence `normalizeLocator`'s own
  // comment names -- one side storing `symbol://src/a.ts#f` while the other searches for
  // `symbol://src\a.ts#f` is not a visible bug, it is a feature that quietly never fires.
  const before = new Map<string, CodeSymbol>();
  for (const relativePath of relativePaths) {
    for (const symbol of await listCodeSymbols(relativePath)) {
      const locator = normalizeLocator(symbol.locator);
      if (locator) before.set(locator, symbol);
    }
  }

  for (const relativePath of relativePaths) await indexFile(root, relativePath);

  const symbolsNow = new Map<string, CodeSymbol>();
  const candidates = new Set<string>();
  for (const relativePath of relativePaths) {
    for (const symbol of await listCodeSymbols(relativePath)) {
      const locator = normalizeLocator(symbol.locator);
      if (!locator) continue;
      symbolsNow.set(locator, symbol);
      candidates.add(locator);
    }
    const fileLocator = normalizeLocator(`file://${relativePath}`);
    // Null for a path the read-set will not hold either -- an extensionless file, which its
    // directory heuristic refuses. Searching for a locator that cannot exist is not wrong, just
    // pointless; dropping it here keeps the candidate set equal to the set of findable things.
    if (fileLocator) candidates.add(fileLocator);
  }

  const readers = await activeReadersOf(Array.from(candidates));
  const detectedAt = new Date().toISOString();
  const fileHashes = new Map<string, string | null>();
  const seenEntries = new Set<string>();
  const findings: ImpactFinding[] = [];

  for (const entry of readers) {
    if (!entry.id || seenEntries.has(entry.id)) continue;
    seenEntries.add(entry.id);

    // Self-exclusion. A session is never told it invalidated its own read: it made the change, it
    // is the one actor that already knows, and the notice would be pure tool-side noise in the
    // context of the agent least able to act on it. This is also what keeps the write-triggered
    // path from firing on every edit an agent makes to a file it just read.
    if (causeSession && entry.sessionId === causeSession) continue;

    // Nothing recorded as of the read means nothing can be proven to have moved.
    if (!entry.locator || !entry.observedHash) continue;

    const state = await currentStateOf(root, entry.locator, symbolsNow, fileHashes);
    if (state === null) continue;
    if (state.kind === 'hash' && state.hash === entry.observedHash) continue;

    // Suppression is per (cause locator, affected read), checked before the insert rather than
    // deduped after. The cost of a duplicate is not a wasted row, it is the same notice pushed
    // into the same agent's context a second time on the next tool call, into the channel measured
    // at ~20.8% accuracy cost. A resolved finding does not suppress: re-detection after the agent
    // dismissed one means the locator moved again.
    //
    // Check-then-insert, so it is not atomic against a second detector running in another process
    // -- two hooks firing on the same file in the same instant can each see no open finding and
    // each insert one. The closing move is a partial unique index on
    // (cause_locator, affected_id) WHERE resolution IS NULL, which belongs in `SCHEMA_STATEMENTS`
    // and is not this module's to add. Left as a known duplicate-notice window rather than papered
    // over with a lock this subsystem has no reason to hold.
    if (await hasOpenFinding(entry.locator, entry.id)) continue;

    const pathPayload: CertainImpactPath = {
      locator: entry.locator,
      observedHash: entry.observedHash,
      currentHash: state.kind === 'gone' ? null : state.hash,
      observedSignature: provenSignature(before, entry.locator, entry.observedHash),
      currentSignature: state.kind === 'gone' ? null : state.signature,
    };

    findings.push(await insertFinding({
      id: generateId(),
      causeLocator: entry.locator,
      causeSession: causeSession ?? null,
      affectedKind: 'work',
      affectedId: entry.id,
      tier: 'certain',
      pathJson: JSON.stringify(pathPayload),
      detectedAt,
      resolution: null,
      resolvedAt: null,
    }));
  }

  return findings;
}

/**
 * Every open finding against work this session owns -- the write gate's query, and the pull
 * tool's.
 *
 * Deliberately **not** filtered on `work_read_sets.released_at`, because release and resolution
 * are different facts and only one of them closes a finding. Release means the session stopped
 * holding that belief; `resolution` means somebody adjudicated it, and that column is the
 * precision denominator plan §9 exists to produce. Conflating them here would let a finding
 * disappear unadjudicated and take a measurement with it.
 *
 * Both callers depend on that separation, in opposite directions. `knowl_impact scope: 'all'`
 * wants exactly the findings whose read was released and which nobody has judged yet -- they are
 * the ones that would otherwise be lost. The write gate wants the opposite and says so at its own
 * call site: it intersects this result against the live read-set, because a released row means
 * the session has re-read that locator and the stale belief is gone. Filtering here would make
 * that the gate's only behaviour and silently delete the pull tool's.
 */
export async function openFindingsForSession(sessionId: string, tier?: ImpactTier): Promise<ImpactFinding[]> {
  const rows = await getClient().execute({
    sql: `SELECT f.id, f.cause_locator, f.cause_session, f.affected_kind, f.affected_id, f.tier,
                 f.path_json, f.detected_at, f.resolution, f.resolved_at
          FROM impact_findings f
          JOIN work_read_sets w ON w.id = f.affected_id
          WHERE f.resolution IS NULL AND f.affected_kind = 'work' AND w.session_id = ?
            ${tier ? 'AND f.tier = ?' : ''}
          ORDER BY f.detected_at, f.id`,
    args: tier ? [sessionId, tier] : [sessionId],
  });
  return rows.rows.map(row => rowToFinding(row as unknown as Record<string, unknown>));
}

/**
 * Adjudicate one finding, once.
 *
 * `AND resolution IS NULL` makes the first verdict final. Precision is `1 - false_positive/total`
 * (plan §9) and it is the number this phase exists to produce; a later write silently flipping a
 * `false_positive` to `repaired` would move that denominator's numerator with no record that it
 * ever moved. Re-resolution is a no-op rather than an error because the callers are advisory
 * paths -- a gate and a pull tool -- where failing a user's task-finish over a double-click is a
 * worse outcome than ignoring the second one.
 */
export async function resolveFinding(id: string, resolution: ImpactResolution): Promise<void> {
  await getClient().execute({
    sql: 'UPDATE impact_findings SET resolution = ?, resolved_at = ? WHERE id = ? AND resolution IS NULL',
    args: [resolution, new Date().toISOString(), id],
  });
}

/**
 * The form a trigger calls. Detection is advisory: a `PostToolUse` hook or a session boundary
 * must not fail because the detector did, following `flagCorrectionSiblingsBestEffort`
 * (`blast-radius.ts:192`). An empty result is indistinguishable from "nothing was affected",
 * which is the correct degradation -- the failure mode of this subsystem is silence, never a
 * broken tool call in someone's session.
 */
export async function detectCertainImpactBestEffort(
  root: string,
  changedPaths: string[],
  causeSession?: string,
): Promise<ImpactFinding[]> {
  try {
    return await detectCertainImpact(root, changedPaths, causeSession);
  } catch {
    return [];
  }
}
