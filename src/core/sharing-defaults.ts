import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from './types.js';

/**
 * The categories a bare share offers to send, and the ones it leaves for you to tick.
 *
 * One definition for both destinations. `knowl workspace promote` shares with linked local repos
 * and `knowl cloud stage` queues for the team, but the question underneath is the same -- what
 * does another reader need from this repo -- and the answer does not change according to who the
 * reader is. Two copies would drift.
 *
 * Derived from a real store rather than from taste. In this repository `fact` (359) and `state`
 * (194) are 66% of everything active, and both are the repo talking about itself: commit-level
 * changelog and PR verdicts, which churn on every merge. Sending that to a peer buries the
 * knowledge they came for.
 */
export const SHARED_BY_DEFAULT: readonly KnowledgeCategory[] = [
  // A peer cannot integrate without knowing how this repo is shaped.
  'architecture',
  // Hard rules. Cross-repo constraints are exactly what break integrations when unknown.
  'constraint',
  // Choices with reasoning, so a peer does not re-litigate or contradict one.
  'decision',
  // Direction. A peer needs to know where this repo is going before building against it.
  'goal',
  // Method knowledge. KNOWL.md already says method questions belong to the whole workspace:
  // "a sibling repo's pipeline answers them more often than this repo's files do".
  'skill',
];

export const WITHHELD_BY_DEFAULT: readonly KnowledgeCategory[] = ['fact', 'state'];

const REASONS: Partial<Record<KnowledgeCategory, string>> = {
  fact: 'mostly commit-level detail about this repo',
  state: 'this repo\'s own status; churns on every merge',
};

/** The hint shown beside an unticked row, or null for a category shared by default. */
export function withholdReason(category: KnowledgeCategory): string | null {
  return REASONS[category] ?? null;
}

/**
 * How many candidates the recommendation would actually select.
 *
 * Zero is a real and common state -- a repo that shared once has nothing left in these five,
 * because new writes reach the destination on their own. A picker opened in that state offers a
 * list of zeros, and pressing enter returns an empty selection that reads as a bug rather than as
 * "you are already up to date". Callers check this first and say so instead.
 */
export function recommendedTotal(counts: Record<KnowledgeCategory, number>): number {
  return SHARED_BY_DEFAULT.reduce((sum, category) => sum + (counts[category] ?? 0), 0);
}

// Every category belongs to exactly one list. A category added to `KnowledgeCategory` and to
// neither list would silently vanish from the picker -- the row would not render, and nobody
// would be told it exists. Checked at module load so the failure is immediate and local.
{
  const covered = new Set<string>([...SHARED_BY_DEFAULT, ...WITHHELD_BY_DEFAULT]);
  const missing = KNOWLEDGE_CATEGORIES.filter(category => !covered.has(category));
  if (missing.length > 0) {
    throw new Error(
      `sharing-defaults.ts does not classify: ${missing.join(', ')}. `
      + 'Add each to SHARED_BY_DEFAULT or WITHHELD_BY_DEFAULT.',
    );
  }
}
