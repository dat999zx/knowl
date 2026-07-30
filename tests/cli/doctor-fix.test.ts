import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { isKnowlProjectGuidanceCurrent } from '../../src/core/agents-guidance.js';
import { applyDoctorRemedies } from '../../src/cli/doctor-fix.js';
import type { DoctorCheck } from '../../src/cli/doctor-report.js';

const ROOT = path.resolve('./.knowl-doctor-fix-repo');

function warn(message: string, remedy?: DoctorCheck['remedy']): DoctorCheck {
  return { status: 'WARN', message, remedy };
}

describe('doctor remedies', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    await repo.createProject(ROOT, 'doctor-fix');
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('rewrites guidance that has drifted', async () => {
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(false);

    const result = await applyDoctorRemedies(ROOT, [warn('guidance stale', { kind: 'guidance' })]);

    expect(result.applied).toEqual(['guidance']);
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
  });

  it('adds the .knowl ignore entry', async () => {
    const result = await applyDoctorRemedies(ROOT, [warn('gitignore missing', { kind: 'gitignore' })]);

    expect(result.applied).toEqual(['gitignore']);
    expect(await fs.readFile(path.join(ROOT, '.gitignore'), 'utf-8')).toMatch(/\.knowl\//);
  });

  it('leaves the vector reindex alone unless it is asked for', async () => {
    // Re-embedding every item is the one remedy whose cost scales with how much the repo
    // knows, so a routine sweep must not decide to pay it.
    const checks = [warn('coverage low', { kind: 'reindex-vectors' })];

    const routine = await applyDoctorRemedies(ROOT, checks);
    expect(routine.applied).toEqual([]);
    expect(routine.deferred).toEqual(['reindex-vectors']);
  });

  it('reports a warning it cannot act on rather than claiming success', async () => {
    // Integrity findings and "store a durable fact" have no safe automatic answer. Silently
    // counting them as handled would make a sweep report READY for a repo that is not.
    const result = await applyDoctorRemedies(ROOT, [
      { status: 'FAIL', message: 'Knowledge integrity audit found 1 error(s)' },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.unfixable).toEqual(['Knowledge integrity audit found 1 error(s)']);
  });

  it('applies each distinct remedy once when several checks ask for the same one', async () => {
    // Both the instructions check and the lifecycle check fail for one host, and running its
    // registration twice is wasted work with a second chance to fail.
    const result = await applyDoctorRemedies(ROOT, [
      warn('guidance stale', { kind: 'guidance' }),
      warn('guidance also stale', { kind: 'guidance' }),
    ]);

    expect(result.applied).toEqual(['guidance']);
  });

  it('keeps going after a remedy fails, and names the one that did', async () => {
    // One unwritable repo must not abandon the remedies that would have worked.
    const result = await applyDoctorRemedies(ROOT, [
      warn('host stale', { kind: 'host-init', host: 'not-a-real-host' }),
      warn('gitignore missing', { kind: 'gitignore' }),
    ]);

    expect(result.applied).toEqual(['gitignore']);
    expect(result.failed.map(entry => entry.remedy)).toEqual(['host-init:not-a-real-host']);
  });
});
