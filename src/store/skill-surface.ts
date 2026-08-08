import type { SurfacedSkill } from '../core/skill-surface.js';
import { inlineUntrusted } from '../core/untrusted.js';

export type { SurfacedSkill };

/** Below this, a name is too generic to match on -- `go`, `cd`, `rm`. */
const MIN_MATCHABLE_NAME_CHARS = 4;

/** Names are `[a-z0-9][a-z0-9_-]*`, so only these characters can extend one. */
const NAME_CHAR = 'a-z0-9_';

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `name` appears in `haystack` at a word boundary rather than buried inside a
 * longer word. A plain `includes` let a skill called `build` claim `rebuild-cache`.
 */
function appearsAsWord(haystack: string, name: string): boolean {
  return new RegExp(`(?<![${NAME_CHAR}])${escapeForRegex(name)}(?![${NAME_CHAR}])`).test(haystack);
}

/**
 * A name with no separator in it is an ordinary English word -- `build`, `check`, `clean`
 * -- and appears in commands that have nothing to do with the skill: `docker build`,
 * `cargo build`, `git commit -m "build fix"`. Such a name only counts when it is the
 * command actually being invoked. A separator (`deploy-web`, `verify_bench`) is specific
 * enough to match anywhere in the command.
 *
 * A word boundary alone does not rescue those three cases -- `build` sits at a boundary
 * in every one of them -- which is why specificity is checked as well.
 */
function isSpecificEnough(command: string, name: string): boolean {
  if (/[-_]/.test(name)) return true;
  return command.trim().split(/\s+/)[0]?.toLowerCase() === name;
}

export function matchSkillForCommand(command: string, skills: SurfacedSkill[]): SurfacedSkill | null {
  const haystack = command.toLowerCase();
  const matches = skills.filter((skill) => {
    const name = skill.name.toLowerCase();
    return skill.runnable
      && name.length >= MIN_MATCHABLE_NAME_CHARS
      && appearsAsWord(haystack, name)
      && isSpecificEnough(haystack, name);
  });
  if (matches.length === 0) return null;
  // Longest name wins: `deploy-web` and `deploy-web-staging` both match
  // `npm run deploy-web-staging`, and the more specific one is the one meant.
  return matches.reduce((best, skill) => (skill.name.length > best.name.length ? skill : best));
}

/**
 * The mid-turn nudge, and the same containment rule as `renderSkillRow`.
 *
 * A nudge is a stronger surface than the card, not a weaker one: it arrives unprompted in the
 * middle of a turn, next to a command the agent is already about to run. Both fields are stored
 * text, so both are collapsed to one line before they get there.
 */
export function renderSkillUseNudge(skill: SurfacedSkill): string {
  return [
    `KNOWL: a saved skill covers this — **${inlineUntrusted(skill.name)}**: ${inlineUntrusted(skill.purpose)}`,
    'Run it with knowl_skill_run if it fits what you are doing.',
  ].join('\n');
}
