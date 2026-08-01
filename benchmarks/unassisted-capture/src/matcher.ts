/** Half-width of the hand-adjudication band around the frozen threshold. */
export const DEFAULT_BAND = 0.1;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function inBand(similarity: number, threshold: number, band: number = DEFAULT_BAND): boolean {
  return Math.abs(similarity - threshold) <= band;
}

/**
 * Kuhn's algorithm for maximum bipartite matching. `edges[left][right]` is true when the
 * pair is above threshold. Returns, per right index, the matched left index or -1.
 */
export function maxCardinalityMatch(edges: boolean[][], leftCount: number, rightCount: number): number[] {
  const matchRight = new Array<number>(rightCount).fill(-1);

  const tryAssign = (left: number, seen: boolean[]): boolean => {
    for (let right = 0; right < rightCount; right++) {
      if (!edges[left]?.[right] || seen[right]) continue;
      seen[right] = true;
      if (matchRight[right] === -1 || tryAssign(matchRight[right], seen)) {
        matchRight[right] = left;
        return true;
      }
    }
    return false;
  };

  for (let left = 0; left < leftCount; left++) {
    tryAssign(left, new Array<boolean>(rightCount).fill(false));
  }

  return matchRight;
}
