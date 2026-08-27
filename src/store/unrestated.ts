import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { normalizeAffectedPaths, sourcePaths } from './freshness.js';
import type { KnowledgeCategory } from '../core/types.js';

/**
 * How long has it been since anyone RESTATED each claim, for the knowledge no drift check can
 * reach.
 *
 * Report only. Nothing here flips `freshness`, and that is the design rather than a first step
 * towards it: for prose there is no evidence a claim became false, only the absence of anyone
 * reaffirming it, and flagging asserts a defect nothing observed. dat999zx/knowl#98 states the
 * out-of-scope line in the same terms -- losing knowledge nobody can recover is strictly worse
 * than carrying a stale atom that ranks 6% lower.
 *
 * **`valid_from` is the clock, and it is the only honest one available.** `updated_at` moves on
 * visibility promotion, supersession and status changes, none of which mean anyone revisited the
 * claim; measured on a 950-item store, 72% of items have `updated_at` newer than `valid_from`.
 * A new assertion generation is written only when title, content, reasoning or confidence change
 * (`repository.ts`), so `valid_from` moves on restatement and on nothing else.
 *
 * Retrieval counts are deliberately not an input. A read-count prior is a feedback loop in which
 * an atom that ranks high is read more and therefore ranks higher, with nothing in the loop asking
 * whether it is true -- the trap Mem0's audit hit at 808 stored copies of one hallucinated
 * preference.
 */

/** File extensions that make a cited path prose rather than code. */
const PROSE_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst', '.adoc'];

const isProsePath = (path: string): boolean =>
  PROSE_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension));

/**
 * Whether an item cites code, which is what decides a drift check can speak to it at all.
 *
 * **Citing a path is not the same as citing code**, and the distinction is not cosmetic: an atom
 * whose only path is `docs/research/competitor-teardown.md` has a non-empty `affectedPaths` and
 * is still exactly the prose this report exists for. A census keyed on "has any path" counts it
 * on the wrong side. Reviewed on #98 and confirmed small, but small in degree is not the same as
 * right, and `prosePathOnly` below reports how many items the distinction actually moves so the
 * number can be argued with rather than trusted.
 */
export function citesCode(item: { affectedPaths?: string[] | null; source?: string | null }): boolean {
  const paths = [...(normalizeAffectedPaths(item.affectedPaths) ?? []), ...sourcePaths(item.source)];
  return paths.some(path => !isProsePath(path));
}

export type UnrestatedCategoryRow = {
  category: KnowledgeCategory;
  count: number;
  /** Days since restatement at the 50th percentile, one decimal. */
  medianDays: number;
  /** Days since restatement for the single oldest item in this category. */
  oldestDays: number;
  oldestTitle: string;
};

export type UnrestatedReport = {
  rows: UnrestatedCategoryRow[];
  proseCount: number;
  codeCount: number;
  /**
   * Items counted as prose ONLY because every path they cite is a prose file. This is the size of
   * the disagreement between "has no paths" and "cites no code" -- the reconciliation #98 asked
   * for, published rather than resolved silently.
   */
  prosePathOnly: number;
  /**
   * Age of the oldest open assertion anywhere in the store, prose or not.
   *
   * Printed beside the buckets because it bounds what they can mean. Every measurement so far has
   * found an empty `>60d` bucket while the oldest store was itself under 60 days old, which cannot
   * distinguish "nothing rots past 60 days" from "no store is old enough to say". A reader who
   * cannot see this number will read the first when the data only supports the second.
   */
  storyDays: number;
};

const daysBetween = (fromIso: string, now: number): number => {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, (now - from) / 86_400_000);
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Returns undefined when there is nothing to say -- no active item carries an open assertion --
 * so a caller renders no section rather than an empty one.
 */
export async function unrestatedClaimsReport(now: number = Date.now()): Promise<UnrestatedReport | undefined> {
  const db = getDb();
  const rows = await db
    .select({
      category: schema.knowledgeItems.category,
      title: schema.knowledgeItems.title,
      affectedPaths: schema.knowledgeItems.affectedPaths,
      source: schema.knowledgeItems.source,
      validFrom: schema.knowledgeAssertions.validFrom,
    })
    .from(schema.knowledgeItems)
    .innerJoin(
      schema.knowledgeAssertions,
      eq(schema.knowledgeAssertions.knowledgeItemId, schema.knowledgeItems.id),
    )
    // The OPEN assertion only. A replaced generation is the record of a claim that has already
    // been restated, so counting it would date an item by a restatement that happened.
    .where(and(
      eq(schema.knowledgeItems.status, 'active'),
      isNull(schema.knowledgeAssertions.replacedAt),
      isNull(schema.knowledgeAssertions.validTo),
    ));

  if (rows.length === 0) return undefined;

  let codeCount = 0;
  let prosePathOnly = 0;
  let storyDays = 0;
  const byCategory = new Map<string, { ages: number[]; oldest: { days: number; title: string } }>();

  for (const row of rows) {
    const age = daysBetween(String(row.validFrom), now);
    storyDays = Math.max(storyDays, age);
    if (citesCode(row as never)) { codeCount += 1; continue; }

    const paths = [...(normalizeAffectedPaths(row.affectedPaths as string[] | null) ?? []), ...sourcePaths(row.source)];
    if (paths.length > 0) prosePathOnly += 1;

    const bucket = byCategory.get(String(row.category)) ?? { ages: [], oldest: { days: -1, title: '' } };
    bucket.ages.push(age);
    if (age > bucket.oldest.days) bucket.oldest = { days: age, title: String(row.title) };
    byCategory.set(String(row.category), bucket);
  }

  const report: UnrestatedReport = {
    rows: [...byCategory.entries()].map(([category, bucket]) => {
      const sorted = [...bucket.ages].sort((a, b) => a - b);
      return {
        category: category as KnowledgeCategory,
        count: bucket.ages.length,
        medianDays: round1(percentile(sorted, 0.5)),
        oldestDays: round1(bucket.oldest.days),
        oldestTitle: bucket.oldest.title,
      };
    // Longest-un-restated first. Measured ordering on a real store put constraint, skill and
    // decision at the top and `state` among the best maintained, which inverts the intuition that
    // state rots fastest -- a state atom gets rewritten as the state changes, which is the one
    // case where the write path already forces a restatement. Sorting rather than hard-coding a
    // category order means the report keeps telling the truth if that ordering changes.
    }).sort((a, b) => b.medianDays - a.medianDays),
    proseCount: rows.length - codeCount,
    codeCount,
    prosePathOnly,
    storyDays: round1(storyDays),
  };
  return report.rows.length === 0 ? undefined : report;
}
