import type { ImpactCardEntry } from './change-card.js';
import { loadConfig } from '../core/config.js';
import { getClient } from '../store/database.js';
import { impactGateMode } from '../store/impact-config.js';
import { recordShadowBlock } from '../store/gate-shadow.js';
import { openFindingsForSession } from './impact.js';
import { activeReadSetForSession, repoRelativePath, type ReadSetEntry } from '../store/read-set.js';

/**
 * Refuse one write whose premise has already moved, and hand back the diff that explains it.
 *
 * This is the only part of the change-impact design with a measured mechanism behind it. Telling
 * an agent its premise is stale is measured at approximately zero effect twice, independently:
 * SWE-Touch finds message-plus-edit no better than the silent edit and *worse* for 3 of 4 models,
 * CooperBench finds a first-turn plan halves the conflict rate while moving end-to-end success by
 * an amount that is not statistically significant. The one intervention that moved a number is
 * STORM's -- reject the write, return the diff, let the agent re-read and retry (+18.7 on
 * Commit0-Lite). So the notice is the courtesy and this is the mechanism (plan §0, §7.5).
 *
 * **Nothing is discarded.** What a denial costs is one tool call, which the agent reissues after
 * re-reading. That is the whole reason this is safe where CoAgent's optimistic concurrency was not
 * -- aborting a trajectory bought 0.93x speedup at 1.83x tokens, slower than serial while costing
 * 83% more, and every published approach that discarded agent work underperformed (plan §6).
 *
 * **Symbol granularity, and that is the one improvement on STORM.** Its own stated limitation is
 * that file-level rejection false-positives when two agents edit different functions in one file.
 * The read-set stores `symbol://path#Name`, so a session that read `createSession` is not blocked
 * from editing `destroySession` beside it.
 *
 * **The staleness verdict is not computed here.** A denial is predicated on an open certain-tier
 * finding from `impact.ts`, which is where "did this locator move" lives. That is deliberate reuse
 * rather than tidiness: a second copy of the comparison would drift from the first, and the two
 * would disagree about which reads are stale -- the gate blocking writes the card never mentions,
 * or the card naming changes the gate lets through. It also inherits, for free and by
 * construction, the two conditions hardest to re-derive at gate time: the hash moved *since that
 * read* (detection compares against the read-set row's own `observed_hash`), and the change was
 * *not this session's own* (`detectCertainImpact` self-excludes on `causeSession`, without which
 * every second edit to a file the agent itself just changed would be refused).
 *
 * **Fail open, without exception.** Flag off, no session, unknown host, no deny capability, a
 * broken store, a malformed row, a failed release -- every one of them allows the write. A
 * detector that stays silent costs recall on an advisory subsystem; a gate that wrongly blocks
 * costs a person their working session, and this runs in front of every write in every session of
 * every repo that turned it on.
 *
 * **And it refuses nothing until it has earned the right to.** `impact.gate` starts at `off`, and
 * the step before `enforce` is `shadow`: the identical verdict, recorded rather than delivered, so
 * the ≥95%-over-≥40-findings bar plan §9 sets is measured against real traffic before a single
 * write is stopped. Shadow deliberately does not release the read-set rows it names -- see the
 * branch in `shouldRefuseWrite` -- because the table it would be writing to is the same one the
 * measurement is computed from.
 */

/** What the caller needs to act: whether to refuse, and the text that makes a refusal actionable. */
export interface WriteGateDecision {
  deny: boolean;
  /** Non-null exactly when `deny` is true. */
  reason: string | null;
  /**
   * The read-set rows this denial named and released. Present so the caller can see the one-shot
   * happened rather than take it on trust; see `releaseGatedReads`.
   *
   * Empty in `shadow`, which withholds the refusal and therefore has no one-shot to spend.
   */
  releasedReadIds: string[];
  /**
   * The findings this call recorded as withheld refusals. Non-empty only in `shadow`, and only
   * for beliefs not already on file.
   *
   * It exists because `shadow` and "nothing was wrong" are otherwise the same `allow()`, and a
   * caller that cannot tell them apart cannot report what the gate is finding while it is not
   * blocking -- which is the entire output of shadow mode.
   */
  shadowedFindingIds: string[];
}

/**
 * Entries per refusal, matching `MAX_IMPACT_ENTRIES` in `change-card.ts` and for the same reason:
 * an entry that can prove both signatures costs three lines, and past the third one the refusal
 * has already made its case and is only spending the agent's context.
 */
const MAX_GATE_ENTRIES = 3;

/** Paths, not entries: several changed symbols in one file are one file to re-open. */
const MAX_REREAD_PATHS = 3;

/**
 * Matches `MAX_TITLE_LENGTH` in `change-card.ts`, which is private to it. Same channel, same
 * one-line ceiling; a second number that is allowed to differ is a number someone has to remember
 * to keep equal.
 */
const MAX_SIGNATURE_LENGTH = 90;

const allow = (): WriteGateDecision => ({ deny: false, reason: null, releasedReadIds: [], shadowedFindingIds: [] });


/**
 * The file a locator names, or null when its shape does not name one.
 *
 * First `#`, matching `normalizeLocator` and `describeLocator`: a path cannot contain one, a
 * qualified name conceivably can. An unrecognised scheme yields no path and therefore blocks
 * nothing -- inventing a file out of a locator we cannot parse is how a gate refuses a write it
 * has no evidence against.
 */
function locatorFilePath(locator: string): string | null {
  if (locator.startsWith('symbol://')) {
    const rest = locator.slice('symbol://'.length);
    const hash = rest.indexOf('#');
    const filePath = hash < 0 ? rest : rest.slice(0, hash);
    return filePath || null;
  }
  if (locator.startsWith('file://')) return locator.slice('file://'.length) || null;
  return null;
}

/** The locator as a human reads it, and what moved about it -- `change-card.ts`'s wording. */
function describeLocator(locator: string): { display: string; phrase: string } {
  if (locator.startsWith('symbol://')) {
    return { display: locator.slice('symbol://'.length), phrase: 'signature changed since you read it' };
  }
  if (locator.startsWith('file://')) {
    return { display: locator.slice('file://'.length), phrase: 'file changed since you read it' };
  }
  return { display: locator, phrase: 'changed since you read it' };
}

/**
 * Truncation that announces itself, copied from `change-card.ts`'s private renderer.
 *
 * A cut-off signature still reads as a complete, valid signature, and an agent that believes one
 * writes a call against the parameters that were sliced away -- which is the failure this whole
 * refusal exists to prevent, reintroduced by the text meant to prevent it.
 */
function renderSignature(signature: string): string {
  const flat = signature.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SIGNATURE_LENGTH ? `${flat.slice(0, MAX_SIGNATURE_LENGTH - 1)}…` : flat;
}

/**
 * The was/now pair a finding can prove, or nulls.
 *
 * `path_json` is parsed rather than recomputed because it cannot be recomputed: by the time
 * anything renders, the only surviving record of the old state is a hash, and a hash does not
 * render (`impact.ts:79`). A row written by a different version, or truncated, degrades to a
 * locator with no pair rather than throwing inside a hook.
 */
function provenPair(pathJson: string | null): { was: string | null; now: string | null } {
  try {
    const payload = pathJson ? JSON.parse(pathJson) as Record<string, unknown> : {};
    const asText = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
    return { was: asText(payload.observedSignature), now: asText(payload.currentSignature) };
  } catch {
    return { was: null, now: null };
  }
}

/**
 * The refusal text, which *is* the product.
 *
 * Three things, in STORM's order: what changed, the was/now pair, and an explicit instruction to
 * re-read before retrying. Strip any of them and what is left is the bare announcement measured at
 * no consistent improvement and worse than silence for 3 of 4 models -- an agent that is told "no"
 * without being told what moved has been given an obstacle rather than information.
 *
 * **Both signature halves or neither**, the same rule `change-card.ts` follows. A null `was` means
 * the detector could not prove the agent saw that text, so printing a plausible one would be a
 * fabricated quote inside a refusal whose only value is being trustworthy. A lone `now:` goes too:
 * it is already in the file the agent is being sent to re-read.
 *
 * The last line states the one-shot plainly. Hiding it would read better and would be a lie -- the
 * block genuinely does not fire twice (see `releaseGatedReads`), and an agent that discovers that
 * by accident learns the gate is bluffable. Stated with its consequence attached, it is the honest
 * shape of what this is: a mandatory pause with the diff in hand, not a lock.
 */
function renderRefusal(entries: ImpactCardEntry[], paths: string[]): string {
  const shown = entries.slice(0, MAX_GATE_ENTRIES);
  const lines = shown.flatMap(entry => {
    const { display, phrase } = describeLocator(entry.locator);
    const head = `- ${display} — ${phrase}`;
    if (!entry.wasSignature || !entry.nowSignature) return [head];
    return [head, `  was: ${renderSignature(entry.wasSignature)}`, `  now: ${renderSignature(entry.nowSignature)}`];
  });
  const remaining = entries.length - shown.length;
  if (remaining > 0) lines.push(`- +${remaining} more`);

  const shownPaths = paths.slice(0, MAX_REREAD_PATHS);
  const morePaths = paths.length - shownPaths.length;
  const target = `${shownPaths.join(', ')}${morePaths > 0 ? ` (+${morePaths} more)` : ''}`;
  const subject = entries.length === 1
    ? '1 thing you read has changed'
    : `${entries.length} things you read have changed`;

  return [
    `KNOWL BLOCKED THIS WRITE: ${subject}, so this edit is written against a version that is no longer there.`,
    ...lines,
    `Re-read ${target}, reconcile your change with what is there now, then make this edit again.`,
    'This block fires once per stale read: retrying without re-reading is not blocked, and overwrites a version you have not seen.',
  ].join('\n');
}

/**
 * Release exactly the reads this refusal named, and report whether it stuck.
 *
 * **This is the no-deny-loop guarantee, and it is deliberately not predicated on the agent doing
 * anything.** The natural path does close on its own: an agent that re-reads the file goes through
 * `recordRead`, which releases the superseded row and inserts a new one carrying the current hash,
 * so the retry finds no live stale belief and passes. But that path only exists for a re-read the
 * capture layer sees -- `Read` and `NotebookRead`. An agent that re-reads with `cat`, `sed -n` or
 * any other shell command updates nothing, and without this it would be refused on every retry
 * forever, having done exactly what it was asked to do. A gate that can trap an agent is strictly
 * worse than no gate, so the one-shot is unconditional: at most one refusal per stale belief, and
 * the belief has to be re-observed to arm again.
 *
 * Released, never deleted, and the finding is left open -- both following the subsystem's own
 * rules. The row is the evidence the refusal was justified and the denominator plan §9's precision
 * number is computed against, and `resolution` is the adjudication that number comes from, so
 * spending `dismissed` here to quiet a gate would corrupt the one measurement this phase exists to
 * produce.
 *
 * The UPDATE is issued here rather than through `read-set.ts` because that module exports release
 * by session and by task, not by row, and it is another lane's file. The predicate is the same one
 * `releaseReadSet` uses.
 *
 * Returning false means the refusal is abandoned. That ordering is the point: a denial we could not
 * record is a denial that would fire again on the retry, which is the loop this exists to make
 * impossible.
 */
async function releaseGatedReads(ids: string[]): Promise<boolean> {
  const releasedAt = new Date().toISOString();
  try {
    const client = getClient();
    for (const id of ids) {
      await client.execute({
        sql: 'UPDATE work_read_sets SET released_at = ? WHERE id = ? AND released_at IS NULL',
        args: [releasedAt, id],
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this write should be refused, and why.
 *
 * **Three modes, one verdict.** `impact.gate` decides what is done with the answer, never what the
 * answer is: `off` does not compute it, `shadow` computes it and records it in
 * `impact_gate_shadow` while letting the write through, `enforce` refuses. Shadow is the default
 * destination rather than a debugging aid -- plan §9 requires ≥95% precision over ≥40 adjudicated
 * findings before this is allowed to block anything, and that number cannot be measured by a gate
 * that is already blocking.
 *
 * Deny only when all four hold, and allow whenever any of them is merely probable:
 *
 * 1. the repository asked for change-impact detection *and* armed the gate;
 * 2. this session has an *unreleased* read-set row for a locator in a file being written;
 * 3. that row's `observed_hash` no longer matches what is there -- established by the finding,
 *    which was recorded by comparing against that exact row;
 * 4. the change was not this session's own -- established by the same finding, which
 *    `detectCertainImpact` never emits against its own `causeSession`.
 *
 * Conditions 3 and 4 arrive together because they are the same record. A finding whose affected
 * row is no longer live has already been superseded by a fresh read and is not a reason to refuse
 * anything, which is why the live read-set is intersected rather than trusted from the join.
 *
 * `targetPaths` is what the write is about to touch, in whatever spelling the host reported.
 *
 * Cheapest checks first, and the order is load-bearing rather than tidy: pure string work, then
 * the config, then the findings query -- which returns nothing in the overwhelming majority of
 * writes and ends the call before the read-set is loaded at all. This runs in front of every write
 * tool call in the session.
 */
export async function shouldRefuseWrite(
  root: string,
  sessionId: string,
  targetPaths: string[],
): Promise<WriteGateDecision> {
  try {
    if (!sessionId || !Array.isArray(targetPaths) || targetPaths.length === 0) return allow();

    const targets = new Set<string>();
    for (const target of targetPaths) {
      if (typeof target !== 'string') continue;
      const relative = repoRelativePath(root, target);
      if (relative !== null) targets.add(relative);
    }
    if (targets.size === 0) return allow();

    // `loadConfig` throws on a missing or unreadable config, and an unreadable config is the off
    // case by `impactGateMode`'s own rule: every failure mode of this subsystem is a failure of
    // turning it on, and this one takes away someone's ability to write a file.
    const config = await loadConfig(root).catch(() => null);
    const mode = impactGateMode(config ?? undefined);
    if (mode === 'off') return allow();

    const findings = await openFindingsForSession(sessionId, 'certain');
    if (findings.length === 0) return allow();

    const live = new Map<string, ReadSetEntry>();
    for (const entry of await activeReadSetForSession(sessionId)) live.set(entry.id, entry);
    if (live.size === 0) return allow();

    const entries: ImpactCardEntry[] = [];
    const paths: string[] = [];
    const ids: string[] = [];
    // Collected alongside `ids` rather than derived from it. The two are the same value today --
    // `detectCertainImpact` writes `affectedId: entry.id` -- but they answer different questions,
    // and the shadow log keys on the finding because that is what carries the adjudication.
    const findingIds: string[] = [];
    for (const finding of findings) {
      const entry = live.get(finding.affectedId);
      // Released since the finding was recorded: the session has re-read this locator and the
      // belief the finding was about is no longer one it holds.
      if (!entry) continue;
      const filePath = locatorFilePath(entry.locator);
      if (filePath === null || !targets.has(filePath)) continue;
      if (ids.includes(entry.id)) continue;

      const pair = provenPair(finding.pathJson);
      ids.push(entry.id);
      findingIds.push(finding.id);
      entries.push({ locator: entry.locator, wasSignature: pair.was, nowSignature: pair.now });
      if (!paths.includes(filePath)) paths.push(filePath);
    }
    if (entries.length === 0) return allow();

    /*
     * Shadow: the same verdict, withheld.
     *
     * **Nothing is released, and that is the point.** Enforcing mode releases these rows so a
     * retry is never blocked twice, which is safe there because the agent has been told to
     * re-read. Doing it here would clear a belief nobody re-read, and `work_read_sets` would stop
     * describing what the session holds -- while being the evidence the precision number is
     * computed from. A diagnostic must not change the process it observes.
     *
     * The belief therefore stays live and this same finding returns on the next write to the file;
     * `idx_impact_gate_shadow_finding` is what stops that inflating the count, so the number of
     * rows stays equal to the number of denials `enforce` would have issued.
     *
     * `paths[0]` because the row is written once and every later attempt is ignored, so the column
     * answers "what was in flight when this would first have been blocked" -- the question a
     * false-positive adjudication actually asks.
     */
    if (mode === 'shadow') {
      const shadowedFindingIds: string[] = [];
      for (const findingId of findingIds) {
        if (await recordShadowBlock({ findingId, sessionId, targetPath: paths[0] })) {
          shadowedFindingIds.push(findingId);
        }
      }
      return { deny: false, reason: null, releasedReadIds: [], shadowedFindingIds };
    }

    // Refuse only once the one-shot is durable. See `releaseGatedReads`.
    if (!await releaseGatedReads(ids)) return allow();

    return { deny: true, reason: renderRefusal(entries, paths), releasedReadIds: ids, shadowedFindingIds: [] };
  } catch {
    // Anything at all -- a store mid-snapshot, a schema older than the read-set, a row shaped by a
    // future version. The write proceeds.
    return allow();
  }
}
