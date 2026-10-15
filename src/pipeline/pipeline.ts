import { runFilter } from './filter.js';
import { runExtract } from './extract.js';
import { runVerify } from './verify.js';
import { runMerge, MergeOptions, MergeResult } from './merge.js';
import { runDeriveTruth } from './derive.js';
import { getKnowledgeItem } from '../store/repository.js';
import { ProjectConfig, KnowledgeAtom, KnowledgeItem } from '../core/types.js';
import { hasAiConfigured } from '../core/config.js';
import { resolveDomainProfile } from '../ai/profiles/index.js';
import type { DomainProfile } from '../ai/profiles/types.js';

export interface PipelineResult {
  passedFilter: boolean;
  filterReason?: string;
  extractedCount: number;
  mergeResult?: MergeResult;
}

export async function runPipeline(
  projectId: string,
  input: string,
  config: ProjectConfig,
  options: MergeOptions = {},
  profile: DomainProfile = resolveDomainProfile(config)
): Promise<PipelineResult> {
  // 1. Run Filter
  const filterResult = await runFilter(input, config, profile);
  if (!filterResult.pass) {
    return {
      passedFilter: false,
      filterReason: filterResult.reason || 'Input rejected by content filter.',
      extractedCount: 0,
    };
  }

  // 2. Run Extract
  const atoms = await runExtract(input, profile);
  if (atoms.length === 0) {
    return {
      passedFilter: true,
      filterReason: 'Filter passed, but no knowledge atoms were extracted.',
      extractedCount: 0,
    };
  }

  // 3. Run Verify
  const verifiedActions = await runVerify(projectId, atoms);

  // 4. Run Merge. Raw ingest is always automatic, whatever the caller passed: see `WriteChannel`.
  const mergeResult = await runMerge(projectId, verifiedActions, { ...options, channel: 'automatic' });

  // 5. Run Truth Derivation
  if (hasAiConfigured(config) && (mergeResult.insertedIds.length > 0 || mergeResult.updatedIds.length > 0)) {
    const ids = [...mergeResult.insertedIds, ...mergeResult.updatedIds];
    const items: KnowledgeItem[] = [];
    for (const id of ids) {
      const item = await getKnowledgeItem(id);
      if (item) items.push(item);
    }
    await runDeriveTruth(projectId, items, undefined, profile);
  }

  return {
    passedFilter: true,
    extractedCount: atoms.length,
    mergeResult,
  };
}

/**
 * Directly runs the verify and merge pipeline for a single pre-extracted knowledge atom.
 * Used by direct input interfaces like CLI decide and MCP decide.
 */
export async function runDecisionPipeline(
  projectId: string,
  atom: KnowledgeAtom,
  options: MergeOptions = {},
  config?: ProjectConfig
): Promise<MergeResult> {
  // Resolved first: an invalid ai.profile must fail before the model call and the write, not after.
  const profile = hasAiConfigured(config) ? resolveDomainProfile(config) : undefined;
  const verifiedActions = await runVerify(projectId, [atom]);
  const mergeResult = await runMerge(projectId, verifiedActions, options);

  // Run truth derivation if config/AI is available
  if (hasAiConfigured(config) && (mergeResult.insertedIds.length > 0 || mergeResult.updatedIds.length > 0)) {
    const ids = [...mergeResult.insertedIds, ...mergeResult.updatedIds];
    const items: KnowledgeItem[] = [];
    for (const id of ids) {
      const item = await getKnowledgeItem(id);
      if (item) items.push(item);
    }
    await runDeriveTruth(projectId, items, undefined, profile);
  }

  return mergeResult;
}

