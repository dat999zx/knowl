import fs from 'node:fs/promises';
import path from 'node:path';

export type AgentsGuidanceInstallStatus = 'created' | 'updated' | 'unchanged';

const KNOWL_AGENTS_SECTION_MARKER = '<!-- KNOWL_PROJECT_MEMORY -->';
const KNOWL_AGENTS_SECTION_END_MARKER = '<!-- /KNOWL_PROJECT_MEMORY -->';
const KNOWL_AGENTS_SECTION = `${KNOWL_AGENTS_SECTION_MARKER}
## Knowl Project Memory

- For specific project questions, call \`knowl_query\` first. Use 2-6 concise search keywords from the user's question, not the whole question text.
- If the Knowl MCP tools are unavailable, stop and tell the user that Knowl MCP is not configured instead of silently inspecting the repository.
- \`Auth: Unsupported\` on a local stdio MCP server is normal and does not mean Knowl is unavailable when \`knowl_query\` is listed.
- Do not inspect repository files before this targeted Knowl query. If Knowl has a relevant active answer, use it and cite that it came from Knowl.
- Only use \`knowl_state\` for broad project-memory summaries, status checks, or when the user asks for the full current state.
- When the user confirms a durable fact, decision, constraint, architecture detail, current state, or reusable skill, save it to Knowl using \`knowl_store\`, \`knowl_decide\`, or \`knowl_ingest_atoms\`.
- After discovering and verifying durable project knowledge from repository files, store it in Knowl using \`knowl_store\` or \`knowl_ingest_atoms\` before giving the final answer, but only when the initial \`knowl_query\` did not already return the same knowledge.
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
