import { extractKnowledge } from '../ai/provider.js';
import { KnowledgeAtom } from '../core/types.js';
import type { DomainProfile } from '../ai/profiles/types.js';

export async function runExtract(input: string, profile?: DomainProfile): Promise<KnowledgeAtom[]> {
  return await extractKnowledge(input, profile);
}
