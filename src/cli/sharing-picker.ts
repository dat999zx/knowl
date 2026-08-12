import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '../core/types.js';
import { SHARED_BY_DEFAULT, withholdReason } from '../core/sharing-defaults.js';

/**
 * Ask which categories to share, with a recommendation already ticked.
 *
 * Returns null for both "no TTY" and "cancelled", because the caller's remedy is the same in
 * both cases: print the refusal naming `--category` and `--id`, which is exactly what this
 * command did before the picker existed. An empty array is different and means the user
 * deliberately unticked everything -- an answer, not an absence of one.
 */
export async function pickCategories(input: {
  /** The command the user typed, so the prompt names it: `promote` or `stage`. */
  verb: string;
  /** Where it goes -- a workspace name -- so the prompt says what sharing means here. */
  destination: string;
  counts: Record<KnowledgeCategory, number>;
  isTTY?: boolean;
}): Promise<KnowledgeCategory[] | null> {
  const isTTY = input.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return null;

  // Lazily, matching `init-flow.ts` and `cloud-picker.ts`: the prompt library is only reachable
  // from interactive paths and must not be paid for by `knowl serve`.
  const clack = await import('@clack/prompts');

  // Padded so the counts line up into a column. A ragged list of numbers is harder to compare
  // than an aligned one, and comparing them is the whole reason they are shown.
  const width = Math.max(...KNOWLEDGE_CATEGORIES.map(category => category.length));

  const chosen = await clack.multiselect({
    message: `Which knowledge should ${input.verb} send to "${input.destination}"?`,
    options: KNOWLEDGE_CATEGORIES.map(category => {
      const reason = withholdReason(category);
      return {
        value: category,
        label: `${category.padEnd(width)}  ${input.counts[category] ?? 0}`,
        // Only the withheld ones carry a hint: a reason beside every row is noise, and the
        // question a reader has is "why is this one not ticked".
        ...(reason ? { hint: reason } : {}),
      };
    }),
    initialValues: [...SHARED_BY_DEFAULT],
    required: false,
  });

  return clack.isCancel(chosen) ? null : (chosen as KnowledgeCategory[]);
}
