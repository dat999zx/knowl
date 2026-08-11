/**
 * Corpus statistics the governing-decision guard needs, computed once and cached.
 *
 * WHY THIS EXISTS AT ALL. The guard first shipped comparing a raw cosine to a constant fitted per
 * embedding profile. Measured on a labelled set whose negatives were drawn UNIFORMLY from the real
 * write population, that turned out to be the weakest option available: AUC 0.836, and 0% recall
 * at the fire rate it actually shipped at. An earlier evaluation had scored it at 0.972, but that
 * set was stratified across score bands, which over-selects exactly the pairs an absolute
 * threshold handles well. Two changes follow, and both need corpus statistics rather than a
 * constant:
 *
 * 1. CSLS INSTEAD OF RAW COSINE. In high-dimensional spaces a few points become "hubs" that sit
 *    near many queries (Radovanović et al.); a broad, vaguely-worded decision is one, so it wins
 *    top-1 constantly and drowns the specific decision that actually governs a write. Cross-domain
 *    similarity local scaling subtracts each side's own neighbourhood mean -- `2s - r(write) -
 *    r(decision)` -- which penalises exactly that attractiveness. On the unbiased set it beats the
 *    raw cosine at every k tried (AUC 0.897-0.913 against 0.836), best at k=10.
 *
 * 2. A PERCENTILE INSTEAD OF A CONSTANT. A cosine means different things in different corpora,
 *    just as it does in different embedding spaces, so a number fitted here is not meaningful in
 *    someone else's store. Taking the threshold as a quantile of THIS store's own score
 *    distribution removes the per-corpus constant entirely and makes the noise budget a product
 *    decision: a gate at the qth percentile fires on (1-q) of writes by construction, so "notify
 *    on the noisiest 10% of writes" means the same thing everywhere.
 *
 * Both come out of ONE scan of stored vectors, which is why they live together here.
 */

import { getClient } from './database.js';
import { decodeVector } from './vector.js';

/** Neighbourhood size for the CSLS scaling terms. k=10 measured best; k=5 and k=20 were close. */
export const CSLS_K = 10;

/**
 * Share of writes that should produce a notice. This is the noise budget, and it is the only
 * number here anyone should want to tune: at 10% the guard caught about a third of governed
 * writes on the labelled set, against 16% for the raw-cosine gate at the same rate.
 */
export const FIRE_RATE = 0.10;

/**
 * Below this many decisions the guard abstains entirely. A threshold is a statement about a
 * distribution, and a handful of decisions do not have one. Kept in step with the calibration
 * script's own floor, which a test pins.
 */
export const MIN_POOL_FOR_Z = 25;

/** Cap on the write sample. The scan is O(sample x decisions); this bounds it without biasing. */
const SAMPLE_LIMIT = 400;

export type GuardStats = {
  /** Per decision: the mean cosine it receives from its k nearest writes. Its "hubness". */
  hub: Map<string, number>;
  /** CSLS score at the fire-rate quantile of this store's own writes. */
  threshold: number;
  decisionCount: number;
};

type Row = { id: string; vector: unknown; category: string };

let cache: { key: string; stats: GuardStats | null } | null = null;

/** Tests need this; the keying below means the product does not. */
export function resetGuardStatsCache(): void {
  cache = null;
}

const meanTopK = (values: number[], k: number): number => {
  const top = [...values].sort((a, b) => b - a).slice(0, k);
  return top.length ? top.reduce((sum, v) => sum + v, 0) / top.length : 0;
};

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

const unit = (v: ArrayLike<number>): Float32Array => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};

/**
 * Build the statistics, or return null when the corpus cannot support them.
 *
 * Null is a real answer and the caller abstains on it: too few decisions, too few writes, or no
 * embeddings under the current profile. Inventing a threshold from a corpus that has none would
 * make the guard fire on noise, which is the failure that gets a warning switched off.
 */
async function build(profileFingerprint: string): Promise<GuardStats | null> {
  const rows = await getClient().execute({
    sql: `SELECT e.knowledge_item_id AS id, e.vector AS vector, i.category AS category
          FROM knowledge_embeddings e
          JOIN knowledge_items i ON i.id = e.knowledge_item_id
          WHERE i.status = 'active' AND e.profile_fingerprint = ?`,
    args: [profileFingerprint],
  });

  const decisions: Array<{ id: string; v: Float32Array }> = [];
  const writes: Float32Array[] = [];
  for (const raw of rows.rows) {
    const row = raw as unknown as Row;
    const decoded = decodeVector(row.vector);
    if (!decoded) continue;
    const v = unit(decoded);
    if (row.category === 'decision') decisions.push({ id: String(row.id), v });
    else if (writes.length < SAMPLE_LIMIT) writes.push(v);
  }

  if (decisions.length < MIN_POOL_FOR_Z || writes.length < MIN_POOL_FOR_Z) return null;

  // One pass gives both halves: each column's top-k mean is a decision's hubness, and each row's
  // best CSLS is a sample of the distribution the threshold is a quantile of.
  const matrix = writes.map(w => decisions.map(d => dot(w, d.v)));
  const hub = new Map<string, number>();
  decisions.forEach((d, j) => hub.set(d.id, meanTopK(matrix.map(row => row[j]), CSLS_K)));

  const tops = matrix.map(row => {
    const rWrite = meanTopK(row, CSLS_K);
    let best = -Infinity;
    row.forEach((s, j) => {
      const scaled = 2 * s - rWrite - (hub.get(decisions[j].id) ?? 0);
      if (scaled > best) best = scaled;
    });
    return best;
  }).sort((a, b) => a - b);

  const index = Math.min(tops.length - 1, Math.floor(tops.length * (1 - FIRE_RATE)));
  return { hub, threshold: tops[index], decisionCount: decisions.length };
}

/**
 * Cached statistics for the current profile.
 *
 * Keyed on the profile fingerprint and the corpus size so a model change or a run of new writes
 * rebuilds, while ordinary traffic pays for the scan once. Never throws: a failure here must
 * degrade to "no opinion", never to a failed write.
 */
export async function guardStats(profileFingerprint: string): Promise<GuardStats | null> {
  let total: number;
  try {
    const counted = await getClient().execute({
      sql: 'SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE profile_fingerprint = ?',
      args: [profileFingerprint],
    });
    total = Number((counted.rows[0] as never as { n: number })?.n ?? 0);
  } catch {
    return null;
  }

  // Bucketed so a single write does not invalidate the scan, while a meaningful shift does.
  const key = `${profileFingerprint}|${Math.floor(total / 50)}`;
  if (cache?.key === key) return cache.stats;

  let stats: GuardStats | null;
  try {
    stats = await build(profileFingerprint);
  } catch {
    stats = null;
  }
  cache = { key, stats };
  return stats;
}
