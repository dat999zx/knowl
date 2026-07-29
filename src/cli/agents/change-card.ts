import type { ChangeSummary } from '../../store/change-watermark.js';

const MAX_ITEM_LINES = 5;
const MAX_TITLE_LENGTH = 90;
const CLOSING_LINE = 'Call knowl_query before relying on earlier memory in these areas.';

// A type alias rather than an interface: only aliases get an implicit index
// signature, which is what keeps this assignable to HostLifecycleResult.hostOutput
// (`Record<string, unknown>`) without a cast.
export type ClaudeChangeCardOutput = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
};

/**
 * Titles only, never content. A title is the routing information the agent needs —
 * "do I care about this?" — and content is what knowl_query is for.
 */
export function renderChangeCard(summary: ChangeSummary): string {
  const shown = summary.items.slice(0, MAX_ITEM_LINES);
  const lines = shown.map(item => {
    const action = item.action === 'insert' ? '' : ` (${item.action})`;
    // The repo tag is not decoration: a fact from another repo describes that repo, so
    // an agent that cannot tell where a change landed cannot tell whether it applies here.
    const repo = item.repo ? `[${item.repo}] ` : '';
    return `- ${repo}${item.category}${action}: ${item.title.slice(0, MAX_TITLE_LENGTH)}`;
  });
  const remaining = summary.count - shown.length;
  if (remaining > 0) lines.push(`- +${remaining} more`);
  const noun = summary.count === 1 ? 'item' : 'items';
  return [
    `KNOWL CHANGED: ${summary.count} ${noun} since you last looked.`,
    ...lines,
    CLOSING_LINE,
  ].join('\n');
}

export function createClaudeChangeCardOutput(summary: ChangeSummary): ClaudeChangeCardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: renderChangeCard(summary),
    },
  };
}
