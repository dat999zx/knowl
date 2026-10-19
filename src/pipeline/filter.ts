import { filterInput } from '../ai/provider.js';
import { ProjectConfig, FilterResult } from '../core/types.js';
import { KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';
import type { DomainProfile } from '../ai/profiles/types.js';

export async function runFilter(input: string, config: ProjectConfig, profile?: DomainProfile): Promise<FilterResult> {
  try {
    validateKnowledgeWrite({ rawOutput: input }, config.security);
  } catch (error) {
    if (error instanceof KnowledgeValidationError) {
      return { pass: false, reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
  return await filterInput(input, config, profile);
}
