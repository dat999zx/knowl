import crypto from 'node:crypto';
import { getClient } from './database.js';

/**
 * What an enforcing write gate *would* have refused, recorded while it refuses nothing.
 *
 * The gate is the one part of the change-impact design that can cost somebody their working
 * session -- a wrong refusal does not degrade quietly, it stops a person's agent from editing a
 * file. So plan §9 puts a bar in front of it: ≥95% precision over ≥40 findings, adjudicated. This
 * module is the table that bar is computed from. Shadow mode runs the real verdict and withholds
 * the refusal; every withheld refusal lands here.
 *
 * **One row per stale belief, and the uniqueness is the index's job rather than this module's.**
 * Shadow mode deliberately does not release the read-set rows it names. Enforcing mode does, so a
 * retry is never blocked twice, and that is safe there because the agent has been told to re-read.
 * Doing the same while merely observing would clear a belief nobody re-read, and `work_read_sets`
 * would stop describing what the session actually holds -- while being the evidence this
 * measurement rests on. The belief therefore stays live and the same finding arrives again on
 * every later write to that file, so without `idx_impact_gate_shadow_finding` the row count would
 * measure *writes attempted* rather than *denials an enforcing gate would have issued*, and those
 * differ by however many times an agent happens to edit one file.
 *
 * **No adjudication of its own.** Every row names a finding, and findings already carry
 * `resolution`, set through `knowl_impact({resolve})` -- which plan §15 established is the only
 * adjudication path, precisely because the gate leaves findings open by design. A second verdict
 * column here would be a second answer to a question that already has one.
 *
 * Advisory throughout, like the rest of this lane: the write path never throws, because it runs
 * inside `PreToolUse` with a host blocked on the answer and the entire promise of shadow mode is
 * that it cannot affect the write.
 */

const newId = (): string => crypto.randomUUID().replace(/-/g, '').substring(0, 16);

export interface ShadowGatePrecision {
  /** Shadow rows whose finding has been adjudicated. The denominator, and nothing else. */
  adjudicated: number;
  falsePositives: number;
  /**
   * `1 − falsePositives / adjudicated`, or **null** when nothing has been adjudicated.
   *
   * Null rather than 1, because no evidence is not a perfect score: returning 1 would let an
   * untouched install report that it had cleared a ≥95% bar it has never measured against.
   */
  precision: number | null;
}

/**
 * Record one withheld refusal. True when this belief had not been recorded before.
 *
 * `INSERT OR IGNORE` against the unique index, following `insertFinding`, and for the same reason
 * expressed differently: there, the repeat is a lost race; here, the repeat is the *designed*
 * case, since the belief stays live and returns on every later write to the same file. Either way
 * a duplicate means the row already exists, which is the outcome wanted.
 *
 * Blank input is dropped rather than stored. An empty `finding_id` is worse than a missing row --
 * it satisfies `NOT NULL` while joining to nothing, so it would sit in the table inflating the
 * count of blocks and contributing to no adjudication ever.
 *
 * Never throws, at all. A store mid-snapshot, or one on a schema older than this table, costs one
 * measurement; an exception here would surface as a broken tool call in front of the agent, which
 * is precisely the harm shadow mode exists to avoid while the real gate is being evaluated.
 */
export async function recordShadowBlock(
  input: { findingId: string; sessionId: string; targetPath: string },
): Promise<boolean> {
  const findingId = (input?.findingId ?? '').trim();
  const sessionId = (input?.sessionId ?? '').trim();
  const targetPath = (input?.targetPath ?? '').trim();
  if (!findingId || !sessionId || !targetPath) return false;

  try {
    const result = await getClient().execute({
      sql: `INSERT OR IGNORE INTO impact_gate_shadow (id, finding_id, session_id, target_path, observed_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [newId(), findingId, sessionId, targetPath, new Date().toISOString()],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * How many refusals have been withheld -- the `≥40 findings` half of plan §9's bar.
 *
 * Counts rows rather than adjudicated rows on purpose: this answers "is there enough to measure
 * yet", which is a different question from "what does the measurement say".
 */
export async function countShadowBlocks(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM impact_gate_shadow');
  return Number(rows.rows[0]?.total ?? 0);
}

/**
 * `1 − false_positive / adjudicated`, over the findings the shadow rows point at.
 *
 * **Unresolved findings are excluded from both halves rather than counted as correct.** Nothing
 * forces adjudication, so early on the unresolved set is the larger one; treating those blocks as
 * justified is how a precision number talks its way past the bar it was meant to clear. The
 * denominator is deliberately the adjudicated count and not `countShadowBlocks()`.
 *
 * The join is on `impact_findings`, which `sweepReadSets` does not touch -- so this survives the
 * GC that hard-deletes released read-set rows underneath it.
 */
/**
 * The bar plan §9 puts in front of enforcing the write gate: >=95% precision over >=40 findings.
 *
 * Stated here as constants rather than left in prose, because the report that prints the
 * measurement has to print what the measurement is being judged against. A precision figure with
 * no bar beside it is a number nobody can act on -- which is how this measurement came to be
 * computed by a function nothing imported.
 */
export const SHADOW_GATE_PRECISION_BAR = 0.95;
export const SHADOW_GATE_SAMPLE_BAR = 40;

/** The precision measurement plus the sample it was taken over, which the bar also names. */
export type ShadowGateReport = ShadowGatePrecision & { withheld: number };

/** Everything `knowl status` needs to say about the shadow gate, in one round trip each. */
export async function shadowGateReport(): Promise<ShadowGateReport> {
  try {
    const [withheld, precision] = await Promise.all([countShadowBlocks(), shadowGatePrecision()]);
    return { withheld, ...precision };
  } catch {
    // A store on a schema older than `impact_gate_shadow` reports nothing rather than failing
    // the whole status command over a block that is absent by design on such a store.
    return { withheld: 0, adjudicated: 0, falsePositives: 0, precision: null };
  }
}

export async function shadowGatePrecision(): Promise<ShadowGatePrecision> {
  const rows = await getClient().execute(
    `SELECT COUNT(*) AS adjudicated,
            SUM(CASE WHEN f.resolution = 'false_positive' THEN 1 ELSE 0 END) AS false_positives
     FROM impact_gate_shadow s
     JOIN impact_findings f ON f.id = s.finding_id
     WHERE f.resolution IS NOT NULL`,
  );
  const adjudicated = Number(rows.rows[0]?.adjudicated ?? 0);
  const falsePositives = Number(rows.rows[0]?.false_positives ?? 0);
  return {
    adjudicated,
    falsePositives,
    precision: adjudicated === 0 ? null : 1 - falsePositives / adjudicated,
  };
}
