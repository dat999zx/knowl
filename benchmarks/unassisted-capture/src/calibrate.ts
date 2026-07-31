import { cosine } from './matcher.js';

export interface CalibrationPair {
  a: string;
  b: string;
  same: boolean;
}

export interface ScoredPair {
  similarity: number;
  same: boolean;
}

export interface CalibrationResult {
  threshold: number;
  agreement: number;
  scored: ScoredPair[];
}

export type Embed = (texts: string[]) => Promise<number[][]>;

/**
 * Picks the threshold maximising agreement with the hand judgments. Candidates are midpoints
 * between adjacent observed similarities, so the chosen value never sits exactly on an
 * observed score where a floating-point tie would decide a match.
 */
export function chooseThreshold(scored: ScoredPair[]): { threshold: number; agreement: number } {
  if (scored.length === 0) {
    throw new Error('Cannot derive a threshold from an empty calibration set.');
  }

  const sorted = [...scored].sort((a, b) => a.similarity - b.similarity);
  const candidates: number[] = [sorted[0].similarity - 0.01];
  for (let i = 1; i < sorted.length; i++) {
    candidates.push((sorted[i - 1].similarity + sorted[i].similarity) / 2);
  }
  candidates.push(sorted[sorted.length - 1].similarity + 0.01);

  let best = { threshold: candidates[0], agreement: -1 };
  for (const threshold of candidates) {
    const correct = scored.filter((pair) => (pair.similarity >= threshold) === pair.same).length;
    const agreement = correct / scored.length;
    if (agreement > best.agreement) best = { threshold, agreement };
  }

  return best;
}

export async function calibrate(pairs: CalibrationPair[], embed: Embed): Promise<CalibrationResult> {
  const texts = pairs.flatMap((pair) => [pair.a, pair.b]);
  const vectors = await embed(texts);

  const scored: ScoredPair[] = pairs.map((pair, index) => ({
    similarity: cosine(vectors[index * 2], vectors[index * 2 + 1]),
    same: pair.same,
  }));

  return { ...chooseThreshold(scored), scored };
}
