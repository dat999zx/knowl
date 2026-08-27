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
};

/**
 * One claim, named rather than merely counted, and ranked against its OWN category's cadence.
 *
 * **A ranked list is why this reports something today and a threshold would not.** Flagging needs
 * a cutoff -- "past N days is stale" -- and N cannot be chosen on a store younger than the cadence
 * it is trying to measure, which is what deferred the flagging half of #98 to roughly 2027-02.
 * Ordering needs no cutoff, so it is correct at any store age and sharpens on its own.
 *
 * **But ranking on raw age is degenerate, and measurement caught it.** Rendered against this
 * repo's own 1,072-item store, the five oldest claims all came back at 54.5d -- the store's exact
 * age -- because a store is seeded in one batch and that batch is permanently its oldest cohort.
 * The list said "the day you created the store is the oldest day in it", which is the same
 * non-finding as the per-category `oldest` column it replaced, and every future store repeats it.
 *
 * `ratio` is days divided by the median for that category, so a claim is measured against how
 * often claims of its KIND actually get restated. An architecture note at 54.5d against an 18d
 * median is three cadences past due and worth opening; a goal at 54.5d against a 45.5d median is
 * ordinary. Both are the same age, and only one is interesting. This also breaks the seed-cohort
 * tie on a real signal rather than on row order.
 */
export type UnrestatedItem = { title: string; category: KnowledgeCategory; days: number; ratio: number };

/** How many claims to name. Enough to act on, short enough to live in a status block. */
const OLDEST_NAMED = 5;

export type UnrestatedReport = {
  rows: UnrestatedCategoryRow[];
  /**
   * The claims furthest past their own category's cadence, named. The per-category medians say
   * the corpus is maintained unevenly; only these say what to go and look at, and a title can be
   * opened where a distribution can only be nodded at.
   */
  outliers: UnrestatedItem[];
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
   *
   * It also bounds every age here: nothing can be older than the store it lives in, which is why
   * `outliers` ranks on the ratio to a category median rather than on age directly.
   */
  storeHistoryDays: number;
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
  let storeHistoryDays = 0;
  const prose: UnrestatedItem[] = [];
  const byCategory = new Map<KnowledgeCategory, number[]>();

  for (const row of rows) {
    const age = daysBetween(String(row.validFrom), now);
    // Every row, prose or not: this bounds what the whole report can mean, and a code-coupled
    // item is still part of the store's history.
    storeHistoryDays = Math.max(storeHistoryDays, age);
    if (citesCode(row as never)) { codeCount += 1; continue; }

    const paths = [...(normalizeAffectedPaths(row.affectedPaths as string[] | null) ?? []), ...sourcePaths(row.source)];
    if (paths.length > 0) prosePathOnly += 1;

    const category = String(row.category) as KnowledgeCategory;
    prose.push({ title: String(row.title), category, days: round1(age), ratio: 0 });
    const ages = byCategory.get(category) ?? [];
    ages.push(age);
    byCategory.set(category, ages);
  }

  const rowsByAge = [...byCategory.entries()].map(([category, ages]) => {
    const sorted = [...ages].sort((a, b) => a - b);
    return { category, count: ages.length, medianDays: round1(percentile(sorted, 0.5)) };
    // Longest-un-restated first. Measured ordering on a real store put constraint, skill and
    // decision at the top and `state` among the best maintained, which inverts the intuition that
    // state rots fastest -- a state atom gets rewritten as the state changes, which is the one
    // case where the write path already forces a restatement. Sorting rather than hard-coding a
    // category order means the report keeps telling the truth if that ordering changes.
  }).sort((a, b) => b.medianDays - a.medianDays);

  // A median can legitimately be 0 -- a category whose every claim was restated today -- and that
  // is a real state, not a guard to skip. Flooring at a tenth of a day keeps the division finite,
  // and such a category cannot crowd the list anyway: its items have a `days` near zero, so their
  // ratio is near zero too.
  const medians = new Map(rowsByAge.map(row => [row.category, Math.max(row.medianDays, 0.1)]));

  const report: UnrestatedReport = {
    rows: rowsByAge,
    // Ties on the ratio fall back to age, so the seed cohort still orders deterministically
    // rather than by whatever order the rows came back in.
    //
    // ponytail: no per-category cap, so one category can take most of the five. Rendered against
    // this repo it does -- four of five are `fact`, which holds the seed cohort AND has the
    // lowest median, so its items score highest on both terms. That is the correct answer rather
    // than a bug (those claims really are furthest past their kind's cadence) and it spreads out
    // as the store ages. Cap at two per category if the list is still repeating itself by then.
    outliers: prose
      .map(item => ({ ...item, ratio: round1(item.days / (medians.get(item.category) ?? 0.1)) }))
      .sort((a, b) => b.ratio - a.ratio || b.days - a.days)
      .slice(0, OLDEST_NAMED),
    proseCount: rows.length - codeCount,
    codeCount,
    prosePathOnly,
    storeHistoryDays: round1(storeHistoryDays),
  };
  return report.rows.length === 0 ? undefined : report;
}
