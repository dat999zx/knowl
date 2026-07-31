import type { MethodScore } from './types.js';

/** Preregistered in docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md.
 *  Never tune these after seeing a result. */
export const JUNK_LIMIT = 0.8;
export const STAGE1_RECALL_GATE = 0.3;

export interface Stage1Reading {
  proceed: boolean;
  disqualified: boolean;
  verdict: string;
}

export function readStage1(score: MethodScore): Stage1Reading {
  if (score.precision < JUNK_LIMIT) {
    return {
      proceed: false,
      disqualified: true,
      verdict: `Disqualified: precision ${score.precision.toFixed(2)} is below the ${JUNK_LIMIT} junk limit. Recall is not considered.`,
    };
  }
  if (score.recallFindable < STAGE1_RECALL_GATE) {
    return {
      proceed: false,
      disqualified: false,
      verdict: `Stop. Recall ${score.recallFindable.toFixed(2)} is below the ${STAGE1_RECALL_GATE} gate: the events do not carry recoverable knowledge. Do not build the rules -- the payload is the constraint. Escalate method 3 and the retention work.`,
    };
  }
  return {
    proceed: true,
    disqualified: false,
    verdict: `Proceed to stage 2. Recall ${score.recallFindable.toFixed(2)} clears the ${STAGE1_RECALL_GATE} gate at precision ${score.precision.toFixed(2)}.`,
  };
}

export function renderReport(score: MethodScore, reading: Stage1Reading): string {
  const sessionsWithGold = score.perSession.filter((row) => row.findableTotal > 0);
  const perSessionRecall = sessionsWithGold.map((row) => row.findableMatched / row.findableTotal);
  const spread = perSessionRecall.length
    ? `${Math.min(...perSessionRecall).toFixed(2)} - ${Math.max(...perSessionRecall).toFixed(2)}`
    : 'n/a';

  return [
    `Method: ${score.method}`,
    '',
    `  Recall (findable)      ${score.recallFindable.toFixed(2)}`,
    `  Precision              ${score.precision.toFixed(2)}`,
    `  Recall (thinking-only) ${score.recallThinkingOnly.toFixed(2)}   <- ceiling hooks cannot cross, reported separately`,
    '',
    `  Sessions scored        ${score.perSession.length}`,
    `  Per-session recall     ${spread}`,
    `  Adjudication           ${score.bandPairs.length} pair(s) within the band, hand judgment required before this score is final`,
    '',
    reading.verdict,
  ].join('\n');
}
