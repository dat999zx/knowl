import { extractKnowledge } from '../ai/provider.js';
import { KnowledgeAtom } from '../core/types.js';

export async function runExtract(input: string): Promise<KnowledgeAtom[]> {
  return await extractKnowledge(input);
}
