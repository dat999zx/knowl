import type { ProjectConfig } from './types.js';
import { isTranscriptSearchEnabled } from './config.js';

export const KNOWL_GUIDANCE_START_MARKER = '<!-- KNOWL_PROJECT_MEMORY -->';
export const KNOWL_GUIDANCE_END_MARKER = '<!-- /KNOWL_PROJECT_MEMORY -->';

export const KNOWL_MCP_TOOL_GROUPS = [
  {
    label: 'Focused retrieval',
    tools: ['knowl_query'],
    routing: 'Default first call for a specific project request and again when switching areas. Use the words that name the subject, without padding, and omit category unless certain.',
  },
  {
    label: 'Context views',
    tools: ['knowl_recent', 'knowl_state', 'knowl_context'],
    routing: 'Use recent only without lifecycle bootstrap or for an explicit refresh; state for broad status; context for an explicitly token-budgeted pack.',
  },
  {
    label: 'Manual work loop',
    tools: ['knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish'],
    routing: 'Use only without verified lifecycle hooks: start once, checkpoint meaningful milestones or blockers, and finish once after verification.',
  },
  {
    label: 'Durable writes',
    tools: ['knowl_store', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update'],
    routing: 'Store one verified atom, batch verified atoms, record a confirmed decision, or correct/supersede stale memory.',
  },
  {
    label: 'History and quality',
    tools: ['knowl_timeline', 'knowl_evidence_list', 'knowl_conflicts', 'knowl_feedback'],
    routing: 'Inspect history, evidence, or conflicts when needed; record feedback only after actual use, rejection, or correction.',
  },
  {
    label: 'Learned skills',
    tools: ['knowl_skill_list', 'knowl_skill_read', 'knowl_skill_run', 'knowl_skill_create'],
    routing: 'Discover and read a matching skill before running a trusted entrypoint; create only when explicitly requested.',
  },
  {
    label: 'Special and maintenance',
    tools: ['knowl_ingest', 'knowl_synthesize', 'knowl_session_finish', 'knowl_gc_preview', 'knowl_gc_apply'],
    routing: 'Raw-source ingest requires an explicit request and configured AI; never send the current conversation silently. Synthesis is explicitly scoped and never automatic. Session finish is only for an explicitly owned manual memory-session ID, never a hook session. Preview GC first; apply only after explicit approval.',
  },
  {
    label: 'Session handoff',
    tools: ['knowl_handoff'],
    routing: 'Use when parking a workstream before ending a session. The next session in this project receives it once, then it is archived. One baton per project -- parking again replaces it. Durable facts still belong in knowl_store.',
  },
  {
    label: 'Parked work',
    tools: ['knowl_park', 'knowl_resume'],
    routing: 'Park work the user means to come back to: knowl_park mints a short key and returns a paste-ready line to hand them verbatim, since a key reworded is a key lost. knowl_resume takes that key in any later session, from any directory, and returns the brief. Unlike the handoff baton -- which the next session in this project consumes once -- a key is held by the user, is not spent by resuming, and works any number of sessions later. Call knowl_resume as soon as a user supplies a key; with no key it lists what is parked here.',
  },
] as const;

export type KnowlMcpToolName = typeof KNOWL_MCP_TOOL_GROUPS[number]['tools'][number];

export const KNOWL_MCP_TOOL_NAMES = KNOWL_MCP_TOOL_GROUPS
  .flatMap(group => [...group.tools]) as KnowlMcpToolName[];

const REQUIRED_WORKFLOW = `### Required workflow

1. For every project-specific request, call \`knowl_query\` before repository files or commands, using the words that name the subject: another on-subject term retrieves better, an off-subject one retrieves worse, so do not pad the query and do not trim a real term to shorten it.
2. Skip a new query only when directly relevant active lifecycle context, a same-request query, or manual \`knowl_task_start\` relevant memory already answers it.
3. Use a relevant active hit immediately. Inspect files only after a miss, conflict, stale/low-confidence memory, or explicit verification request.
4. Query again before switching to a distinct subtask or project area, and before choosing how to build something new — existing tooling and pipelines are project knowledge, and in a linked workspace they often live in a sibling repo, so leave method queries unscoped.
5. Store or update durable knowledge during work and before the final answer — verified findings, stated intent (goals, plans, direction the user voiced) stored as goals with user_stated provenance even while unsettled, and resolved diagnoses stored as skills when the cause will recur (an environment quirk, a config trap — not a typo). The test: could a fresh session recover this from memory alone? Never store raw transcripts, secrets, or transient debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.`;

const LIFECYCLE_MODES = `### Lifecycle modes

- **Automatic host lifecycle:** verified hooks own bootstrap, capture, checkpoints, and finalization. Never call \`knowl_task_start\`, \`knowl_task_checkpoint\`, \`knowl_task_finish\`, or \`knowl_session_finish\` for that hook-owned session.
- **Manual work loop:** without verified hooks, use \`knowl task run\` for one bounded command. For resumable work, start once, checkpoint meaningful milestones/blockers with the returned task ID, and finish exactly once after verification. The start result satisfies the initial focused lookup.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.`;

const SAFETY = `### Safety and freshness

- Correct stale or contradicted memory with \`knowl_update\` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- \`Auth: Unsupported\` is normal for a local stdio MCP server when the focused retrieval tool is listed.`;

const WORKSPACE = `### Linked repositories

- When this repo is in a workspace, read the **shape** of a \`knowl_query\` result first. A bare JSON array means every row belongs to this repo. An object keyed by repo name means at least one row does **not** — and a fact from another repo describes **that** repo unless it says otherwise, so verify before applying it here.
- An empty array under this repo's own key means this repo holds nothing on the subject. Read the other keys as background, not as an answer, and treat it as a miss if what they say does not transfer.
- Narrow with \`scope: "local"\` (this repo alone, always a bare array) or \`scope: "workspace"\` (every sharing repo, always keyed). \`repos: ["<name>"]\` restricts to named repos and matches the repo that owns an item; it wins if both are given.
- Method questions — "how do we generate X", "is there a script for Y" — belong to the whole workspace: query them unscoped before building new tooling; a sibling repo's pipeline answers them more often than this repo's files do.
- A \`WORKSPACE:\` notice names linked repos that matched but were not shown, with counts. Re-query with \`repos\` to read them.
- Whether a new write is shared is this repo's recorded default, not a fixed rule: joining a linked workspace sets it to workspace visibility, while \`--default-visibility repo\` keeps writes private. \`knowl workspace set\` with no flags prints the current value.
- Knowledge already written privately stays private until someone runs \`knowl workspace promote\`. Only the owning repo can promote, update, or retire its own items.`;

export function renderFullKnowlGuidance(): string {
  const table = [
    '| Group | Tools | Routing |',
    '| --- | --- | --- |',
    ...KNOWL_MCP_TOOL_GROUPS.map(group =>
      `| ${group.label} | ${group.tools.map(tool => `\`${tool}\``).join(', ')} | ${group.routing} |`),
  ].join('\n');
  return ['## Knowl Project Memory', REQUIRED_WORKFLOW, LIFECYCLE_MODES, `### Complete MCP tool routing\n\n${table}`, WORKSPACE, SAFETY].join('\n\n');
}

export function renderManagedKnowlGuidanceSection(): string {
  return `${KNOWL_GUIDANCE_START_MARKER}\n${renderFullKnowlGuidance()}\n${KNOWL_GUIDANCE_END_MARKER}\n`;
}

export const KNOWL_CLAUDE_MODE_LINE = 'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.';
export const KNOWL_HOST_NEUTRAL_MODE_LINE = 'Mode: verified hooks, when active, own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active; otherwise use the manual fallback.';

/**
 * One extra Route line, only when transcript search is on.
 *
 * The card is a token cost paid by every session of every user. Everyone who leaves the feature
 * off keeps the shorter card and never learns this capability exists.
 */
const TRANSCRIPT_ROUTE_LINE =
  '- transcripts: list past sessions, search them after a knowl_query miss, open a hit. Store what you use.';

/**
 * The compact card carries POLICY, not an inventory.
 *
 * It used to name all 27 tools, and a test required every one of them to appear. That made the
 * card grow with the tool count and it hit the ceiling: 1,994 of 2,000 characters, six to spare,
 * with the last feature paid for by compressing four unrelated lines.
 *
 * Measured, which is what settled it: the same MCP handshake already delivers `tools/list` --
 * 22,394 characters, including every tool name and 6,195 characters of descriptions. The card
 * was spending its scarcest resource restating a payload eleven times its size. Names are not
 * what an agent lacks.
 *
 * So the Route lines describe *behaviour* and the agent maps behaviour to a name using those
 * descriptions. What still gets named here is only what the descriptions cannot carry:
 *
 *   - `knowl_query`, because "call this first, before files" is sequencing across tools.
 *   - the four lifecycle tools, because "never call these while hooks are active" is a
 *     prohibition, and a tool's own description is the last place a caller looks for one.
 *
 * Everything else -- which of four write tools, which of three audit tools -- is a choice
 * `tools/list` already describes better than a bullet can.
 *
 * The full guidance (`renderFullKnowlGuidance`) still names all 27 in its table. That is a file
 * written once per repo, not a cost paid per session, and it is the right home for an inventory.
 */
function renderCompactKnowlGuidance(modeLine: string, options: { transcripts?: boolean } = {}): string {
  return [
    'KNOWL WORKFLOW - for project work.',
    'Start: use a relevant active lifecycle hit; else call knowl_query with the words that name the subject before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
    modeLine,
    'Manual fallback: knowl task run for one bounded command; resumable work uses knowl_task_start once, knowl_task_checkpoint at milestones or blockers with its taskId, and knowl_task_finish once after verification.',
    'Route by what you need; the tool list names them:',
    '- retrieval: knowl_query first. Recent context only without bootstrap or for a refresh, broad state for status, a packed context only when a token budget is given.',
    '- durable memory: store one verified atom, batch several, record a confirmed decision, a stated goal, or a resolved diagnosis, or correct a stale one. Correct rather than duplicate.',
    '- audit: inspect history, evidence or conflicts when needed; record feedback only after actual use or correction.',
    '- skills: read a matching skill before running a trusted entrypoint; create one only on explicit request.',
    '- special: raw-source ingest only on an explicit request, never silent chat; synthesis only for an explicit scope; preview garbage collection first and apply only after approval.',
    // One bullet for both, because they answer the same routing question -- "where does work I
    // am stopping go?" -- and the distinction between them is the part worth the characters.
    '- leaving work: one baton the next session here consumes once, or a key the user keeps and hands back any time later, from anywhere.',
    ...(options.transcripts ? [TRANSCRIPT_ROUTE_LINE] : []),
    // "Stated intent" is here because its absence was a measured failure, not a style choice:
    // an agent following this card faithfully skipped storing two strategy conversations,
    // because every storage cue said "verified" and a conversation verifies nothing. Intent is
    // durable before it is settled — that is what the goal category and user_stated provenance
    // exist for — and the omission taught agents the opposite. "Resolved diagnoses" joined it
    // after the same failure in a third shape (2026-08-11): a fixed environment trap — the kind
    // that recurs — went unstored because "findings" read as build results, and the next
    // session re-diagnosed it from scratch.
    'During work, store durable findings, stated intent, and resolved diagnoses — a goal counts before it settles; never raw transcripts, secrets, or routine command noise.',
  ].join('\n');
}

export const KNOWL_CLAUDE_OPERATIONAL_CARD = renderCompactKnowlGuidance(KNOWL_CLAUDE_MODE_LINE);
export const KNOWL_MCP_SERVER_INSTRUCTIONS = renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE);

/**
 * The server handshake card for a given project.
 *
 * Returns the shared constant when the feature is off, so the common case allocates nothing and
 * stays byte-identical to what every existing test asserts.
 */
export function mcpServerInstructions(config: ProjectConfig | null): string {
  if (!config || !isTranscriptSearchEnabled(config)) return KNOWL_MCP_SERVER_INSTRUCTIONS;
  return renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE, { transcripts: true });
}
export const KNOWL_CLAUDE_CONTINUATION_REMINDER = 'KNOWL CONTINUATION: Keep the project-memory workflow active. Use relevant active memory. Before entering a new project area, call knowl_query with the words that name the subject before repository files or commands. Store durable findings, stated goals, and recurring diagnoses. Claude hooks own lifecycle; do not start the manual task loop.';

// Short per-prompt reminder (UserPromptSubmit). The full tool routing lives in
// KNOWL.md and the MCP initialize instructions, so the per-prompt card only needs
// the core loop — keeping it ~1/3 the size of the operational card.
export const KNOWL_CLAUDE_PROMPT_REMINDER = [
  'KNOWL — project memory is active.',
  'For any project question or new subtask, call knowl_query BEFORE reading files, using the words that name the subject and no padding; use a relevant active hit directly and inspect files only on a miss, conflict, or stale/low-confidence result.',
  'Store durable decisions, facts, state, constraints, stated goals, and resolved diagnoses as you go with knowl_store / knowl_decide / knowl_update — intent counts before it settles, a recurring cause once fixed; never store secrets or routine noise.',
  'Claude hooks own the lifecycle — do not call knowl_task_start/checkpoint/finish. Full tool routing is in KNOWL.md.',
].join(' ');

/**
 * Guidance delivered with a subagent's bootstrap context.
 *
 * A subagent gets no prompt event, so `KNOWL_CLAUDE_PROMPT_REMINDER` never reaches it,
 * and a live probe confirmed the MCP server `instructions` block does not either. Memory
 * data alone leaves a subagent with nothing telling it to use memory, so this card is the
 * only guidance it ever sees. It avoids referring to KNOWL.md because host instruction
 * files are not loaded into subagent context, and it mentions loading tool schemas because
 * hosts may list memory tools without loading them.
 */
export const KNOWL_SUBAGENT_BOOTSTRAP_CARD = [
  'KNOWL — project memory is active for this subagent.',
  'Before reading repository files, call knowl_query with the words that name the subject and use a relevant active hit directly; inspect files only on a miss, conflict, or stale result.',
  'Store durable findings — including a diagnosis whose cause will recur — with knowl_store or knowl_update before you return; never store secrets or routine noise.',
  'Do not call knowl_task_start/checkpoint/finish — the host session owns the lifecycle.',
  'If a result carries a repo field, that knowledge belongs to that repo and describes it, not necessarily this one.',
  'If the knowl tools are listed but not callable, load their schemas before calling them.',
].join(' ');
