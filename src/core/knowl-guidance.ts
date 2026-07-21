export const KNOWL_GUIDANCE_START_MARKER = '<!-- KNOWL_PROJECT_MEMORY -->';
export const KNOWL_GUIDANCE_END_MARKER = '<!-- /KNOWL_PROJECT_MEMORY -->';

export const KNOWL_MCP_TOOL_GROUPS = [
  {
    label: 'Focused retrieval',
    tools: ['knowl_query'],
    routing: 'Default first call for a specific project request and again when switching areas. Use 2-6 keywords and omit category unless certain.',
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
] as const;

export type KnowlMcpToolName = typeof KNOWL_MCP_TOOL_GROUPS[number]['tools'][number];

export const KNOWL_MCP_TOOL_NAMES = KNOWL_MCP_TOOL_GROUPS
  .flatMap(group => [...group.tools]) as KnowlMcpToolName[];

const REQUIRED_WORKFLOW = `### Required workflow

1. For every project-specific request, call \`knowl_query\` with 2-6 concise keywords before repository files or commands.
2. Skip a new query only when directly relevant active lifecycle context, a same-request query, or manual \`knowl_task_start\` relevant memory already answers it.
3. Use a relevant active hit immediately. Inspect files only after a miss, conflict, stale/low-confidence memory, or explicit verification request.
4. Query again before switching to a distinct subtask or project area.
5. Store or update verified durable findings during work and before the final answer; never store raw transcripts, secrets, or debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.`;

const LIFECYCLE_MODES = `### Lifecycle modes

- **Automatic host lifecycle:** verified hooks own bootstrap, capture, checkpoints, and finalization. Never call \`knowl_task_start\`, \`knowl_task_checkpoint\`, \`knowl_task_finish\`, or \`knowl_session_finish\` for that hook-owned session.
- **Manual work loop:** without verified hooks, use \`knowl task run\` for one bounded command. For resumable work, start once, checkpoint meaningful milestones/blockers with the returned task ID, and finish exactly once after verification. The start result satisfies the initial focused lookup.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.`;

const SAFETY = `### Safety and freshness

- Correct stale or contradicted memory with \`knowl_update\` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- \`Auth: Unsupported\` is normal for a local stdio MCP server when the focused retrieval tool is listed.`;

export function renderFullKnowlGuidance(): string {
  const table = [
    '| Group | Tools | Routing |',
    '| --- | --- | --- |',
    ...KNOWL_MCP_TOOL_GROUPS.map(group =>
      `| ${group.label} | ${group.tools.map(tool => `\`${tool}\``).join(', ')} | ${group.routing} |`),
  ].join('\n');
  return ['## Knowl Project Memory', REQUIRED_WORKFLOW, LIFECYCLE_MODES, `### Complete MCP tool routing\n\n${table}`, SAFETY].join('\n\n');
}

export function renderManagedKnowlGuidanceSection(): string {
  return `${KNOWL_GUIDANCE_START_MARKER}\n${renderFullKnowlGuidance()}\n${KNOWL_GUIDANCE_END_MARKER}\n`;
}

export const KNOWL_CLAUDE_MODE_LINE = 'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.';
export const KNOWL_HOST_NEUTRAL_MODE_LINE = 'Mode: verified hooks, when active, own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active; otherwise use the manual fallback.';

function renderCompactKnowlGuidance(modeLine: string): string {
  return [
    'KNOWL WORKFLOW - for project work.',
    'Start: use a relevant active lifecycle hit; else call knowl_query with 2-6 keywords before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
    modeLine,
    'Manual fallback: one bounded command uses knowl task run; resumable work uses knowl_task_start once, knowl_task_checkpoint at meaningful milestones/blockers with its taskId, and knowl_task_finish once after verification.',
    'Route:',
    '- retrieval: knowl_query; knowl_recent only without bootstrap or for refresh; knowl_state for broad state; knowl_context for a token-budgeted pack.',
    '- durable memory: knowl_store one atom; knowl_ingest_atoms a batch; knowl_decide a confirmed choice; knowl_update a stale or contradicted item.',
    '- audit: knowl_timeline, knowl_evidence_list, knowl_conflicts; knowl_feedback after actual use or correction.',
    '- skills: knowl_skill_list, knowl_skill_read, knowl_skill_run only for a trusted matching entrypoint; knowl_skill_create only when explicitly requested.',
    '- special: knowl_ingest only for explicit raw-source ingestion, never silent chat; knowl_synthesize only for an explicit scope; knowl_session_finish only for an explicitly owned manual session; knowl_gc_preview before maintenance; knowl_gc_apply only after preview and explicit approval.',
    'During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.',
  ].join('\n');
}

export const KNOWL_CLAUDE_OPERATIONAL_CARD = renderCompactKnowlGuidance(KNOWL_CLAUDE_MODE_LINE);
export const KNOWL_MCP_SERVER_INSTRUCTIONS = renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE);
export const KNOWL_CLAUDE_CONTINUATION_REMINDER = 'KNOWL CONTINUATION: Keep the project-memory workflow active. Use relevant active memory. Before entering a new project area, call knowl_query with 2-6 keywords before repository files or commands. Store or update verified durable findings. Claude hooks own lifecycle; do not start the manual task loop.';
