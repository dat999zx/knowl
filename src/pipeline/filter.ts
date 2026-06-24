import { filterInput } from '../ai/provider.js';
import { ProjectConfig, FilterResult } from '../core/types.js';

export async function runFilter(input: string, config: ProjectConfig): Promise<FilterResult> {
  return await filterInput(input, config);
}
