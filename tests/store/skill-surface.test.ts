import { describe, expect, it } from 'vitest';
import { selectSurfacedSkills } from '../../src/store/skill-surface.js';
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
