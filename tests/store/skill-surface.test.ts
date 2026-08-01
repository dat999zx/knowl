import { describe, expect, it } from 'vitest';
import { matchSkillForCommand, renderSkillUseNudge, selectSurfacedSkills } from '../../src/store/skill-surface.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'i1', category: 'skill', status: 'active', title: 'a-skill',
  content: 'File-backed learned skill package at `.knowl/skills/a-skill/`.\nPurpose: does a thing.',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
  source: '.knowl/skills/a-skill/', ...over,
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
    const rendered = skills.map((s) => `${s.name}: ${s.purpose}`).join('\n');

    expect(rendered.length).toBeLessThanOrEqual(200);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThan(40);
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

describe('matchSkillForCommand', () => {
  const skill = { name: 'verify-bench', purpose: 'run the benchmark suite and filter its output', runnable: true };

  it('matches when the skill name appears in the command', () => {
    expect(matchSkillForCommand('npm run verify-bench --watch', [skill])).toEqual(skill);
  });

  it('does not match an unrelated command', () => {
    expect(matchSkillForCommand('npm test', [skill])).toBeNull();
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
