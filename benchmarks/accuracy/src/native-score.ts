import type { ModeCapabilities } from './protocol.js';
import type { CaptureGold, NativeHistory } from './schema.js';
import type { NativeCapturePrediction } from './native-collect.js';
import type { MetricValue } from './score.js';

export type NativeCaptureMetrics = {
  capturePrecision: MetricValue;
  captureRecall: MetricValue;
  captureF1: MetricValue;
  falsePromotionRate: MetricValue;
  duplicatePromotionRate: MetricValue;
  secretLeakRate: MetricValue;
  provenanceCoverage: MetricValue;
  evidenceCoverage: MetricValue;
  interruptedSessionRecovery: MetricValue;
  idempotencyAccuracy: MetricValue;
};

export type NativeCaptureMatch = {
  memoryId: string;
  targetId: string;
};

export type NativeHistoryScore = {
  historyId: string;
  promotedMemories: number;
  targetCount: number;
  matchedMemories: number;
  matchedTargets: number;
  falsePromotions: number;
  duplicatePromotions: number;
  secretLeaks: number;
  secretSourcesTotal: number;
  attributedMemories: number;
  coveredEvidenceSources: number;
  evidenceSourcesTotal: number;
  interruptedTargets: number;
  interruptedTargetsRecovered: number;
  duplicateInputs: number;
  duplicateInputsRetained: number;
  matches: NativeCaptureMatch[];
  missingOutput: boolean;
  error?: string;
};

export type NativeCaptureFailure = {
  historyId: string;
  reason: string;
};

export type NativeCaptureScore = {
  metrics: NativeCaptureMetrics;
  perHistory: NativeHistoryScore[];
  failures: NativeCaptureFailure[];
  naReason?: string;
};

type Memory = NonNullable<NativeCapturePrediction['memories']>[number];
type Target = CaptureGold['targets'][number];

function metric(numerator: number, denominator: number): MetricValue {
  return { value: denominator ? numerator / denominator : null, numerator, denominator };
}

function blankMetrics(): NativeCaptureMetrics {
  const na = (): MetricValue => ({ value: null, numerator: 0, denominator: 0 });
  return {
    capturePrecision: na(),
    captureRecall: na(),
    captureF1: na(),
    falsePromotionRate: na(),
    duplicatePromotionRate: na(),
    secretLeakRate: na(),
    provenanceCoverage: na(),
    evidenceCoverage: na(),
    interruptedSessionRecovery: na(),
    idempotencyAccuracy: na(),
  };
}

function sources(memory: Memory): Set<string> {
  return new Set(memory.sourceIds ?? []);
}

function overlaps(memorySources: Set<string>, target: Target): boolean {
  return target.evidenceSourceIds.some(sourceId => memorySources.has(sourceId));
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizedText(value).split(/\s+/u).filter(Boolean));
}

function contentMatches(memory: Memory, target: Target): boolean {
  const memoryText = normalizedText(memory.text);
  const targetText = normalizedText(target.canonicalFact);
  if (!memoryText || !targetText) return false;
  if (memoryText.includes(targetText) || targetText.includes(memoryText)) return true;
  const memoryTokens = tokenSet(memory.text);
  const targetTokens = tokenSet(target.canonicalFact);
  const overlapCount = [...memoryTokens].filter(token => targetTokens.has(token)).length;
  const denominator = memoryTokens.size + targetTokens.size;
  return denominator > 0 && (2 * overlapCount) / denominator >= 0.75;
}

function maximumSourceMatching(memories: Memory[], targets: Target[]): Map<number, number> {
  const memorySources = memories.map(sources);
  const edges = memories.map((_, memoryIndex) => targets
    .map((target, targetIndex) => (
      overlaps(memorySources[memoryIndex], target) && contentMatches(memories[memoryIndex], target)
        ? targetIndex
        : -1
    ))
    .filter(targetIndex => targetIndex >= 0));
  const targetToMemory = new Map<number, number>();

  const assign = (memoryIndex: number, visitedTargets: Set<number>): boolean => {
    for (const targetIndex of edges[memoryIndex]) {
      if (visitedTargets.has(targetIndex)) continue;
      visitedTargets.add(targetIndex);
      const currentMemory = targetToMemory.get(targetIndex);
      if (currentMemory === undefined || assign(currentMemory, visitedTargets)) {
        targetToMemory.set(targetIndex, memoryIndex);
        return true;
      }
    }
    return false;
  };

  for (let memoryIndex = 0; memoryIndex < memories.length; memoryIndex += 1) {
    assign(memoryIndex, new Set());
  }

  return new Map([...targetToMemory].map(([targetIndex, memoryIndex]) => [memoryIndex, targetIndex]));
}

function duplicateMemoryIndexes(
  memories: Memory[],
  targets: Target[],
  matchedMemoryIndexes: Set<number>,
  duplicateExclusionSources: Set<string>,
): Set<number> {
  const duplicates = new Set<number>();
  const firstMemoryById = new Map<string, number>();
  const seenSources = new Set<string>();

  memories.forEach((memory, memoryIndex) => {
    if (firstMemoryById.has(memory.memoryId)) duplicates.add(memoryIndex);
    else firstMemoryById.set(memory.memoryId, memoryIndex);

    const memorySources = sources(memory);
    if ([...memorySources].some(sourceId => duplicateExclusionSources.has(sourceId))) {
      duplicates.add(memoryIndex);
    }
    if ([...memorySources].some(sourceId => seenSources.has(sourceId))) {
      duplicates.add(memoryIndex);
    }
    for (const sourceId of memorySources) seenSources.add(sourceId);

    if (!matchedMemoryIndexes.has(memoryIndex) && targets.some(target => overlaps(memorySources, target))) {
      duplicates.add(memoryIndex);
    }
  });

  return duplicates;
}

export function scoreNativeCapture(
  histories: NativeHistory[],
  goldRows: CaptureGold[],
  predictions: NativeCapturePrediction[],
  capabilities: ModeCapabilities,
): NativeCaptureScore {
  if (!capabilities.supported) {
    return {
      metrics: blankMetrics(),
      perHistory: [],
      failures: [],
      naReason: capabilities.reason ?? 'native mode is unsupported',
    };
  }
  if (!capabilities.memoryInventory) {
    return {
      metrics: blankMetrics(),
      perHistory: [],
      failures: [],
      naReason: 'adapter does not expose a memory inventory',
    };
  }
  if (!capabilities.sourceProvenance) {
    return {
      metrics: blankMetrics(),
      perHistory: [],
      failures: [],
      naReason: 'adapter does not expose source provenance',
    };
  }

  const goldByHistory = new Map<string, CaptureGold>();
  for (const row of goldRows) {
    if (goldByHistory.has(row.historyId)) throw new Error(`Duplicate evaluator gold for ${row.historyId}.`);
    goldByHistory.set(row.historyId, row);
  }
  const predictionByHistory = new Map<string, NativeCapturePrediction>();
  for (const prediction of predictions) {
    if (predictionByHistory.has(prediction.historyId)) {
      throw new Error(`Duplicate native prediction for ${prediction.historyId}.`);
    }
    predictionByHistory.set(prediction.historyId, prediction);
  }
  const historyById = new Map(histories.map(history => [history.historyId, history]));
  for (const prediction of predictions) {
    if (!goldByHistory.has(prediction.historyId)) {
      throw new Error(`Native prediction references unknown history ${prediction.historyId}.`);
    }
  }

  const perHistory: NativeHistoryScore[] = [];
  const failures: NativeCaptureFailure[] = [];

  for (const gold of goldRows) {
    const history = historyById.get(gold.historyId);
    if (!history) throw new Error(`Missing public native history for ${gold.historyId}.`);
    const sourceContent = new Map(history.sessions.flatMap(session => session.events.map(event => [event.sourceId, event.content] as const)));
    const interruptedSources = new Set(history.sessions
      .filter(session => session.termination === 'interrupted')
      .flatMap(session => session.events.map(event => event.sourceId)));
    const prediction = predictionByHistory.get(gold.historyId);
    const error = prediction?.error
      ?? (!prediction || prediction.memories === undefined ? 'missing prediction' : undefined);
    const memories = error ? [] : (prediction?.memories ?? []);
    const matching = maximumSourceMatching(memories, gold.targets);
    const matchedMemoryIndexes = new Set(matching.keys());
    const falsePromotions = memories.length - matchedMemoryIndexes.size;
    const duplicateExclusionSources = new Set(gold.exclusions
      .filter(exclusion => exclusion.reason === 'duplicate')
      .map(exclusion => exclusion.sourceId));
    const secretSources = new Set(gold.exclusions
      .filter(exclusion => exclusion.reason === 'secret')
      .map(exclusion => exclusion.sourceId));
    const duplicatePromotions = duplicateMemoryIndexes(
      memories,
      gold.targets,
      matchedMemoryIndexes,
      duplicateExclusionSources,
    ).size;
    const memoryIndicatesSource = (memory: Memory, sourceId: string): boolean => {
      if (sources(memory).has(sourceId)) return true;
      const sourceText = normalizedText(sourceContent.get(sourceId) ?? '');
      return Boolean(sourceText) && normalizedText(memory.text).includes(sourceText);
    };
    const leakedSecretSources = new Set([...secretSources].filter(sourceId => memories.some(memory => memoryIndicatesSource(memory, sourceId))));
    const duplicateInputSources = new Set(gold.exclusions
      .filter(exclusion => exclusion.reason === 'duplicate')
      .map(exclusion => exclusion.sourceId));
    const retainedDuplicateSources = new Set([...duplicateInputSources]
      .filter(sourceId => memories.some(memory => memoryIndicatesSource(memory, sourceId))));
    const attributedMemories = memories.filter(memory => (memory.sourceIds?.length ?? 0) > 0).length;
    const evidenceSourceIds = new Set(gold.targets.flatMap(target => target.evidenceSourceIds));
    const correctlyCitedSourceIds = new Set<string>();
    for (const [memoryIndex, targetIndex] of matching) {
      const targetSources = new Set(gold.targets[targetIndex].evidenceSourceIds);
      for (const sourceId of memories[memoryIndex].sourceIds ?? []) {
        if (targetSources.has(sourceId)) correctlyCitedSourceIds.add(sourceId);
      }
    }
    const coveredEvidenceSources = [...evidenceSourceIds].filter(sourceId => correctlyCitedSourceIds.has(sourceId)).length;
    const interruptedTargetIndexes = new Set(gold.targets
      .map((target, index) => target.evidenceSourceIds.some(sourceId => interruptedSources.has(sourceId)) ? index : -1)
      .filter(index => index >= 0));
    const matchedTargetIndexes = new Set(matching.values());
    const interruptedTargetsRecovered = [...interruptedTargetIndexes]
      .filter(index => matchedTargetIndexes.has(index)).length;
    const matches = [...matching]
      .sort(([left], [right]) => left - right)
      .map(([memoryIndex, targetIndex]) => ({
        memoryId: memories[memoryIndex].memoryId,
        targetId: gold.targets[targetIndex].targetId,
      }));

    if (error) failures.push({ historyId: gold.historyId, reason: error });
    perHistory.push({
      historyId: gold.historyId,
      promotedMemories: memories.length,
      targetCount: gold.targets.length,
      matchedMemories: matching.size,
      matchedTargets: matching.size,
      falsePromotions,
      duplicatePromotions,
      secretLeaks: leakedSecretSources.size,
      secretSourcesTotal: secretSources.size,
      attributedMemories,
      coveredEvidenceSources,
      evidenceSourcesTotal: evidenceSourceIds.size,
      interruptedTargets: interruptedTargetIndexes.size,
      interruptedTargetsRecovered,
      duplicateInputs: duplicateInputSources.size,
      duplicateInputsRetained: retainedDuplicateSources.size,
      matches,
      missingOutput: Boolean(error),
      ...(error ? { error } : {}),
    });
  }

  const promoted = perHistory.reduce((sum, row) => sum + row.promotedMemories, 0);
  const targets = perHistory.reduce((sum, row) => sum + row.targetCount, 0);
  const matched = perHistory.reduce((sum, row) => sum + row.matchedTargets, 0);
  const falsePromotions = perHistory.reduce((sum, row) => sum + row.falsePromotions, 0);
  const missedTargets = targets - matched;
  const metrics: NativeCaptureMetrics = {
    capturePrecision: metric(matched, promoted),
    captureRecall: metric(matched, targets),
    captureF1: metric(2 * matched, (2 * matched) + falsePromotions + missedTargets),
    falsePromotionRate: metric(falsePromotions, promoted),
    duplicatePromotionRate: metric(
      perHistory.reduce((sum, row) => sum + row.duplicatePromotions, 0),
      promoted,
    ),
    secretLeakRate: metric(
      perHistory.reduce((sum, row) => sum + row.secretLeaks, 0),
      perHistory.reduce((sum, row) => sum + row.secretSourcesTotal, 0),
    ),
    provenanceCoverage: metric(
      perHistory.reduce((sum, row) => sum + row.attributedMemories, 0),
      promoted,
    ),
    evidenceCoverage: metric(
      perHistory.reduce((sum, row) => sum + row.coveredEvidenceSources, 0),
      perHistory.reduce((sum, row) => sum + row.evidenceSourcesTotal, 0),
    ),
    interruptedSessionRecovery: metric(
      perHistory.reduce((sum, row) => sum + row.interruptedTargetsRecovered, 0),
      perHistory.reduce((sum, row) => sum + row.interruptedTargets, 0),
    ),
    idempotencyAccuracy: metric(
      perHistory.reduce((sum, row) => sum + row.duplicateInputs - row.duplicateInputsRetained, 0),
      perHistory.reduce((sum, row) => sum + row.duplicateInputs, 0),
    ),
  };

  return { metrics, perHistory, failures };
}
