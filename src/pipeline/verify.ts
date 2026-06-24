import { queryKnowledgeBase } from '../store/queries.js';
import { compareKnowledge } from '../ai/provider.js';
import { KnowledgeAtom, KnowledgeItem, KnowledgeCategory } from '../core/types.js';

export interface VerifiedAtomAction {
  atom: KnowledgeAtom;
  action: 'insert' | 'update' | 'contradiction' | 'duplicate';
  existingItemId?: string;
  compareResult?: {
    relationship: 'duplicate' | 'update' | 'contradiction' | 'unrelated';
    reason: string;
    updatedContent?: string;
    updatedTitle?: string;
    updatedReasoning?: string;
    updatedAlternatives?: string[];
    updatedTags?: string[];
    updatedSteps?: string[];
  };
}

/**
 * Calculates a simple Jaccard similarity score between two strings (titles).
 */
function getTitleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/[^a-zA-Z0-9]+/));
  const wordsB = new Set(b.toLowerCase().split(/[^a-zA-Z0-9]+/));
  
  // Remove common stop words
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'to', 'for', 'in', 'on', 'at', 'by', 'use', 'using', 'we', 'decide', 'decision', 'our', 'project']);
  for (const w of stopWords) {
    wordsA.delete(w);
    wordsB.delete(w);
  }

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter(x => wordsB.has(x));
  return intersection.length / Math.max(wordsA.size, wordsB.size);
}

export async function runVerify(
  projectId: string,
  atoms: KnowledgeAtom[]
): Promise<VerifiedAtomAction[]> {
  const verifiedActions: VerifiedAtomAction[] = [];

  for (const atom of atoms) {
    // 1. Fetch active items in the same category
    const activeItems = await queryKnowledgeBase(projectId, {
      category: atom.category,
      status: 'active',
    });

    if (activeItems.length === 0) {
      verifiedActions.push({ atom, action: 'insert' });
      continue;
    }

    // 2. Score and sort active items by similarity to candidate atom's title
    const scoredItems = activeItems.map(item => ({
      item,
      score: getTitleSimilarity(atom.title, item.title),
    }))
    .filter(x => x.score > 0.05) // small threshold to avoid completely unrelated items
    .sort((a, b) => b.score - a.score);

    let resolved = false;

    // 3. Compare with top candidates (limit to top 3 to save tokens)
    const candidates = scoredItems.slice(0, 3).map(x => x.item);
    
    // If no candidate matches by similarity, fall back to checking the single most recently updated item in that category
    if (candidates.length === 0 && activeItems.length > 0) {
      const sortedByRecency = [...activeItems].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      candidates.push(sortedByRecency[0]);
    }

    for (const candidate of candidates) {
      const compareResult = await compareKnowledge(atom, candidate);

      if (compareResult.relationship === 'duplicate') {
        verifiedActions.push({
          atom,
          action: 'duplicate',
          existingItemId: candidate.id,
          compareResult,
        });
        resolved = true;
        break;
      }

      if (compareResult.relationship === 'update') {
        verifiedActions.push({
          atom,
          action: 'update',
          existingItemId: candidate.id,
          compareResult,
        });
        resolved = true;
        break;
      }

      if (compareResult.relationship === 'contradiction') {
        verifiedActions.push({
          atom,
          action: 'contradiction',
          existingItemId: candidate.id,
          compareResult,
        });
        resolved = true;
        break;
      }
    }

    // 4. If unrelated to all candidates, it is a new item
    if (!resolved) {
      verifiedActions.push({ atom, action: 'insert' });
    }
  }

  return verifiedActions;
}
