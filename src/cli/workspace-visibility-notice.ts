import { KNOWLEDGE_CATEGORIES } from '../core/types.js';

/**
 * The gate on standing, automatic publishing.
 *
 * `promote` is explicit and per-batch; a default visibility of `workspace` keeps publishing
 * until someone notices, so it earns a louder warning than a flag normally would. There is no
 * demote and there should not be one: a peer may already have read the item, and the change
 * watermark may already have delivered a notification for it. Saying so here is the honest
 * alternative to an inverse that would only pretend to retract.
 */
export function visibilityGateNotice(repoName: string): string[] {
  return [
    `Repo "${repoName}" will write new knowledge at workspace visibility.`,
    'Every item written here becomes readable by all linked repos immediately, with no review step.',
    'This cannot be undone: there is no demote. `knowl workspace set --default-visibility repo`',
    'stops future writes only; anything already shared stays shared.',
    'An agent with an open session picks this up on its next session, not mid-session.',
  ];
}

/**
 * What linking leaves behind.
 *
 * A repo linked with `--default-visibility workspace` that already holds private knowledge is
 * half-shared, which is the original inconsistency in a new form. Reporting the count and
 * naming the command keeps bulk publishing an explicit gesture -- the rule `promoteItems`
 * already enforces by refusing a bare promote.
 *
 * The category list is quoted because `knowl.cmd` runs through `cmd.exe`, which splits an
 * unquoted comma list on the commas. Guidance that prints a command must print one that works
 * on the platform reading it.
 */
export function existingItemsNotice(count: number): string[] {
  if (count <= 0) return [];
  return [
    `${count} existing item${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} still private.`,
    'Share them with:',
    `  knowl workspace promote --category "${KNOWLEDGE_CATEGORIES.join(',')}" --apply`,
    'Or re-run add with --promote-existing to do it in one step.',
  ];
}
