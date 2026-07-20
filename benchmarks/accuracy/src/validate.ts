import {
  BenchmarkManifestSchema,
  CaptureGoldSchema,
  NativeHistorySchema,
  NormalizedRecordSchema,
  PublicQuerySchema,
  QuestionGoldSchema,
  type BenchmarkBundle,
} from './schema.js';

export type BenchmarkValidationSummary = {
  projectCount: number;
  historyCount: number;
  sessionCount: number;
  questionCount: number;
  questionsPerProject: number[];
  categories: string[];
};

const PUBLIC_FORBIDDEN_KEYS = new Set([
  'acceptedText', 'answer', 'canonical', 'disposition', 'expected', 'grade',
  'harmful', 'judgments', 'relevance', 'shouldAbstain', 'shouldPromote',
]);

function assertUnique(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
    seen.add(id);
  }
}

function assertNoGoldKeys(value: unknown, path = 'public'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoGoldKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (PUBLIC_FORBIDDEN_KEYS.has(key)) throw new Error(`Evaluator-owned field ${key} leaked into ${path}.`);
    assertNoGoldKeys(entry, `${path}.${key}`);
  }
}

export function validateBenchmarkBundle(
  bundle: BenchmarkBundle,
  options: { release?: boolean } = {},
): BenchmarkValidationSummary {
  BenchmarkManifestSchema.parse(bundle.manifest);
  bundle.normalizedRecords.forEach(record => NormalizedRecordSchema.parse(record));
  bundle.nativeHistories.forEach(history => NativeHistorySchema.parse(history));
  bundle.queries.forEach(query => PublicQuerySchema.parse(query));
  bundle.questionGold.forEach(gold => QuestionGoldSchema.parse(gold));
  bundle.captureGold.forEach(gold => CaptureGoldSchema.parse(gold));
  assertNoGoldKeys({ records: bundle.normalizedRecords, histories: bundle.nativeHistories, queries: bundle.queries });

  const recordIds = bundle.normalizedRecords.map(record => record.sourceId);
  const historyIds = bundle.nativeHistories.map(history => history.historyId);
  const sessionIds = bundle.nativeHistories.flatMap(history => history.sessions.map(session => session.sessionId));
  const nativeEventIds = bundle.nativeHistories.flatMap(history => history.sessions.flatMap(session => session.events.map(event => event.sourceId)));
  const questionIds = bundle.queries.map(query => query.questionId);
  assertUnique(recordIds, 'record');
  assertUnique(historyIds, 'history');
  assertUnique(sessionIds, 'session');
  assertUnique(nativeEventIds, 'native event');
  assertUnique(questionIds, 'question');
  assertUnique(bundle.questionGold.map(gold => gold.questionId), 'question gold');
  assertUnique(bundle.captureGold.map(gold => gold.historyId), 'capture gold');

  const records = new Map(bundle.normalizedRecords.map(record => [record.sourceId, record]));
  const histories = new Map(bundle.nativeHistories.map(history => [history.historyId, history]));
  const queries = new Map(bundle.queries.map(query => [query.questionId, query]));
  const questionGold = new Map(bundle.questionGold.map(gold => [gold.questionId, gold]));
  const captureGold = new Map(bundle.captureGold.map(gold => [gold.historyId, gold]));
  const nativeEvents = new Set(nativeEventIds);
  const sessionHistory = new Map(bundle.nativeHistories.flatMap(history => history.sessions
    .map(session => [session.sessionId, history.historyId] as const)));
  const eventHistory = new Map(bundle.nativeHistories.flatMap(history => history.sessions
    .flatMap(session => session.events.map(event => [event.sourceId, history.historyId] as const))));

  for (const record of bundle.normalizedRecords) {
    const history = histories.get(record.historyId);
    if (!history) throw new Error(`Record ${record.sourceId} references unknown history ${record.historyId}.`);
    if (history.projectId !== record.projectId) throw new Error(`Record ${record.sourceId} project does not match its history.`);
    if (sessionHistory.get(record.sessionId) !== record.historyId) {
      throw new Error(`Record ${record.sourceId} session does not belong to its history.`);
    }
    if (!nativeEvents.has(record.sourceId)) throw new Error(`Normalized source ${record.sourceId} has no matching native event.`);
    if (eventHistory.get(record.sourceId) !== record.historyId) {
      throw new Error(`Normalized source ${record.sourceId} native event belongs to another history.`);
    }
    const relationIds = [
      ...(record.relations?.supersedes ?? []),
      ...(record.relations?.contradicts ?? []),
      ...(record.relations?.resolves ?? []),
    ];
    for (const relatedId of relationIds) {
      const related = records.get(relatedId);
      if (!related) throw new Error(`Record ${record.sourceId} references unknown source ${relatedId}.`);
      if (related.projectId !== record.projectId) throw new Error(`Record ${record.sourceId} has a cross-project relation to ${relatedId}.`);
      if (Date.parse(related.occurredAt) >= Date.parse(record.occurredAt)) {
        throw new Error(`Record ${record.sourceId} relation must point backward in time to ${relatedId}.`);
      }
    }
  }

  for (const history of bundle.nativeHistories) {
    const times = history.sessions.map(session => Date.parse(session.startedAt));
    if (times.some((time, index) => index > 0 && time <= times[index - 1])) {
      throw new Error(`History ${history.historyId} session timestamps are not strictly increasing.`);
    }
    if (!captureGold.has(history.historyId)) throw new Error(`History ${history.historyId} has no capture gold.`);
  }

  for (const query of bundle.queries) {
    const history = histories.get(query.historyId);
    if (!history) throw new Error(`Question ${query.questionId} references unknown history ${query.historyId}.`);
    if (history.projectId !== query.projectId) throw new Error(`Question ${query.questionId} project does not match its history.`);
    const gold = questionGold.get(query.questionId);
    if (!gold) throw new Error(`Question ${query.questionId} has no evaluator gold.`);
    const positive = new Set(gold.judgments.map(judgment => judgment.sourceId));
    const harmful = new Set(gold.harmful.map(item => item.sourceId));
    for (const judgment of gold.judgments) {
      const record = records.get(judgment.sourceId);
      if (!record) throw new Error(`Question ${query.questionId} references unknown source ${judgment.sourceId}.`);
      if (record.projectId !== query.projectId) throw new Error(`Question ${query.questionId} has cross-project positive evidence ${judgment.sourceId}.`);
      if (harmful.has(judgment.sourceId)) throw new Error(`Question ${query.questionId} marks ${judgment.sourceId} as positive and harmful.`);
    }
    for (const item of gold.harmful) {
      if (!records.has(item.sourceId)) throw new Error(`Question ${query.questionId} references unknown source ${item.sourceId}.`);
    }
    for (const group of gold.requiredEvidenceGroups) {
      for (const id of group) {
        if (!positive.has(id)) throw new Error(`Question ${query.questionId} evidence group references non-positive source ${id}.`);
      }
    }
    if (gold.shouldAbstain && (gold.judgments.length || gold.requiredEvidenceGroups.length)) {
      throw new Error(`Abstention question ${query.questionId} cannot contain positive evidence.`);
    }
    if (!gold.shouldAbstain && !gold.judgments.some(judgment => judgment.grade === 3)) {
      throw new Error(`Question ${query.questionId} has no grade-3 answer evidence.`);
    }
  }

  for (const gold of bundle.captureGold) {
    if (!histories.has(gold.historyId)) throw new Error(`Capture gold references unknown history ${gold.historyId}.`);
    const seenTargets = new Set<string>();
    for (const target of gold.targets) {
      if (seenTargets.has(target.targetId)) throw new Error(`Duplicate capture target ${target.targetId}.`);
      seenTargets.add(target.targetId);
      for (const id of target.evidenceSourceIds) {
        if (!nativeEvents.has(id)) throw new Error(`Capture target ${target.targetId} references unknown source ${id}.`);
        if (eventHistory.get(id) !== gold.historyId) throw new Error(`Capture target ${target.targetId} references another history.`);
      }
    }
    for (const exclusion of gold.exclusions) {
      if (!nativeEvents.has(exclusion.sourceId)) throw new Error(`Capture exclusion references unknown source ${exclusion.sourceId}.`);
      if (eventHistory.get(exclusion.sourceId) !== gold.historyId) throw new Error(`Capture exclusion references another history.`);
    }
  }

  if (questionGold.size !== queries.size) throw new Error('Question and question-gold counts differ.');
  if (captureGold.size !== histories.size) throw new Error('History and capture-gold counts differ.');

  const projects = [...new Set(bundle.nativeHistories.map(history => history.projectId))].sort();
  const questionsPerProject = projects.map(projectId => bundle.queries.filter(query => query.projectId === projectId).length);
  const categories = [...new Set(bundle.questionGold.map(gold => gold.category))].sort();
  const summary: BenchmarkValidationSummary = {
    projectCount: projects.length,
    historyCount: bundle.nativeHistories.length,
    sessionCount: sessionIds.length,
    questionCount: bundle.queries.length,
    questionsPerProject,
    categories,
  };

  if (options.release) {
    if (summary.projectCount !== 5) throw new Error(`Release corpus requires exactly 5 projects; found ${summary.projectCount}.`);
    if (summary.historyCount !== 100) throw new Error(`Release corpus requires exactly 100 histories; found ${summary.historyCount}.`);
    if (summary.sessionCount !== 400) throw new Error(`Release corpus requires exactly 400 sessions; found ${summary.sessionCount}.`);
    if (summary.questionCount !== 200) throw new Error(`Release corpus requires exactly 200 questions; found ${summary.questionCount}.`);
    if (bundle.nativeHistories.some(history => history.sessions.length !== 4)) {
      throw new Error('Release corpus requires exactly 4 sessions per history.');
    }
    if (projects.some(projectId => bundle.nativeHistories.filter(history => history.projectId === projectId).length !== 20)) {
      throw new Error('Release corpus requires exactly 20 histories per project.');
    }
    if (questionsPerProject.some(count => count !== 40)) throw new Error('Release corpus requires exactly 40 questions per project.');
    if (categories.length !== 12) throw new Error(`Release corpus requires all 12 categories; found ${categories.length}.`);
    for (const projectId of projects) {
      const projectQuestionIds = new Set(bundle.queries.filter(query => query.projectId === projectId).map(query => query.questionId));
      const projectCategories = new Set(bundle.questionGold.filter(gold => projectQuestionIds.has(gold.questionId)).map(gold => gold.category));
      if (projectCategories.size !== 12) throw new Error(`Project ${projectId} does not cover all 12 categories.`);
    }
  }

  if (bundle.manifest.counts.projects !== summary.projectCount
    || bundle.manifest.counts.histories !== summary.historyCount
    || bundle.manifest.counts.sessions !== summary.sessionCount
    || bundle.manifest.counts.questions !== summary.questionCount) {
    throw new Error('Manifest counts do not match generated content.');
  }

  return summary;
}
