import type { Embed } from './calibrate.js';
import { cosine, inBand, maxCardinalityMatch } from './matcher.js';
import type { AnswerKey, MatchPair, MethodScore, PredictedAtom, SessionFailure, SessionScore } from './types.js';

export interface ScoreInput {
  method: string;
  answerKey: AnswerKey[];
  predictions: PredictedAtom[];
  threshold: number;
  embed: Embed;
  /** Sessions the method could not be run on at all (rate limits, transport errors). Carried
   *  through to the score so a depressed recall can be read as incomplete rather than real. */
  failedSessions?: SessionFailure[];
}

export async function scoreMethod(input: ScoreInput): Promise<MethodScore> {
  const { method, answerKey, predictions, threshold, embed } = input;
  const failedSessions = input.failedSessions ?? [];

  const perSession: SessionScore[] = [];
  const bandPairs: MatchPair[] = [];

  for (const key of answerKey) {
    const sessionPredictions = predictions.filter((p) => p.sessionId === key.sessionId);
    const goldTexts = key.targets.map((target) => target.canonicalFact);
    const predictionTexts = sessionPredictions.map((p) => `${p.title} ${p.content}`.trim());

    const empty: SessionScore = {
      sessionId: key.sessionId,
      findableTotal: key.targets.filter((t) => t.mark === 'findable').length,
      findableMatched: 0,
      thinkingOnlyTotal: key.targets.filter((t) => t.mark === 'thinking-only').length,
      thinkingOnlyMatched: 0,
      predictedTotal: sessionPredictions.length,
      predictedMatched: 0,
    };

    if (goldTexts.length === 0 || predictionTexts.length === 0) {
      perSession.push(empty);
      continue;
    }

    const vectors = await embed([...goldTexts, ...predictionTexts]);
    const goldVectors = vectors.slice(0, goldTexts.length);
    const predictionVectors = vectors.slice(goldTexts.length);

    // edges[prediction][gold] -- predictions are the left side so an unmatched prediction is
    // directly visible as a precision miss.
    const edges: boolean[][] = [];
    for (let p = 0; p < predictionVectors.length; p++) {
      edges[p] = [];
      for (let g = 0; g < goldVectors.length; g++) {
        const similarity = cosine(predictionVectors[p], goldVectors[g]);
        edges[p][g] = similarity >= threshold;
        if (inBand(similarity, threshold)) {
          bandPairs.push({
            sessionId: key.sessionId,
            targetId: key.targets[g].targetId,
            predictedIndex: p,
            predictedText: predictionTexts[p],
            goldFact: goldTexts[g],
            similarity,
          });
        }
      }
    }

    const matchedGold = maxCardinalityMatch(edges, predictionVectors.length, goldVectors.length);

    let findableMatched = 0;
    let thinkingOnlyMatched = 0;
    let predictedMatched = 0;
    for (let g = 0; g < matchedGold.length; g++) {
      if (matchedGold[g] === -1) continue;
      predictedMatched++;
      if (key.targets[g].mark === 'findable') findableMatched++;
      else thinkingOnlyMatched++;
    }

    perSession.push({ ...empty, findableMatched, thinkingOnlyMatched, predictedMatched });
  }

  // Micro-averaged: totals are pooled across sessions before dividing, so one gold item counts
  // the same wherever it lives. A per-session mean would let a session with a single target
  // outweigh a session with ten.
  const sum = (pick: (row: SessionScore) => number) => perSession.reduce((total, row) => total + pick(row), 0);
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator);

  return {
    method,
    recallFindable: ratio(sum((r) => r.findableMatched), sum((r) => r.findableTotal)),
    recallThinkingOnly: ratio(sum((r) => r.thinkingOnlyMatched), sum((r) => r.thinkingOnlyTotal)),
    precision: ratio(sum((r) => r.predictedMatched), sum((r) => r.predictedTotal)),
    perSession,
    bandPairs,
    failedSessions,
  };
}
