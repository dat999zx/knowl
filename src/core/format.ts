import { KnowledgeItem } from './types.js';

/**
 * Formats a hierarchical knowledge object into clean readable markdown.
 * Shared between MCP server responses and CLI output.
 */
export function formatHierarchyToMarkdown(hierarchy: {
  state: KnowledgeItem[];
  knowledge: KnowledgeItem[];
  skills: KnowledgeItem[];
  archive: KnowledgeItem[];
}): string {
  let md = `# KNOWL — PROJECT BRAIN STATE\n\n`;

  // Goals & Constraints
  const goals = hierarchy.knowledge.filter(x => x.category === 'goal');
  const constraints = hierarchy.knowledge.filter(x => x.category === 'constraint');
  
  md += `## 🎯 GOALS\n\n`;
  if (goals.length === 0) md += `No active goals recorded.\n\n`;
  else goals.forEach(g => { md += `- **${g.title}**: ${g.content}\n`; });
  md += `\n`;

  md += `## ⚠️ CONSTRAINTS\n\n`;
  if (constraints.length === 0) md += `No active constraints recorded.\n\n`;
  else constraints.forEach(c => { md += `- **${c.title}**: ${c.content}\n`; });
  md += `\n`;

  // Active state
  md += `## ⚡ ACTIVE STATE\n\n`;
  if (hierarchy.state.length === 0) md += `No active state updates recorded.\n\n`;
  else {
    hierarchy.state.forEach(s => {
      md += `### ${s.title} (ID: ${s.id})\n${s.content}\n\n`;
    });
  }

  // Decisions & Architecture
  const decisions = hierarchy.knowledge.filter(x => x.category === 'decision');
  const arch = hierarchy.knowledge.filter(x => x.category === 'architecture');
  const facts = hierarchy.knowledge.filter(x => x.category === 'fact');

  md += `## 🏛️ ARCHITECTURE\n\n`;
  if (arch.length === 0) md += `No active architecture specifications.\n\n`;
  else {
    arch.forEach(a => {
      md += `### ${a.title}\n${a.content}\n\n`;
    });
  }

  md += `## 💡 DECISIONS\n\n`;
  if (decisions.length === 0) md += `No active decisions recorded.\n\n`;
  else {
    decisions.forEach(d => {
      md += `### ${d.title} (ID: ${d.id})\n${d.content}\n`;
      if (d.reasoning) md += `**Reasoning:** ${d.reasoning}\n`;
      if (d.alternatives && d.alternatives.length > 0) {
        md += `**Alternatives considered:** ${d.alternatives.join(', ')}\n`;
      }
      md += `\n`;
    });
  }

  md += `## 📋 GENERAL FACTS\n\n`;
  if (facts.length === 0) md += `No general facts recorded.\n\n`;
  else {
    facts.forEach(f => {
      md += `- **${f.title}**: ${f.content}\n`;
    });
    md += `\n`;
  }

  // Learned skills
  md += `## 🛠️ LEARNED SKILLS\n\n`;
  if (hierarchy.skills.length === 0) md += `No skills learned yet.\n\n`;
  else {
    hierarchy.skills.forEach(s => {
      md += `### ${s.title} (ID: ${s.id})\n${s.content}\n\n`;
    });
  }

  return md;
}
