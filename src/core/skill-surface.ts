import type { KnowledgeItem } from './types.js';

export interface SurfacedSkill {
  name: string;
  purpose: string;
  /** True when `knowl_skill_run` can actually execute it -- a file-backed package. */
  runnable: boolean;
}

/** How much of a purpose line is worth showing. */
const MAX_PURPOSE_CHARS = 90;

/** `indexSkillPackage` writes `Purpose: <one sentence>` as the second line. */
function purposeOf(content: string): string {
  const line = content.split('\n').map((row) => row.trim()).find((row) => /^purpose:/i.test(row));
  const text = line ? line.replace(/^purpose:\s*/i, '') : content.split('\n')[0] ?? '';
  return text.slice(0, MAX_PURPOSE_CHARS).trim();
}

/** The exact header the session-start card renders above the skill rows. */
export const SKILLS_SECTION_HEADER = '## Available skills\n\n';

/**
 * The exact line one skill renders as.
 *
 * Selection and rendering read the cost from this one function so they cannot drift:
 * charging `name: purpose` while rendering `- **name** — purpose` under-counted every
 * row by 10 characters, and every non-runnable row by 25.
 */
export function renderSkillRow(skill: SurfacedSkill): string {
  return `- **${skill.name}**${skill.runnable ? '' : ' (not runnable)'} — ${skill.purpose}\n`;
}

/** The whole section, header and trailing blank line included, or '' for no skills. */
export function renderSkillsSection(skills: SurfacedSkill[]): string {
  if (skills.length === 0) return '';
  return `${SKILLS_SECTION_HEADER}${skills.map(renderSkillRow).join('')}\n`;
}

/**
 * Every active skill item as a surfaced row, unbudgeted and in input order.
 *
 * Matching must see all of them: clipping the candidate list to a character budget
 * would hide a freshly saved skill behind older ones and re-open the capture nudge
 * that saving it was supposed to close.
 */
export function toSurfacedSkills(items: KnowledgeItem[]): SurfacedSkill[] {
  const eligible = items
    .filter((candidate) => candidate.category === 'skill' && candidate.status === 'active')
    .map((candidate) => ({
      name: candidate.title,
      purpose: purposeOf(candidate.content ?? ''),
      // Only a file-backed package is reachable by knowl_skill_run; a plain row is not,
      // so pointing an agent at one wastes the reader's attention.
      runnable: typeof candidate.source === 'string' && candidate.source.startsWith('.knowl/skills/'),
    }));

  // Runnable first, then original order within each group.
  return [...eligible.filter((s) => s.runnable), ...eligible.filter((s) => !s.runnable)];
}

/**
 * The skills that fit `maxChars` once rendered, header included.
 *
 * The budget is the whole section's, not the rows' alone: `renderSkillsSection` of the
 * result is guaranteed to be at most `maxChars` characters.
 */
export function selectSurfacedSkills(items: KnowledgeItem[], maxChars: number): SurfacedSkill[] {
  const kept: SurfacedSkill[] = [];
  // The header and the blank line that closes the section are only paid once, and only
  // if at least one row survives -- an empty section renders as nothing at all.
  let used = SKILLS_SECTION_HEADER.length + 1;
  for (const skill of toSurfacedSkills(items)) {
    const cost = renderSkillRow(skill).length;
    if (used + cost > maxChars) break;
    kept.push(skill);
    used += cost;
  }
  return kept;
}
