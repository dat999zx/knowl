import { filterInput } from '../ai/provider.js';
import { ProjectConfig, FilterResult } from '../core/types.js';
import { KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';

export async function runFilter(input: string, config: ProjectConfig): Promise<FilterResult> {
  try {
    validateKnowledgeWrite({ rawOutput: input }, config.security);
  } catch (error) {
    if (error instanceof KnowledgeValidationError) {
      return { pass: false, reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
  return await filterInput(input, config);
}
