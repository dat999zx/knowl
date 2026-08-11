import { z } from 'zod';

/**
 * Checks that run before a paid run spends anything. They live here rather than in `cli.ts`
 * because `cli.ts` reads `process.argv` and calls `process.exit` at module scope, so it cannot
 * be imported from a test.
 */

/** The frozen threshold is as preregistered as the two gates. A bare cast would let `{}` through
 *  and make every `similarity >= undefined` false, reporting precision 0 and recall 0 in the same
 *  confident words as a real disqualification. NaN behaves identically. */
export const FrozenThresholdSchema = z.object({
  threshold: z.number().finite().min(0).max(1),
  agreement: z.number().finite().min(0).max(1),
  pairs: z.number().int().nonnegative(),
  frozenAt: z.string().min(1),
  /** Absent in a threshold frozen before this field existed. */
  pairsSha256: z.string().min(1).optional(),
});

export type FrozenThreshold = z.infer<typeof FrozenThresholdSchema>;

export function parseFrozenThreshold(raw: string, file: string): FrozenThreshold {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }

  const parsed = FrozenThresholdSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
    throw new Error(
      `${file} is not a valid frozen threshold: ${issues}. Re-run calibrate rather than scoring against an unusable threshold.`,
    );
  }
  return parsed.data;
}

/** Every gold line must name a real corpus session. `gold.ndjson` is hand-written; a typo'd id is
 *  never sent to the model yet still counts its targets in `findableTotal`, quietly lowering the
 *  one number the architecture decision turns on -- against a gate of 0.30. */
export function assertAnswerKeyResolves(answerKeySessionIds: string[], corpusSessionIds: Iterable<string>): void {
  const known = new Set(corpusSessionIds);
  const unmatched = answerKeySessionIds.filter((id) => !known.has(id));
  if (unmatched.length > 0) {
    throw new Error(
      `Answer key names ${unmatched.length} session id(s) that are not in the corpus: ${unmatched.join(', ')}. ` +
        'Fix the answer key before running -- an unmatched id still counts toward recall while never reaching the model.',
    );
  }
}
