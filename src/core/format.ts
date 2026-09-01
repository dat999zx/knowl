import { KnowledgeCommit, KnowledgeItem } from './types.js';
import { DEFAULT_CONTEXT_MAX_CHARS, MAX_SUMMARY_ITEM_CHARS, truncateText } from './token-budget.js';
import { renderSkillsSection, selectSurfacedSkills, toPeerSurfacedSkills } from './skill-surface.js';
import { fenceUntrusted, inlineUntrusted, UNTRUSTED_NOTICE_BRIEF } from './untrusted.js';

/**
 * How many moved paths the staleness marker names before it stops counting them out.
 *
 * Three, because the marker has to stay one line a reader takes in at a glance -- an atom
 * citing thirty paths would otherwise turn a marker into a wall, and the reader who skims past
 * a wall is exactly the reader this marker exists for. The rest are reported as a number,
 * which is enough to say "there is more here than the three I named".
 */
const MAX_NAMED_MOVED_PATHS = 3;

/**
 * The staleness marker on a query row whose cited files moved after the row was stored.
 *
 * WHY IT LEADS WITH AN INSTRUCTION. This used to read `N of M affectedPaths modified since
 * this was stored -- verify against the files before trusting`, which states a condition and
 * leaves the reader to work out the action. Measurement on served-but-superseded claims says
 * that is the shape that does not land: with the source present and reachable, agents opened
 * it in roughly one turn in five and acted on the stale value in about three quarters of the
 * rest, and a content-free freshness cue did not move those numbers. What moved them was an
 * instruction naming what to open, on the path the reader was already on.
 *
 * So the sentence opens with the verb and the filenames, and the count -- which is a
 * description, not an action -- follows it. The count stays because it is the one thing that
 * separates "one of nine cited files was touched" from "every file this rests on is gone".
 */
export function pathsChangedNote(changed: number, checked: number, movedPaths: string[]): string {
  const named = movedPaths.slice(0, MAX_NAMED_MOVED_PATHS);
  const rest = movedPaths.length - named.length;
  // Falls back to the bare count rather than inventing a target. `movedPaths` is empty only if
  // a caller counted a change it could not name, and "open nothing" is worse than no verb.
  const targets = named.length === 0
    ? ''
    : `Open ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}, then verify this still holds: `;
  return `${targets}${changed} of ${checked} affectedPaths modified since this was stored${targets ? '.' : ' -- verify against the files before trusting.'}`;
}

/**
 * Formats a hierarchical knowledge object into clean readable markdown.
 * Shared between MCP server responses and CLI output.
 */
export function formatHierarchyToMarkdown(hierarchy: {
  state: KnowledgeItem[];
  knowledge: KnowledgeItem[];
  skills: KnowledgeItem[];
  archive: KnowledgeItem[];
}, options: { maxChars?: number; maxItemChars?: number } = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const maxItemChars = options.maxItemChars ?? MAX_SUMMARY_ITEM_CHARS;
  // Truncate first, then contain. The other order lets a body whose fence run sits past the
  // ceiling pick the fence length for text that is then cut away.
  const itemText = (value: string) => inlineUntrusted(truncateText(value, maxItemChars));
  // Multi-line bodies keep their shape, inside a container they cannot close.
  const itemBlock = (value: string) => fenceUntrusted(truncateText(value, maxItemChars));
  let md = `# KNOWL — PROJECT BRAIN STATE\n\n${UNTRUSTED_NOTICE_BRIEF}\n\n`;

  // Goals & Constraints
  const goals = hierarchy.knowledge.filter(x => x.category === 'goal');
  const constraints = hierarchy.knowledge.filter(x => x.category === 'constraint');
  
  md += `## 🎯 GOALS\n\n`;
  if (goals.length === 0) md += `No active goals recorded.\n\n`;
  else goals.forEach(g => { md += `- **${itemText(g.title)}**: ${itemText(g.content)}\n`; });
  md += `\n`;

  md += `## ⚠️ CONSTRAINTS\n\n`;
  if (constraints.length === 0) md += `No active constraints recorded.\n\n`;
  else constraints.forEach(c => { md += `- **${itemText(c.title)}**: ${itemText(c.content)}\n`; });
  md += `\n`;

  // Active state
  md += `## ⚡ ACTIVE STATE\n\n`;
  if (hierarchy.state.length === 0) md += `No active state updates recorded.\n\n`;
  else {
    hierarchy.state.forEach(s => {
      // The bold label is containment, not decoration, and this is the one line in the file that
      // used to lack it. `inlineUntrusted` is documented as safe "in a heading, a list item or a
      // table cell" -- every one of which supplies a prefix -- because collapsing line breaks
      // stops a body FORMING a block construct, not a body that already BEGINS with one. This
      // line rendered a stored title at column 0, so a title of `# ...` was a live H1 in the
      // agent's context, indistinguishable from knowl's own voice. Every neighbouring section
      // already led with `- **`; only this one did not. The `padEnd(20)` that stood here bought
      // nothing to weigh against it: real titles are sentences, so it aligned almost nothing.
      md += `- **${itemText(s.title)}** = ${itemText(s.content)}\n`;
    });
    md += `\n`;
  }

  // Decisions & Architecture
  const decisions = hierarchy.knowledge.filter(x => x.category === 'decision');
  const arch = hierarchy.knowledge.filter(x => x.category === 'architecture');
  const facts = hierarchy.knowledge.filter(x => x.category === 'fact');

  md += `## 🏛️ ARCHITECTURE\n\n`;
  if (arch.length === 0) md += `No active architecture specifications.\n\n`;
  else {
    arch.forEach(a => {
      md += `### ${itemText(a.title)}\n${itemBlock(a.content)}\n\n`;
    });
  }

  md += `## 💡 DECISIONS\n\n`;
  if (decisions.length === 0) md += `No active decisions recorded.\n\n`;
  else {
    decisions.forEach(d => {
      md += `### ${itemText(d.title)} (ID: ${d.id})\n${itemBlock(d.content)}\n`;
      if (d.reasoning) md += `**Reasoning:** ${itemText(d.reasoning)}\n`;
      if (d.alternatives && d.alternatives.length > 0) {
        md += `**Alternatives considered:** ${itemText(d.alternatives.join(', '))}\n`;
      }
      md += `\n`;
    });
  }

  md += `## 📋 GENERAL FACTS\n\n`;
  if (facts.length === 0) md += `No general facts recorded.\n\n`;
  else {
    facts.forEach(f => {
      md += `- **${itemText(f.title)}**: ${itemText(f.content)}\n`;
    });
    md += `\n`;
  }

  // Learned skills
  md += `## 🛠️ LEARNED SKILLS\n\n`;
  if (hierarchy.skills.length === 0) md += `No skills learned yet.\n\n`;
  else {
    hierarchy.skills.forEach(s => {
      md += `### ${itemText(s.title)} (ID: ${s.id})\n${itemBlock(s.content)}\n\n`;
    });
  }

  return md.length <= maxChars ? md : truncateText(md, maxChars, '[Context truncated]');
}

export type WorkspaceContextRepo = {
  name: string;
  role?: string;
  kin?: string;
  defaultVisibility?: 'workspace';
};

export type WorkspaceContext = {
  name: string;
  repo: string;
  peers: WorkspaceContextRepo[];
  selfRole?: string;
  selfDefaultVisibility?: 'workspace';
};

/**
 * What each repo in this workspace is, before the agent makes its first sharing decision.
 *
 * Without it, repo nature is re-derived from whatever happens to be visible, and re-derived
 * the same wrong way every time: one uniform "share selectively" posture across repos that do
 * not share a nature. A notes repo whose entire content is cross-cutting looks exactly like a
 * code repo with private internals when all you have is a name.
 */
function workspaceSection(workspace: WorkspaceContext, compact = false): string {
  // Manifest fields, and manifest fields reach this card unreviewed. `normalizeRepoEntry` is not
  // the defence: it is documented never to reject, because `discoverRepos` reads every manifest
  // on the machine and one bad entry must not take down a machine-wide command. So `name` is
  // whatever string is in the file and only `role` happens to be collapsed there. Containing at
  // the render site is the rule this module already follows everywhere else, and it is a no-op
  // on well-formed values -- a newline in `name` was otherwise a live heading at column 0.
  const line = (repo: WorkspaceContextRepo, isSelf: boolean): string => {
    const name = inlineUntrusted(repo.name);
    const kin = repo.kin ? inlineUntrusted(repo.kin) : '';
    const parts = [`- ${name}${isSelf ? ' (this repo)' : ''}${kin ? ` [kin: ${kin}]` : ''}`];
    // Dropped first under `compact`, because it is the only unbounded field here: `name` and
    // `kin` are short identifiers, `role` is free prose from the manifest.
    if (repo.role && !compact) parts.push(inlineUntrusted(repo.role));
    parts.push(repo.defaultVisibility === 'workspace' ? 'new writes are workspace-visible' : 'new writes stay private');
    return parts.join(' — ');
  };

  const self: WorkspaceContextRepo = {
    name: workspace.repo, role: workspace.selfRole, defaultVisibility: workspace.selfDefaultVisibility,
  };
  return [
    `## Workspace: ${inlineUntrusted(workspace.name)}`,
    '',
    line(self, true),
    ...workspace.peers.map(peer => line(peer, false)),
    '',
    '',
  ].join('\n');
}

export function formatRecentContextToMarkdown(context: {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
  skills?: KnowledgeItem[];
  /**
   * Linked repos' workspace-visible skills, structurally typed so `core` stays at the bottom of
   * the dependency graph -- `workspace/peer-skills.ts` produces this shape and imports downward.
   */
  peerSkills?: Array<{ repo: string; item: KnowledgeItem }>;
}, options: {
  maxChars?: number;
  maxItemChars?: number;
  includeTags?: boolean;
  includeCommitDetails?: boolean;
  workspace?: WorkspaceContext;
  /**
   * Names and write-visibility only, dropping each repo's `role` prose.
   *
   * The role lines are the bulk of this section and they scale with the number of linked repos:
   * on a four-repo workspace the full list measured 1,034 characters, which alone exceeds a
   * subagent's whole 853-character budget. Nothing clamps this section the way `skillBudget`
   * clamps skills, so an unclamped workspace pushed BOTH skills and recent knowledge out of a
   * subagent's card entirely -- and skills are the half that cannot be recovered by querying.
   */
  compactWorkspace?: boolean;
  /**
   * Replace recent knowledge and commits with a count and an instruction to query.
   *
   * Measured, three arms of six subagents each on one task, differing only in this block:
   * five item titles -> 6/6 called `knowl_query`; thirteen titles -> 1/6; a bare pointer with no
   * answerable content -> 6/6, at a seventh of the size (Fisher exact p = 0.008 for the middle
   * arm against either other). Titles long enough to look sufficient are answered FROM rather
   * than queried against, and the agents that skipped retrieval cited only their own injected
   * titles back. A pointer cannot be answered from, so it costs bytes and buys the lookup.
   */
  knowledgeAsPointer?: boolean;
} = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const maxItemChars = options.maxItemChars ?? MAX_SUMMARY_ITEM_CHARS;
  // The notice leads, and must: this card is injected at session bootstrap with no human in
  // the loop, and the `truncateText` at the bottom of this function would drop a trailing
  // notice on exactly the largest payloads.
  let md = `# KNOWL - RECENT SESSION CONTEXT\n\n${UNTRUSTED_NOTICE_BRIEF}\n\n`;

  // Absent produces byte-identical output, the same rule formatWorkspaceBlock already holds
  // for an unlinked project.
  if (options.workspace) md += workspaceSection(options.workspace, options.compactWorkspace === true);

  // A quarter of the budget at most, and only what fits. An agent that already knows a
  // skill exists needs no mid-turn interrupt, which is why this section earns its space.
  //
  // Clamped to the real cap rather than trusting `maxChars`: bootstrapAgentSession formats
  // with Number.MAX_SAFE_INTEGER and slices to DEFAULT_CONTEXT_MAX_CHARS afterwards, so an
  // unclamped quarter is unbounded and, since skills render first, would push recent
  // knowledge out of the card entirely.
  const skillBudget = Math.floor(Math.min(maxChars, DEFAULT_CONTEXT_MAX_CHARS) * 0.25);
  // Rendered by the same module that priced it, so the section can never exceed the budget
  // selection thought it was spending.
  //
  // Peers are passed in beside the local rows rather than concatenated into them, because the
  // two are mapped differently: a peer row is a pointer whose `runnable` is forced false, and
  // deriving it from `source` the way a local row does would mark it runnable.
  md += renderSkillsSection(selectSurfacedSkills(
    context.skills ?? [],
    skillBudget,
    toPeerSurfacedSkills(context.peerSkills ?? []),
  ));

  // Pointer mode ends the card here: both remaining sections are recent-activity summaries, and
  // both are recoverable by querying, which is the whole argument for replacing them. No count is
  // given because the only one in scope would be a lie -- `getRecentContext` returns at most three
  // items regardless of how much the store holds, so "3 items" would understate a store of
  // thousands and read as a reason not to bother.
  if (options.knowledgeAsPointer) {
    md += '## Project knowledge\n\nNot reproduced here. Call knowl_query with the words that name '
      + 'your subject to open what is relevant to your task.\n';
    return md.length <= maxChars ? md : truncateText(md, maxChars, '[Context truncated]');
  }

  md += '## Recent Active Knowledge\n\n';
  if (context.items.length === 0) {
    md += 'No recent active knowledge recorded.\n\n';
  } else {
    for (const item of context.items) {
      // Every one of these is stored text on a line of its own inside a list. A body carrying
      // a newline used to break out to column 0, where an ATX heading or a fence opener is
      // live markdown; collapsing the line breaks removes the line start it would need.
      md += `- **${inlineUntrusted(item.title)}** (${item.category}, updated ${item.updatedAt})\n`;
      // The `— ` is containment, and two spaces were not. CommonMark allows a block construct up
      // to THREE spaces of indentation, so this line's two-space indent neutralised nothing: a
      // stored body BEGINNING with `# `, `---`, `> ` or a fence opener rendered as live markdown
      // here, in the bootstrap card, injected with no human in the loop. `inlineUntrusted` was
      // doing its job -- it stops a body FORMING a line start, and this body never needed to,
      // because the formatter handed it one. Any literal non-marker character closes it; the em
      // dash is the continuation idiom `renderSkillRow` already uses in this same card. It costs
      // two characters against a budget the notice argument weighed in hundreds, on the three
      // items `getRecentContext` returns.
      md += `  — ${inlineUntrusted(truncateText(item.content, maxItemChars))}\n`;
      if (options.includeTags && item.tags && item.tags.length > 0) {
        md += `  Tags: ${inlineUntrusted(item.tags.join(', '))}\n`;
      }
    }
    md += '\n';
  }

  md += '## Recent Knowledge Commits\n\n';
  if (context.commits.length === 0) {
    md += 'No recent knowledge commits recorded.\n';
  } else {
    for (const commit of context.commits) {
      // A commit message is caller-supplied too, and reaches this card unreviewed.
      md += `- ${commit.createdAt}: ${inlineUntrusted(commit.message)}\n`;
      if (options.includeCommitDetails && commit.changes.length > 0) md += `  Changes: ${commit.changes.length}\n`;
    }
  }

  return md.length <= maxChars ? md : truncateText(md, maxChars, '[Context truncated]');
}
