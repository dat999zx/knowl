import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import {
  createResumePoint,
  listResumePoints,
  readResumePoint,
} from '../../src/store/resume-points.js';

const TEST_ROOT = path.resolve('./.knowl-resume-points-test');

describe('resume points', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await (getDb() as any).run(sql`DELETE FROM resume_points`);
  });

  describe('createResumePoint', () => {
    it('returns a key and stores the brief under it', async () => {
      const point = await createResumePoint('/repo/api', {
        goal: 'Ship the parser', nextAction: 'Wire the CLI flag',
      });

      expect(point.key).toMatch(/^[a-z]\d[a-z]\d[a-z]\d$/);
      expect(point.goal).toBe('Ship the parser');

      const read = await readResumePoint(point.key);
      expect(read?.nextAction).toBe('Wire the CLI flag');
    });

    it('holds several parked workstreams at once, unlike the single session baton', async () => {
      const first = await createResumePoint('/repo/api', { goal: 'First workstream' });
      const second = await createResumePoint('/repo/api', { goal: 'Second workstream' });

      expect(first.key).not.toBe(second.key);
      expect((await readResumePoint(first.key))?.goal).toBe('First workstream');
      expect((await readResumePoint(second.key))?.goal).toBe('Second workstream');
    });

    it('gives every stored point a distinct key even though minting can collide', async () => {
      // The real uniqueness guarantee, and the reason mintResumeKey is not tested for it:
      // collisions are expected at this keyspace and are absorbed by retrying the insert.
      const keys = new Set<string>();
      for (let i = 0; i < 300; i++) {
        keys.add((await createResumePoint('/repo/api', { goal: `Workstream ${i}` })).key);
      }
      expect(keys.size).toBe(300);
    });

    it('round-trips every field of the brief', async () => {
      const point = await createResumePoint('/repo/api', {
        goal: 'Ship the parser',
        completed: ['schema', 'tests'],
        nextAction: 'Wire the CLI flag',
        blocker: 'Waiting on the config shape',
        artifactRefs: ['src/parser.ts'],
        verificationStatus: 'unverified',
        sessionId: 'session-abc',
      });

      const read = await readResumePoint(point.key);
      expect(read).toMatchObject({
        completed: ['schema', 'tests'],
        blocker: 'Waiting on the config shape',
        artifactRefs: ['src/parser.ts'],
        verificationStatus: 'unverified',
        sessionId: 'session-abc',
      });
    });
  });

  describe('readResumePoint', () => {
    it('finds a key regardless of which directory it is pasted into', async () => {
      const point = await createResumePoint('/repo/api', { goal: 'Parked in api' });

      // No project argument at all: a key works from anywhere, which is the point.
      expect((await readResumePoint(point.key))?.goal).toBe('Parked in api');
    });

    it('accepts the key however the user pastes it', async () => {
      const point = await createResumePoint('/repo/api', { goal: 'Parked' });

      for (const variant of [point.key.toUpperCase(), `  ${point.key}  `, `knowl resume ${point.key}`]) {
        expect((await readResumePoint(variant))?.goal).toBe('Parked');
      }
    });

    it('resumes more than once, because work gets picked up and parked again', async () => {
      const point = await createResumePoint('/repo/api', { goal: 'Parked' });

      expect(await readResumePoint(point.key)).not.toBeNull();
      expect(await readResumePoint(point.key)).not.toBeNull();
    });

    it('returns nothing for an unknown key rather than the nearest match', async () => {
      await createResumePoint('/repo/api', { goal: 'Parked' });

      expect(await readResumePoint('k3t9m4')).toBeNull();
      expect(await readResumePoint('not-a-key')).toBeNull();
    });
  });

  describe('listResumePoints', () => {
    it('lists what is parked in this project, newest first', async () => {
      await createResumePoint('/repo/api', { goal: 'Older' });
      await createResumePoint('/repo/api', { goal: 'Newer' });
      await createResumePoint('/repo/web', { goal: 'Elsewhere' });

      const points = await listResumePoints('/repo/api');

      expect(points.map(p => p.goal)).toEqual(['Newer', 'Older']);
    });

    it('orders points parked in the same millisecond deterministically', async () => {
      // createdAt is an ISO string, so several parks in one tick share it exactly. Ordering by
      // that alone returns them in whatever order the engine chose.
      const goals = ['first', 'second', 'third', 'fourth'];
      for (const goal of goals) await createResumePoint('/repo/same-tick', { goal });

      const once = (await listResumePoints('/repo/same-tick')).map(p => p.goal);
      const twice = (await listResumePoints('/repo/same-tick')).map(p => p.goal);

      expect(once).toEqual(twice);
      expect(once[0]).toBe('fourth');
    });

    it('returns an empty list when nothing is parked here', async () => {
      expect(await listResumePoints('/repo/empty')).toEqual([]);
    });
  });
});
