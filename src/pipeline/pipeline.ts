import { runFilter } from './filter.js';
import { runExtract } from './extract.js';
import { runVerify } from './verify.js';
import { runMerge, MergeOptions, MergeResult } from './merge.js';
import { runDeriveTruth } from './derive.js';
import { getKnowledgeItem } from '../store/repository.js';
import { ProjectConfig, KnowledgeAtom } from '../core/types.js';

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
  options: MergeOptions = {}
): Promise<PipelineResult> {
  // 1. Run Filter
  const filterResult = await runFilter(input, config);
  if (!filterResult.pass) {
    return {
      passedFilter: false,
      filterReason: filterResult.reason || 'Input rejected by content filter.',
      extractedCount: 0,
    };
  }

  // 2. Run Extract
  const atoms = await runExtract(input);
  if (atoms.length === 0) {
    return {
      passedFilter: true,
      filterReason: 'Filter passed, but no knowledge atoms were extracted.',
      extractedCount: 0,
    };
  }

  // 3. Run Verify
  const verifiedActions = await runVerify(projectId, atoms);

  // 4. Run Merge
  const mergeResult = await runMerge(projectId, verifiedActions, options);

  // 5. Run Truth Derivation
  const hasAiKey = config.ai.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || config.ai.provider === 'ollama';
  if (hasAiKey && (mergeResult.insertedIds.length > 0 || mergeResult.updatedIds.length > 0)) {
    const ids = [...mergeResult.insertedIds, ...mergeResult.updatedIds];
    const items: any[] = [];
    for (const id of ids) {
      const item = await getKnowledgeItem(id);
      if (item) items.push(item);
    }
    await runDeriveTruth(projectId, items);
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
  const verifiedActions = await runVerify(projectId, [atom]);
  const mergeResult = await runMerge(projectId, verifiedActions, options);

  // Run truth derivation if config/AI is available
  const hasAiKey = config?.ai?.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || config?.ai?.provider === 'ollama';
  if (hasAiKey && (mergeResult.insertedIds.length > 0 || mergeResult.updatedIds.length > 0)) {
    const ids = [...mergeResult.insertedIds, ...mergeResult.updatedIds];
    const items: any[] = [];
    for (const id of ids) {
      const item = await getKnowledgeItem(id);
      if (item) items.push(item);
    }
    await runDeriveTruth(projectId, items);
  }

  return mergeResult;
}

