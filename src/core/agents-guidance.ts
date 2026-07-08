import fs from 'node:fs/promises';
import path from 'node:path';

export type AgentsGuidanceInstallStatus = 'created' | 'updated' | 'unchanged';

const KNOWL_AGENTS_SECTION_MARKER = '<!-- KNOWL_PROJECT_MEMORY -->';
const KNOWL_AGENTS_SECTION_END_MARKER = '<!-- /KNOWL_PROJECT_MEMORY -->';
const KNOWL_AGENTS_SECTION = `${KNOWL_AGENTS_SECTION_MARKER}
## Knowl Project Memory

- At the start of a new project-specific session, call \`knowl_recent\` first to load recent active knowledge and knowledge commits before inspecting files or editing code.
- After \`knowl_recent\`, use \`knowl_query\` for specific questions. Use 2-6 concise search keywords from the user's question, not the whole question text.
- Do not use \`knowl_ask\` for MCP first-pass lookup. MCP agents already have a model; use \`knowl_recent\` and \`knowl_query\` for retrieval.
- Omit category filters unless you are certain; an over-specific category can hide the correct memory item.
- If the Knowl MCP tools are unavailable, stop and tell the user that Knowl MCP is not configured instead of silently inspecting the repository.
- \`Auth: Unsupported\` on a local stdio MCP server is normal and does not mean Knowl is unavailable when \`knowl_query\` is listed.
- Do not inspect repository files before this Knowl lookup. If Knowl has a relevant active answer, use it and cite that it came from Knowl.
- If \`knowl_query\` returns a relevant active item, answer from Knowl immediately.
- Do not inspect repository files just to re-verify known facts already found in Knowl.
- Only inspect repository files when Knowl misses, conflicts, looks stale or low-confidence, or the user asks for source verification.
- Only use \`knowl_state\` for broad project-memory summaries, status checks, or when the user asks for the full current state.
- Learned executable skills live under \`.knowl/skills/<name>/\` with \`SKILL.md\`, \`skill.json\`, and optional scripts. Use \`knowl_skill_list\`, \`knowl_skill_read\`, and \`knowl_skill_run\` to discover, inspect, and auto-run them.
- Do not expect one MCP tool per learned skill. The fixed \`knowl_skill_*\` tools scan \`.knowl/skills\` dynamically, so newly created skills are usable in old sessions without an MCP tool reload.
- Prefer learned skill scripts stored inside \`.knowl/skills/<name>/\`; shell fallback entrypoints are allowed when the skill defines them.
- During work, keep Knowl current. If new findings contradict or replace existing memory, use \`knowl_update\` to correct stale or superseded items instead of adding duplicates.
- For multi-step tasks, do not wait until the end to use Knowl. Before each new subtask or when switching areas, run a focused \`knowl_query\` for relevant prior decisions, constraints, facts, or current state.
- After each completed subtask or newly verified durable finding, update Knowl immediately with \`knowl_store\`, \`knowl_decide\`, \`knowl_ingest_atoms\`, or \`knowl_update\` before continuing. If later subtasks depend on new memory you just stored, query Knowl again before continuing.
- When the user confirms a durable fact, decision, constraint, architecture detail, current state, or reusable skill, save it to Knowl using \`knowl_store\`, \`knowl_decide\`, or \`knowl_ingest_atoms\`.
- After discovering and verifying durable project knowledge from repository files, store it in Knowl using \`knowl_store\` or \`knowl_ingest_atoms\` before giving the final answer, but only when the initial \`knowl_query\` did not already return the same knowledge.
- Before the final answer, check whether the work produced durable knowledge: implemented feature summaries, setup steps, architecture changes, important commands, decisions, constraints, recurring bugs, gotchas, and verified project facts. Store useful outcomes in Knowl before responding.
- Store durable knowledge as concise structured atoms, not raw chat transcripts. Use raw conversation only as optional source/evidence when it is useful.
- Do not store temporary debugging noise, failed attempts, secrets, credentials, or speculative ideas unless the user explicitly says they are durable project knowledge.
- Prefer current active Knowl state over stale conversation memory when answering questions about this project.
${KNOWL_AGENTS_SECTION_END_MARKER}
`;

export async function installKnowlAgentsGuidance(projectRoot: string): Promise<AgentsGuidanceInstallStatus> {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');

  try {
    const existing = await fs.readFile(agentsPath, 'utf-8');
    if (existing.includes(KNOWL_AGENTS_SECTION_MARKER)) {
      if (existing.includes(KNOWL_AGENTS_SECTION) && existing.includes(KNOWL_AGENTS_SECTION_END_MARKER)) {
        return 'unchanged';
      }

      const start = existing.indexOf(KNOWL_AGENTS_SECTION_MARKER);
      const end = existing.indexOf(KNOWL_AGENTS_SECTION_END_MARKER, start);
      const replacementEnd = end >= 0 ? end + KNOWL_AGENTS_SECTION_END_MARKER.length : existing.length;
      const before = existing.slice(0, start).trimEnd();
      const after = existing.slice(replacementEnd).trimStart();
      const updated = [before, KNOWL_AGENTS_SECTION.trimEnd(), after].filter(Boolean).join('\n\n') + '\n';
      await fs.writeFile(agentsPath, updated, 'utf-8');
      return 'updated';
    }

    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    await fs.writeFile(agentsPath, `${existing}${separator}${KNOWL_AGENTS_SECTION}`, 'utf-8');
    return 'updated';
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await fs.writeFile(agentsPath, `# Agent Instructions\n\n${KNOWL_AGENTS_SECTION}`, 'utf-8');
    return 'created';
  }
}

export async function isKnowlAgentsGuidanceCurrent(projectRoot: string): Promise<boolean> {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');

  try {
    const existing = await fs.readFile(agentsPath, 'utf-8');
    return existing.includes(KNOWL_AGENTS_SECTION) && existing.includes(KNOWL_AGENTS_SECTION_END_MARKER);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
