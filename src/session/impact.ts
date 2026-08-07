import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeSymbol } from '../core/types.js';
import { indexFile, listCodeSymbols } from '../code/symbol-index.js';
import { getClient } from '../store/database.js';
import { normalizePathForKnowledge } from '../store/freshness.js';
import { activeReadersOf, normalizeLocator } from '../store/read-set.js';

/**
 * Certain-tier change impact: something moved, and a session that provably read it has not been
 * told and cannot know.
 *
 * **Why this is in `session/` and not `store/`.** Detection re-indexes the files it was handed,
 * so it imports `code/symbol-index.js` — and `code` sits *above* `store` in the layer graph
 * (`tests/architecture/module-boundaries.test.ts`), which makes `store -> code` an upward edge and
 * a test failure. The storage half genuinely is store-layer and stays there as `store/read-set.ts`,
 * which imports nothing above itself; what lives here is the part that needs a parser. Pushing
 * `indexFile` down into `store/` to keep this module there would drag tree-sitter under the
 * persistence layer to satisfy a directory name.
 *
 * `session/` is enough, and **no new layer is needed**: `code` is layer 2, `session` is layer 3 and
 * `mcp` is layer 4, so this module reaches down into `code` and `store` while both of its consumers
 * — `session/host-lifecycle.ts` beside it and `mcp/tools.ts` above it — still reach down into it.
 * Two consumers in different layers do not need a shared layer beneath them, only a module below
 * the lower of the two. That is why the earlier `await import('../code/symbol-index.js')` is gone:
 * the deferral existed solely to hide an upward edge that no longer exists, and it was buying
 * module-load laziness for a subsystem already gated behind `impact.enabled`.
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
 * - A symbol deleted from a file that **fails to parse** is not reported. This was once true of
 *   every deleted symbol -- the candidate set was built only from the symbols a file has now, so a
 *   vanished one could never be looked up -- and `impact-precision.test.ts` measured the cost at
 *   28.6 points of recall on the strongest invalidation there is. Deletions and renames are now
 *   caught by seeding the candidate set with the pre-change symbols too. What stays silent is the
 *   narrow case the old silence was really protecting against: a file caught mid-edit yields *no*
 *   symbols, and calling that "everything in it was deleted" would fire a burst of findings at
 *   exactly the moment someone is typing. So absence counts only when at least one other symbol in
 *   the file survived the re-index. A file whose last remaining symbol was deleted is
 *   indistinguishable from a parse failure by that test, and is the recall this knowingly loses.
 *   Note that a rename still reports as a deletion rather than as a rename: naming the new symbol
 *   would need the ≥0.6 single-candidate similarity search of `evidence-repository.ts:158-170`,
 *   and "this is gone" is true and useful without it.
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
  /** When the card last rendered this finding; NULL until it has. Never an adjudication. */
  deliveredAt: string | null;
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

/**
 * A read that failed, split by whether the failure proves anything.
 *
 * `unreadable` is not a pedantic third case. Detection runs from a `PostToolUse` hook, which fires
 * microseconds after a write lands -- exactly when an antivirus scanner or an editor still holds
 * the file open and `readFile` returns `EBUSY`, `EACCES` or `EPERM` on Windows, and when a
 * descriptor ceiling can return `EMFILE` on any platform. Every one of those means "ask again
 * later"; none of them means the file was deleted. Folding them into `gone` fires the strongest
 * notice this system has, on the one tier allowed to interrupt an agent, about a file that is
 * sitting there intact -- which is precisely the manufactured false positive `CurrentState`'s own
 * contract forbids.
 *
 * `ENOENT` and `ENOTDIR` are the two that do prove it: the file, or a directory on the way to it,
 * is not there. Anything else is a missing verdict, and a missing verdict costs recall on a tier
 * that is allowed to be incomplete rather than precision on the one that is not.
 */
type FileHashResult =
  | { kind: 'hash'; hash: string }
  | { kind: 'gone' }
  | { kind: 'unreadable' };

async function fileContentHash(root: string, relativePath: string): Promise<FileHashResult> {
  try {
    // Hashed as bytes, matching `isEvidenceStale` (`evidence-repository.ts:180`) exactly. Any
    // other digest of the same file -- utf-8 normalised, line-ending normalised, trimmed -- would
    // disagree with the hash the read side stored and make every `file://` read look moved.
    const content = await fs.readFile(path.resolve(root, relativePath));
    return { kind: 'hash', hash: crypto.createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'gone' } : { kind: 'unreadable' };
  }
}

async function currentStateOf(
  root: string,
  locator: string,
  symbolsNow: Map<string, CodeSymbol>,
  fileHashes: Map<string, FileHashResult>,
  parsedFiles: Set<string>,
): Promise<CurrentState> {
  if (locator.startsWith('symbol://')) {
    const symbol = symbolsNow.get(locator);
    if (symbol?.signatureHash) return { kind: 'hash', hash: symbol.signatureHash, signature: symbol.signature };

    // The symbol is not in the post-index snapshot. Deleted and renamed both land here, and they
    // are the *strongest* invalidation there is -- stronger than a signature change, because the
    // thing the reader was building against is not there at all. Staying silent on them was
    // measured at a 28.6-point recall hole in `impact-precision.test.ts`, which is what surfaced
    // this; the card and the refusal text had both carried a "gone" case all along that nothing
    // could reach.
    //
    // The reason for the old silence was real, though, and it is why this is not simply "absent
    // means gone": a file caught mid-edit can fail to parse, and a parse failure yields *no*
    // symbols, so treating absence as deletion would report every symbol in that file as deleted
    // at once -- a burst of false refusals at precisely the moment an agent is typing.
    //
    // So absence only counts when the file demonstrably parsed: at least one other symbol in the
    // same file survived the re-index. That separates "this one symbol went away" from "this file
    // stopped being readable", which is the distinction the old code could not draw and therefore
    // resolved by saying nothing. A file whose last symbol was deleted is indistinguishable from a
    // parse failure by this test and stays silent -- recall lost in the one case where the
    // alternative is unfalsifiable.
    const file = locator.slice('symbol://'.length).split('#')[0];
    if (file && parsedFiles.has(file)) return { kind: 'gone' };
    return null;
  }

  if (locator.startsWith('file://')) {
    const relativePath = locator.slice('file://'.length);
    let result = fileHashes.get(relativePath);
    if (!result) fileHashes.set(relativePath, result = await fileContentHash(root, relativePath));
    if (result.kind === 'unreadable') return null;
    return result.kind === 'gone' ? { kind: 'gone' } : { kind: 'hash', hash: result.hash, signature: null };
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

/**
 * `OR IGNORE` against `idx_impact_findings_unique_open`, which is the half of the duplicate-notice
 * fix that `hasOpenFinding` cannot do alone: that check and this insert are not atomic across
 * processes, so two hooks firing on the same file in the same instant both pass the check. The
 * index makes the loser a no-op instead of a second notice; ignoring is right rather than raising
 * because losing the race means the finding already exists, which is the outcome we wanted.
 *
 * **Null when the row was ignored**, which is what keeps the caller's returned list a true account
 * of the table. Returning the object regardless would hand back an id that exists nowhere: it can
 * never be stamped `delivered_at`, never be adjudicated, and never be found again by any query --
 * a finding shaped exactly like a real one and attached to nothing.
 */
async function insertFinding(finding: ImpactFinding): Promise<ImpactFinding | null> {
  const result = await getClient().execute({
    sql: `INSERT OR IGNORE INTO impact_findings
            (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, delivered_at, resolution, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
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
  return Number(result.rowsAffected ?? 0) > 0 ? finding : null;
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
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
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
  // Files that still yield at least one symbol after the re-index -- the evidence that a file
  // parsed, which is what lets  tell a deleted symbol from an unreadable file.
  const parsedFiles = new Set<string>();
  for (const relativePath of relativePaths) {
    for (const symbol of await listCodeSymbols(relativePath)) {
      const locator = normalizeLocator(symbol.locator);
      if (!locator) continue;
      symbolsNow.set(locator, symbol);
      candidates.add(locator);
      parsedFiles.add(relativePath);
    }
    const fileLocator = normalizeLocator(`file://${relativePath}`);
    // Null for a path the read-set will not hold either -- an extensionless file, which its
    // directory heuristic refuses. Searching for a locator that cannot exist is not wrong, just
    // pointless; dropping it here keeps the candidate set equal to the set of findable things.
    if (fileLocator) candidates.add(fileLocator);
  }

  // The symbols that existed *before* the change are candidates too, and this is what makes a
  // deletion reachable at all. Built only from what the file has now, the candidate set can never
  // name a symbol the change removed -- so `activeReadersOf` never returns its reader, and the
  // strongest invalidation in the system was unreportable no matter what the comparison said. The
  // verdict for these still comes from `currentStateOf`, which only calls a missing symbol `gone`
  // when its file demonstrably re-parsed; a candidate that turns out to be present and unchanged
  // costs one map lookup and emits nothing.
  for (const locator of before.keys()) candidates.add(locator);

  const readers = await activeReadersOf(Array.from(candidates));
  const detectedAt = new Date().toISOString();
  const fileHashes = new Map<string, FileHashResult>();
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

    const state = await currentStateOf(root, entry.locator, symbolsNow, fileHashes, parsedFiles);
    if (state === null) continue;
    if (state.kind === 'hash' && state.hash === entry.observedHash) continue;

    // Suppression is per (cause locator, affected read), checked before the insert rather than
    // deduped after. The cost of a duplicate is not a wasted row, it is the same notice pushed
    // into the same agent's context a second time on the next tool call, into the channel measured
    // at ~20.8% accuracy cost. A resolved finding does not suppress: re-detection after the agent
    // dismissed one means the locator moved again.
    //
    // This check is the fast path, not the guarantee -- it is check-then-insert and two detectors
    // in separate processes can both pass it on the same instant. The guarantee is the partial
    // unique index on (cause_locator, affected_id) WHERE resolution IS NULL, which `insertFinding`
    // leans on with `INSERT OR IGNORE`. Keeping the check as well means the common case never
    // reaches the constraint at all, and the returned list stays free of rows the insert dropped.
    if (await hasOpenFinding(entry.locator, entry.id)) continue;

    const pathPayload: CertainImpactPath = {
      locator: entry.locator,
      observedHash: entry.observedHash,
      currentHash: state.kind === 'gone' ? null : state.hash,
      observedSignature: provenSignature(before, entry.locator, entry.observedHash),
      currentSignature: state.kind === 'gone' ? null : state.signature,
    };

    // Only what the table actually took. The check above makes this the common case by a wide
    // margin; the drop is the race it cannot close, and a dropped row means the notice already
    // exists, so there is nothing for this caller to report.
    const recorded = await insertFinding({
      id: generateId(),
      causeLocator: entry.locator,
      causeSession: causeSession ?? null,
      affectedKind: 'work',
      affectedId: entry.id,
      tier: 'certain',
      pathJson: JSON.stringify(pathPayload),
      detectedAt,
      deliveredAt: null,
      resolution: null,
      resolvedAt: null,
    });
    if (recorded) findings.push(recorded);
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
export async function openFindingsForSession(
  sessionId: string,
  tier?: ImpactTier,
  /**
   * Restrict to findings the card has never shown. Only the card passes this. The gate and the
   * pull tool must not, because an undelivered filter would hide from them exactly the findings
   * the agent has already been warned about and not yet acted on -- which are the ones that most
   * need gating.
   */
  undeliveredOnly = false,
): Promise<ImpactFinding[]> {
  const rows = await getClient().execute({
    sql: `SELECT f.id, f.cause_locator, f.cause_session, f.affected_kind, f.affected_id, f.tier,
                 f.path_json, f.detected_at, f.delivered_at, f.resolution, f.resolved_at
          FROM impact_findings f
          JOIN work_read_sets w ON w.id = f.affected_id
          WHERE f.resolution IS NULL AND f.affected_kind = 'work' AND w.session_id = ?
            ${tier ? 'AND f.tier = ?' : ''}
            ${undeliveredOnly ? 'AND f.delivered_at IS NULL' : ''}
          ORDER BY f.detected_at, f.id`,
    args: tier ? [sessionId, tier] : [sessionId],
  });
  return rows.rows.map(row => rowToFinding(row as unknown as Record<string, unknown>));
}

/**
 * Stamp findings as shown, so the card stops repeating them.
 *
 * Separate from `resolveFinding` on purpose, and this is the whole reason the column exists. The
 * card used to re-render every open finding on every tool event until somebody adjudicated it, and
 * the only lever available to quiet it was `resolution` -- which is the adjudication the ≥95%
 * precision number is computed from, so spending `dismissed` to silence a repeat would corrupt the
 * measurement this phase exists to produce. Delivery is a fact about the card; resolution is a fact
 * about the finding. Stamping this leaves `resolution` NULL, so the finding stays open for the gate
 * and stays in the denominator.
 *
 * `delivered_at IS NULL` in the predicate keeps the first delivery time rather than the latest, so
 * the column answers "when was this agent first told", which is the question worth asking of it.
 *
 * **Chunked, because the caller does not cap this list.** The card prints at most
 * `MAX_IMPACT_ENTRIES`, but `openImpactCardEntries` stamps every open undelivered finding it
 * fetched (`host-lifecycle.ts`), so the length here is bounded by how stale a session has become
 * and by nothing else. Past the bind ceiling -- measured at 32,766 on this build of libSQL, not the
 * 999 of an older default -- the statement throws inside `runToolEventImpact`, whose catch returns
 * no card at all; and since the stamp never lands, the same oversized set returns and throws again
 * on every following tool call. The design says a repeated card beats a swallowed one, and
 * unchunked this swallows every card from then on.
 */
const DELIVERY_CHUNK = 500;

export async function markFindingsDelivered(ids: string[]): Promise<void> {
  const wanted = [...new Set((ids ?? []).filter(id => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return;
  const deliveredAt = new Date().toISOString();
  for (let index = 0; index < wanted.length; index += DELIVERY_CHUNK) {
    const chunk = wanted.slice(index, index + DELIVERY_CHUNK);
    await getClient().execute({
      sql: `UPDATE impact_findings SET delivered_at = ?
            WHERE delivered_at IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`,
      args: [deliveredAt, ...chunk],
    });
  }
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
