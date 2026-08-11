import { describe, expect, it } from 'vitest';
import { matchSkillForCommand, renderSkillUseNudge } from '../../src/store/skill-surface.js';
import { renderSkillsSection, selectSurfacedSkills, toPeerSurfacedSkills } from '../../src/core/skill-surface.js';
import type { KnowledgeItem } from '../../src/core/types.js';

// `skillSourcePath` writes `.knowl/skills/<name>/SKILL.md`, so fixtures say so too: a
// fixture in a shape production never produces cannot defend the check that reads it.
const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'i1', category: 'skill', status: 'active', title: 'a-skill',
  content: 'File-backed learned skill package at `.knowl/skills/a-skill/SKILL.md`.\nPurpose: does a thing.',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
  source: '.knowl/skills/a-skill/SKILL.md', ...over,
} as KnowledgeItem);

describe('selectSurfacedSkills', () => {
  it('extracts the purpose line from a package item', () => {
    const [skill] = selectSurfacedSkills([item({})], 1_000);

    expect(skill).toMatchObject({ name: 'a-skill', purpose: 'does a thing.', runnable: true });
  });

  it('marks a plain memory row as not runnable', () => {
    const rows = selectSurfacedSkills([item({ title: 'plain', source: null, content: 'Ran 3 times.' })], 1_000);

    expect(rows[0].runnable).toBe(false);
  });

  it('puts runnable packages before plain rows', () => {
    const skills = selectSurfacedSkills([
      item({ id: 'i1', title: 'plain', source: null, content: 'no purpose here' }),
      item({ id: 'i2', title: 'runnable' }),
    ], 1_000);

    expect(skills.map((s) => s.name)).toEqual(['runnable', 'plain']);
  });

  it('drops skills that do not fit the budget rather than truncating mid-entry', () => {
    const many = Array.from({ length: 40 }, (_, index) => item({ id: `i${index}`, title: `skill-${index}` }));

    const skills = selectSurfacedSkills(many, 200);

    // Priced against what is actually rendered, header and trailing blank line included.
    expect(renderSkillsSection(skills).length).toBeLessThanOrEqual(200);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThan(40);
  });

  it('charges the header, so a budget that only fits rows keeps nothing', () => {
    // One row of this fixture renders as 30 characters; the header and closing blank line
    // cost 22 more. A budget of 40 fits the row but not the section it would live in.
    const skills = selectSurfacedSkills([item({ title: 'skill-0' })], 40);

    expect(skills).toEqual([]);
  });

  it('prices a non-runnable row higher, because it renders wider', () => {
    const runnable = renderSkillsSection(selectSurfacedSkills([item({ title: 'same-name' })], 1_000));
    const plain = renderSkillsSection(selectSurfacedSkills(
      [item({ title: 'same-name', source: null, content: 'Purpose: does a thing.' })], 1_000));

    expect(plain.length).toBe(runnable.length + ' (not runnable)'.length);
  });

  it('ignores non-skill and non-active items', () => {
    expect(selectSurfacedSkills([
      item({ category: 'fact' }),
      item({ status: 'superseded' }),
    ], 1_000)).toEqual([]);
  });

  it('falls back to the content head when no Purpose line exists', () => {
    const [skill] = selectSurfacedSkills([item({ content: 'Some description with no purpose label.' })], 1_000);

    expect(skill.purpose).toContain('Some description');
  });

  it('returns an empty array for no input rather than throwing', () => {
    expect(selectSurfacedSkills([], 1_000)).toEqual([]);
  });
});

describe('peer skills on the session-start card', () => {
  // The regression this whole path exists to prevent: a peer's package carries the same
  // `.knowl/skills/...` source a local one does, so deriving runnability from `source` marks
  // another repo's skill runnable here -- and `knowl_skill_run` resolves against the local root.
  it('never marks a peer skill runnable, however its source reads', () => {
    const [peer] = toPeerSurfacedSkills([{ repo: 'duckprep', item: item({ title: 'mascot-art' }) }]);

    expect(peer).toMatchObject({ name: 'mascot-art', runnable: false, repo: 'duckprep' });
  });

  it('keeps a peer row out of the mid-turn nudge even if something marks it runnable', () => {
    const forced = { name: 'verify-bench', purpose: 'run the suite', runnable: true, repo: 'duckprep' };

    expect(matchSkillForCommand('npm run verify-bench', [forced])).toBeNull();
  });

  it('names the owning repo in the row, and says the skill is not runnable from here', () => {
    const rendered = renderSkillsSection(toPeerSurfacedSkills([
      { repo: 'duckprep', item: item({ title: 'mascot-art', content: 'Purpose: style-anchored generation.' }) },
    ]));

    expect(rendered).toContain('- **mascot-art** (in duckprep, not runnable here) — style-anchored generation.');
  });

  it('prices the peer label, so the section still fits the budget it was given', () => {
    const peers = toPeerSurfacedSkills(Array.from({ length: 40 }, (_, index) => ({
      repo: 'a-very-long-linked-repository-name',
      item: item({ id: `p${index}`, title: `peer-skill-${index}` }),
    })));

    const skills = selectSurfacedSkills([], 300, peers);

    expect(renderSkillsSection(skills).length).toBeLessThanOrEqual(300);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('orders every local skill ahead of every peer skill', () => {
    const locals = Array.from({ length: 3 }, (_, index) => item({ id: `l${index}`, title: `local-${index}` }));
    const peers = toPeerSurfacedSkills([{ repo: 'duckprep', item: item({ title: 'peer-only' }) }]);

    const skills = selectSurfacedSkills(locals, 1_000, peers);

    expect(skills.findIndex(skill => skill.repo)).toBe(skills.length - 1);
  });

  it("degrades to today's card when local skills already spend the budget", () => {
    // Nine local rows at 30 characters each overrun a 300-character section on their own, so
    // the peer row never reaches the card. A repo rich in its own tooling loses nothing.
    const locals = Array.from({ length: 9 }, (_, index) => item({ id: `l${index}`, title: `local-${index}` }));
    const peers = toPeerSurfacedSkills([{ repo: 'duckprep', item: item({ title: 'peer-only' }) }]);

    const skills = selectSurfacedSkills(locals, 300, peers);

    expect(skills.every(skill => !skill.repo)).toBe(true);
    expect(renderSkillsSection(skills).length).toBeLessThanOrEqual(300);
  });

  it('shows a peer skill when the local store has room for it', () => {
    const peers = toPeerSurfacedSkills([{ repo: 'duckprep', item: item({ title: 'peer-only' }) }]);

    const skills = selectSurfacedSkills([item({ title: 'local-one' })], 1_000, peers);

    expect(skills.map(skill => skill.name)).toEqual(['local-one', 'peer-only']);
  });

  it('drops a peer skill whose name a local skill already occupies', () => {
    const peers = toPeerSurfacedSkills([{ repo: 'duckprep', item: item({ title: 'Shared-Name' }) }]);

    const skills = selectSurfacedSkills([item({ title: 'shared-name' })], 1_000, peers);

    expect(skills).toHaveLength(1);
    expect(skills[0].repo).toBeUndefined();
  });

  it('ignores a peer row that is not an active skill', () => {
    expect(toPeerSurfacedSkills([
      { repo: 'duckprep', item: item({ category: 'fact' }) },
      { repo: 'duckprep', item: item({ status: 'superseded' }) },
    ])).toEqual([]);
  });
});

describe('matchSkillForCommand', () => {
  const skill = { name: 'verify-bench', purpose: 'run the benchmark suite and filter its output', runnable: true };
  const build = { name: 'build', purpose: 'build the project the project way', runnable: true };

  it('matches when the skill name appears in the command', () => {
    expect(matchSkillForCommand('npm run verify-bench --watch', [skill])).toEqual(skill);
  });

  it('does not match an unrelated command', () => {
    expect(matchSkillForCommand('npm test', [skill])).toBeNull();
  });

  it('does not claim a command that merely contains the name as a word', () => {
    // A skill called `build` used to match all of these on a bare substring test.
    expect(matchSkillForCommand('docker build .', [build])).toBeNull();
    expect(matchSkillForCommand('cargo build --release', [build])).toBeNull();
    expect(matchSkillForCommand('npm run rebuild-cache', [build])).toBeNull();
    expect(matchSkillForCommand('git commit -m "build fix"', [build])).toBeNull();
  });

  it('still matches a generic name when it is the command being invoked', () => {
    expect(matchSkillForCommand('build --release', [build])).toEqual(build);
  });

  it('does not match a name buried inside a longer word', () => {
    expect(matchSkillForCommand('npm run verify-bench-extended', [
      { name: 'verify-benc', purpose: 'x', runnable: true },
    ])).toBeNull();
  });

  it('prefers the longest matching name over the first one listed', () => {
    const short = { name: 'deploy-web', purpose: 'deploy the site', runnable: true };
    const long = { name: 'deploy-web-staging', purpose: 'deploy the staging site', runnable: true };

    expect(matchSkillForCommand('npm run deploy-web-staging', [short, long])).toEqual(long);
    expect(matchSkillForCommand('npm run deploy-web-staging', [long, short])).toEqual(long);
  });

  it('never suggests a skill that cannot be run', () => {
    // Pointing an agent at a plain memory row wastes the one mid-turn slot for that
    // event: knowl_skill_run cannot execute it.
    expect(matchSkillForCommand('npm run verify-bench', [{ ...skill, runnable: false }])).toBeNull();
  });

  it('ignores a name too short to be a meaningful match', () => {
    expect(matchSkillForCommand('go build ./...', [{ name: 'go', purpose: 'x', runnable: true }])).toBeNull();
  });

  it('returns null for no skills rather than throwing', () => {
    expect(matchSkillForCommand('anything', [])).toBeNull();
  });
});

describe('renderSkillUseNudge', () => {
  it('names the skill and how to run it', () => {
    const nudge = renderSkillUseNudge({ name: 'verify-bench', purpose: 'run the suite', runnable: true });

    expect(nudge).toContain('verify-bench');
    expect(nudge).toContain('knowl_skill_run');
  });
});
