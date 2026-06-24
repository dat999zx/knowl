import { runFilter } from './filter.js';
import { runExtract } from './extract.js';
import { runVerify } from './verify.js';
import { runMerge, MergeOptions, MergeResult } from './merge.js';
import { ProjectConfig } from '../core/types.js';

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

  return {
    passedFilter: true,
    extractedCount: atoms.length,
    mergeResult,
  };
}
