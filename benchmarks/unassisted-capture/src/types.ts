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
  exclusions: string[];
}

export interface PredictedAtom {
  sessionId: string;
  category: string;
  title: string;
  content: string;
}

/** A predicted/gold pairing and the similarity that produced it. */
export interface MatchPair {
  sessionId: string;
  targetId: string;
  predictedIndex: number;
  similarity: number;
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
}
