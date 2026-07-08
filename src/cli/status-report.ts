import { KnowledgeCategory, KnowledgeCommit, KnowledgeItem, Project, ProjectConfig } from '../core/types.js';

const STATUS_LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const CATEGORIES: KnowledgeCategory[] = ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'];

export function formatStatusReport(input: {
  project: Project;
  config: ProjectConfig;
  activeItems: KnowledgeItem[];
  supersededItems: KnowledgeItem[];
  deprecatedItems: KnowledgeItem[];
  commits: KnowledgeCommit[];
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

  for (const category of CATEGORIES) {
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
  lines.push(STATUS_LINE);

  return lines.join('\n');
}
