/**
 * Can the parent session-start card's warning block squeeze skills or knowledge out?
 *
 * The parent path budgets like this (src/session/host-lifecycle.ts):
 *   warning      = truncateText([stale, drift, standing].filter(Boolean).join('\n\n'), 3000)
 *   recentBudget = warning ? 3000 - warning.length - 2 : 3000
 *   recent       = truncateText(started.context, recentBudget)
 *
 * That is the same render-wide-then-slice shape the subagent path had. The question is whether
 * the warning can grow far enough to push the cut back past a section boundary. All three
 * producers are bounded, so this is decidable rather than a matter of taste.
 *
 * Run: npx tsx scripts/measure-parent-card-squeeze.ts
 * Reads nothing and writes nothing.
 */
import { describeAutoDrift } from '../src/store/drift-auto.js';
import { describeObservedUsePromotions } from '../src/store/tier.js';
import { formatRecentContextToMarkdown } from '../src/core/format.js';
import { DEFAULT_CONTEXT_MAX_CHARS, MAX_TITLE_CHARS } from '../src/core/token-budget.js';
import type { KnowledgeItem } from '../src/core/types.js';

// The literal from staleGuidanceWarningBestEffort. Copied rather than called because the function
// is module-private and gated on filesystem state; its return value is a constant.
const STALE = 'KNOWL GUIDANCE STALE: this project\'s KNOWL.md / AGENTS.md were written by a different '
  + 'version of Knowl than the one running, so they may contradict the guidance in this block. '
  + 'Where they disagree, the file is the stale one. Run `knowl init` (or `knowl doctor --fix`) '
  + 'to refresh them.';

const maxTitle = 'T'.repeat(MAX_TITLE_CHARS);
// WARNING_TITLE_LIMIT is 3 and titles are capped at MAX_TITLE_CHARS, so this is the largest
// drift line the producer can emit. candidateCount above the title count adds the ', …'.
const drift = describeAutoDrift({
  checked: true, candidateCount: 99, candidateTitles: [maxTitle, maxTitle, maxTitle],
  sinceCommit: 'a'.repeat(40),
} as never) ?? '';
const standing = describeObservedUsePromotions({ promoted: new Array(9).fill({}), deferred: 42 } as never) ?? '';

const worst = [STALE, drift, standing].join('\n\n');

// The same four-repo workspace the subagent defect was measured on.
const role = (what: string) => `${what}, and a further clause of the kind manifests actually carry describing what stays private, what is shared, and which conventions a reader should not assume transfer`;
const workspace = {
  name: 'duck', repo: 'knowl-cloud', selfRole: role('the hosted team-memory service'),
  peers: [
    { name: 'duckprep', role: role('the consumer SAT app'), defaultVisibility: 'workspace' as const },
    { name: 'ducksat', role: role('the private tutoring tool'), defaultVisibility: 'workspace' as const },
    { name: 'students', role: role('per-student tutoring records'), defaultVisibility: 'workspace' as const },
  ],
};
const item = (t: string, category: 'fact' | 'skill'): KnowledgeItem => ({
  id: t, title: t, content: 'a body of the ordinary length these carry in a real store, long enough to matter',
  category, status: 'active', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
} as KnowledgeItem);

const card = formatRecentContextToMarkdown({
  items: [item('one', 'fact'), item('two', 'fact'), item('three', 'fact')],
  commits: [],
  // Three skills with titles of the length real ones carry. The live card measured on this
  // machine rendered its skills section at 697 characters against the 750 the 25% clamp allows,
  // so a one-skill fixture understates the boundary by ~600 and quietly moves the answer.
  skills: [
    item('William\'s work-or-sleep cycle — delete the middle state, ride 70+ down, sleep before the cliff', 'skill'),
    item('knowl-cloud\'s image generator lives at scripts/design/gen-image.mjs — but ONLY on branch docs/research-and-agent-surface, not on main', 'skill'),
    item('Website-cloning skill design: the 10-part spine assembled from 6 specimens, none of which has all of it', 'skill'),
  ],
}, { maxChars: Number.MAX_SAFE_INTEGER, workspace });

const skillsAt = card.indexOf('## Available skills');
const knowledgeAt = card.indexOf('## Recent Active Knowledge');

const row = (label: string, n: number) => console.log(`  ${String(n).padStart(6)}  ${label}`);
console.log('\nWARNING BLOCK, each producer at its maximum:');
row('stale-guidance (fixed string)', STALE.length);
row(`drift (${'WARNING_TITLE_LIMIT'} = 3 titles at MAX_TITLE_CHARS ${MAX_TITLE_CHARS})`, drift.length);
row('standing (fixed + deferred clause)', standing.length);
row('joined worst case', worst.length);

console.log('\nCARD SECTION BOUNDARIES (four-repo workspace):');
row('"## Available skills" begins at', skillsAt);
row('"## Recent Active Knowledge" begins at', knowledgeAt);

const budget = DEFAULT_CONTEXT_MAX_CHARS - worst.length - 2;
console.log('\nBUDGET LEFT FOR THE CARD:');
row('with no warning', DEFAULT_CONTEXT_MAX_CHARS);
row('at worst-case warning', budget);
console.log(`\n  warning length that costs knowledge under a blind slice: > ${DEFAULT_CONTEXT_MAX_CHARS - knowledgeAt - 2}`);
console.log(`  warning length that costs skills under a blind slice:    > ${DEFAULT_CONTEXT_MAX_CHARS - skillsAt - 2}`);

// The two paths, side by side. `sliced` is what the parent used to do: render at
// MAX_SAFE_INTEGER, then cut the finished string. `composed` is what it does now.
const sliced = card.slice(0, budget);
const composed = formatRecentContextToMarkdown({
  items: [item('one', 'fact'), item('two', 'fact'), item('three', 'fact')],
  commits: [],
  skills: [item('a skill that cannot be found by querying', 'skill')],
}, { maxChars: budget, workspace });

const verdict = (label: string, md: string) => {
  console.log(`\n  ${label}  (${md.length} chars)`);
  console.log(`    skills:    ${md.includes('## Available skills') ? 'present' : 'LOST'}`);
  console.log(`    knowledge: ${md.includes('## Recent Active Knowledge') ? 'present' : 'LOST'}`);
};
console.log('\nAT THE WORST-CASE WARNING, FOUR-REPO WORKSPACE:');
verdict('render wide then slice (the old parent path)', sliced);
verdict('compose to the budget (the current parent path)', composed);
console.log();
