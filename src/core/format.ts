import { KnowledgeCommit, KnowledgeItem } from './types.js';
import { DEFAULT_CONTEXT_MAX_CHARS, MAX_ITEM_CONTENT_CHARS, truncateText } from './token-budget.js';

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
  const maxItemChars = options.maxItemChars ?? MAX_ITEM_CONTENT_CHARS;
  const itemText = (value: string) => truncateText(value, maxItemChars);
  let md = `# KNOWL — PROJECT BRAIN STATE\n\n`;

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
      md += `${itemText(s.title).padEnd(20)} = ${itemText(s.content)}\n`;
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
      md += `### ${itemText(a.title)}\n${itemText(a.content)}\n\n`;
    });
  }

  md += `## 💡 DECISIONS\n\n`;
  if (decisions.length === 0) md += `No active decisions recorded.\n\n`;
  else {
    decisions.forEach(d => {
      md += `### ${itemText(d.title)} (ID: ${d.id})\n${itemText(d.content)}\n`;
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
      md += `### ${itemText(s.title)} (ID: ${s.id})\n${itemText(s.content)}\n\n`;
    });
  }

  return md.length <= maxChars ? md : truncateText(md, maxChars, '[Context truncated]');
}

export function formatRecentContextToMarkdown(context: {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
}, options: { maxChars?: number; maxItemChars?: number; includeTags?: boolean; includeCommitDetails?: boolean } = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const maxItemChars = options.maxItemChars ?? MAX_ITEM_CONTENT_CHARS;
  let md = '# KNOWL - RECENT SESSION CONTEXT\n\n';

  md += '## Recent Active Knowledge\n\n';
  if (context.items.length === 0) {
    md += 'No recent active knowledge recorded.\n\n';
  } else {
    for (const item of context.items) {
      md += `- **${item.title}** (${item.category}, updated ${item.updatedAt})\n`;
      md += `  ${truncateText(item.content, maxItemChars)}\n`;
      if (options.includeTags && item.tags && item.tags.length > 0) {
        md += `  Tags: ${item.tags.join(', ')}\n`;
      }
    }
    md += '\n';
  }

  md += '## Recent Knowledge Commits\n\n';
  if (context.commits.length === 0) {
    md += 'No recent knowledge commits recorded.\n';
  } else {
    for (const commit of context.commits) {
      md += `- ${commit.createdAt}: ${commit.message}\n`;
      if (options.includeCommitDetails && commit.changes.length > 0) md += `  Changes: ${commit.changes.length}\n`;
    }
  }

  return md.length <= maxChars ? md : truncateText(md, maxChars, '[Context truncated]');
}
