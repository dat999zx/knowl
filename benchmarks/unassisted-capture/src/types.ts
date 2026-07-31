/** Whether a gold item can be derived from events at all. Headline recall covers `findable`
 *  only -- scoring reasoning-only conclusions against an event-driven method makes the
 *  metric unwinnable and uninformative. */
export type GoldMark = 'findable' | 'thinking-only';

export interface EventPayload {
  agent?: string;
  changedPaths?: string[];
  command?: string;
  exitCode?: number;
  message?: string;
  status?: string;
  summary?: string | null;
  title?: string;
}

export type EventType = 'start' | 'stop' | 'checkpoint' | 'command' | 'error' | 'decision';

export interface CorpusEvent {
  id: string;
  sessionId: string;
  type: EventType;
  payload: EventPayload;
  observedAt: string;
}

export interface CorpusSession {
  sessionId: string;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  events: CorpusEvent[];
}

export interface GoldItem {
  targetId: string;
  canonicalFact: string;
  mark: GoldMark;
}

export interface AnswerKey {
  sessionId: string;
  targets: GoldItem[];
}

export interface PredictedAtom {
  sessionId: string;
  category: string;
  title: string;
  content: string;
}

/** A predicted/gold pairing and the similarity that produced it.
 *  The two texts are carried, not just their indices: the preregistered hand-adjudication step
 *  reads `results.json` after the process is gone, and re-running the model at temperature 0.1
 *  reproduces neither the atoms nor their indices. */
export interface MatchPair {
  sessionId: string;
  targetId: string;
  predictedIndex: number;
  /** The predicted atom exactly as it was embedded and scored. */
  predictedText: string;
  /** The gold `canonicalFact` it was compared against. */
  goldFact: string;
  similarity: number;
}

/** A session whose model call threw. Recorded so a rate-limited run is distinguishable from a
 *  run where the model genuinely found nothing -- the two give identical recall. */
export interface SessionFailure {
  sessionId: string;
  message: string;
}

export interface SessionScore {
  sessionId: string;
  findableTotal: number;
  findableMatched: number;
  thinkingOnlyTotal: number;
  thinkingOnlyMatched: number;
  predictedTotal: number;
  predictedMatched: number;
}

export interface MethodScore {
  method: string;
  recallFindable: number;
  precision: number;
  recallThinkingOnly: number;
  perSession: SessionScore[];
  /** Pairs within the adjudication band, requiring a hand judgment before the score is final. */
  bandPairs: MatchPair[];
  /** Sessions whose model call threw and so contributed no predictions. Non-zero means recall
   *  is a lower bound and the reading is not yet safe to act on. */
  failedSessions: SessionFailure[];
}
