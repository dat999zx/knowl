import type { KnowledgeItem } from './types.js';
import { inlineUntrusted } from './untrusted.js';

export interface SurfacedSkill {
  name: string;
  purpose: string;
  /** True when `knowl_skill_run` can actually execute it -- a file-backed package. */
  runnable: boolean;
  /**
   * The linked repo that owns this skill, for a row that is not this repo's own.
   *
   * Absent for a local skill, and its absence is what the whole rest of the pipeline reads as
   * "local": `renderSkillRow` labels on it and `matchSkillForCommand` will not fire on a row
   * that has it. Set it and the row is a pointer, never a thing to run.
   */
  repo?: string;
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
 *
 * Both fields are stored text, and a skill's name is its item title -- arbitrary. This row
 * renders inside `formatRecentContextToMarkdown`, the bootstrap card injected with no human in
 * the loop, so a title carrying a newline used to reach column 0 there and an `## SYSTEM` or a
 * fence opener at column 0 is live markdown. Containment belongs HERE and not at the call site
 * for the same reason the cost does: `selectSurfacedSkills` prices the budget with
 * `renderSkillRow(skill).length`, so a call site that contained the row afterwards would price
 * one string and emit another. Collapsing only ever shortens, so the budget stays honest.
 */
export function renderSkillRow(skill: SurfacedSkill): string {
  const name = inlineUntrusted(skill.name);
  const purpose = inlineUntrusted(skill.purpose);
  return `- **${name}**${renderSkillTag(skill)} — ${purpose}\n`;
}

/**
 * The parenthetical after a skill's name.
 *
 * A peer row states both facts at once because they are one fact to the reader: it belongs to
 * another repo, and that is *why* it cannot be run from here. "not runnable here" rather than
 * "not runnable" is deliberate -- the skill runs perfectly well in the repo that owns it, and
 * an agent told otherwise would stop looking for the tooling instead of going to find it.
 *
 * Repo names come from the workspace manifest, which is a file on disk like any other stored
 * text, so the name is contained on the same terms as the rest of the row.
 */
function renderSkillTag(skill: SurfacedSkill): string {
  if (skill.repo) return ` (in ${inlineUntrusted(skill.repo)}, not runnable here)`;
  return skill.runnable ? '' : ' (not runnable)';
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
 * A linked repo's shared skills as rows, always as pointers and never as runnables.
 *
 * **`runnable` is forced here rather than derived, and that is the entire point of this
 * function.** `toSurfacedSkills` reads runnability off `source.startsWith('.knowl/skills/')`,
 * and a peer's skill package carries exactly that source -- it is a real package, in a real
 * `.knowl/skills/` directory, just not one under this root. Left to the derivation a peer row
 * would come back `runnable: true`, and two things downstream believe that field: `knowl_skill_run`
 * resolves `readSkillPackage(projectRoot, name)` against the LOCAL root, so the call fails or,
 * worse, runs a same-named local skill instead; and `matchSkillForCommand` filters on it, so a
 * peer row could win the mid-turn slot and tell the agent to run something unreachable.
 *
 * Trust is the deeper reason. `assertSkillApproved` is per-repo: a human approved those exact
 * bytes for that entrypoint *in the repo that owns them*. Running them from here on the strength
 * of a shared row would spend an approval nobody gave.
 *
 * So a peer skill is a pointer, which is all the surfacing needs to be. Knowing the pipeline
 * exists is the whole gap -- an agent that knows can go and read it.
 */
export function toPeerSurfacedSkills(entries: Array<{ repo: string; item: KnowledgeItem }>): SurfacedSkill[] {
  return entries
    .filter(({ item }) => item.category === 'skill' && item.status === 'active')
    .map(({ repo, item }) => ({
      name: item.title,
      purpose: purposeOf(item.content ?? ''),
      runnable: false,
      repo,
    }));
}

/**
 * The skills that fit `maxChars` once rendered, header included.
 *
 * The budget is the whole section's, not the rows' alone: `renderSkillsSection` of the
 * result is guaranteed to be at most `maxChars` characters.
 *
 * **Local first, and peers only with what is left.** A repo's own runnable tooling is the more
 * actionable row and it keeps its place unconditionally, so a store with enough local skills
 * degrades to exactly today's card rather than trading a runnable skill for a pointer.
 */
export function selectSurfacedSkills(
  items: KnowledgeItem[],
  maxChars: number,
  peers: SurfacedSkill[] = [],
): SurfacedSkill[] {
  const kept: SurfacedSkill[] = [];
  // The header and the blank line that closes the section are only paid once, and only
  // if at least one row survives -- an empty section renders as nothing at all.
  let used = SKILLS_SECTION_HEADER.length + 1;
  // A peer sharing a name with a local skill is dropped rather than shown twice: the local one
  // is already rendered, is the one that runs, and is the one `knowl_skill_run` would resolve.
  const localNames = new Set(toSurfacedSkills(items).map((skill) => skill.name.toLowerCase()));
  const ordered = [...toSurfacedSkills(items), ...peers.filter((peer) => !localNames.has(peer.name.toLowerCase()))];
  for (const skill of ordered) {
    const cost = renderSkillRow(skill).length;
    if (used + cost > maxChars) break;
    kept.push(skill);
    used += cost;
  }
  return kept;
}
