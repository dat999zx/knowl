import { KNOWLEDGE_CATEGORIES, KnowledgeCommit, KnowledgeItem, Project, ProjectConfig } from '../core/types.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { formatWorkspaceBlock } from './workspace-report.js';

const STATUS_LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export function formatStatusReport(input: {
  project: Project;
  config: ProjectConfig;
  activeItems: KnowledgeItem[];
  supersededItems: KnowledgeItem[];
  deprecatedItems: KnowledgeItem[];
  commits: KnowledgeCommit[];
  /** Absent for an unlinked project, which keeps its output byte-identical. */
  workspace?: ActiveWorkspace | null;
}): string {
  const countsByCategory = input.activeItems.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const lines: string[] = [
    STATUS_LINE,
    '🧠 KNOWL REPOSITORY STATUS',
    STATUS_LINE,
    `Repository:     ${input.project.rootPath}`,
    `AI Config:      ${input.config.ai ? `${input.config.ai.provider} (${input.config.ai.model})` : 'not configured'}`,
    STATUS_LINE,
    '📝 KNOWLEDGE ITEMS',
    `  Active:        ${input.activeItems.length}`,
    `  Superseded:    ${input.supersededItems.length}`,
    `  Deprecated:    ${input.deprecatedItems.length}`,
    STATUS_LINE,
    '📊 ACTIVE ITEMS BY CATEGORY',
  ];

  for (const category of KNOWLEDGE_CATEGORIES) {
    lines.push(`  ${category.padEnd(14)}: ${countsByCategory[category] || 0}`);
  }

  lines.push(STATUS_LINE, '🪵  RECENT COMMITS');
  if (input.commits.length === 0) {
    lines.push('  No commits recorded yet.');
  } else {
    for (const commit of input.commits) {
      lines.push(`  [${commit.id}] ${new Date(commit.createdAt).toLocaleString()} - ${commit.message}`);
    }
  }
  lines.push(...formatWorkspaceBlock(input.workspace ?? null));
  lines.push(STATUS_LINE);

  return lines.join('\n');
}
