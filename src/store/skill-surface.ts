import type { KnowledgeItem } from '../core/types.js';

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

export function selectSurfacedSkills(items: KnowledgeItem[], maxChars: number): SurfacedSkill[] {
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
  const ordered = [...eligible.filter((s) => s.runnable), ...eligible.filter((s) => !s.runnable)];

  const kept: SurfacedSkill[] = [];
  let used = 0;
  for (const skill of ordered) {
    const cost = `${skill.name}: ${skill.purpose}`.length + 1;
    if (used + cost > maxChars) break;
    kept.push(skill);
    used += cost;
  }
  return kept;
}

/** Below this, a name is too generic to match on -- `go`, `cd`, `rm`. */
const MIN_MATCHABLE_NAME_CHARS = 4;

export function matchSkillForCommand(command: string, skills: SurfacedSkill[]): SurfacedSkill | null {
  const haystack = command.toLowerCase();
  return skills.find((skill) =>
    skill.runnable
    && skill.name.length >= MIN_MATCHABLE_NAME_CHARS
    && haystack.includes(skill.name.toLowerCase())) ?? null;
}

export function renderSkillUseNudge(skill: SurfacedSkill): string {
  return [
    `KNOWL: a saved skill covers this — **${skill.name}**: ${skill.purpose}`,
    'Run it with knowl_skill_run if it fits what you are doing.',
  ].join('\n');
}
