import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResumePoint } from '../../src/store/resume-points.js';
import { closeResumeDb } from '../../src/store/resume-store.js';
import { runCliResume } from '../../src/cli/resume-command.js';

let counter = 0;
let ROOT = '';
let HOME = '';

describe('knowl resume', () => {
  beforeEach(async () => {
    counter += 1;
    ROOT = path.resolve(`./.knowl-cli-resume${counter}`);
    HOME = path.resolve(`./.knowl-cli-resume-home${counter}`);
    process.env.KNOWL_HOME = HOME;
    await closeResumeDb();
    for (const dir of [ROOT, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });

  afterEach(async () => {
    await closeResumeDb();
    delete process.env.KNOWL_HOME;
    for (const dir of [ROOT, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('prints the brief for a key', async () => {
    const point = await createResumePoint(ROOT, { goal: 'Ship the parser' });

    const result = await runCliResume({ projectRoot: ROOT, key: point.key });

    expect(result.kind).toBe('brief');
    expect(result.text).toContain('Ship the parser');
  });

  it('accepts a key pasted with surrounding noise', async () => {
    const point = await createResumePoint(ROOT, { goal: 'Ship the parser' });

    for (const pasted of [`"${point.key.toUpperCase()}"`, `  ${point.key}  `]) {
      const result = await runCliResume({ projectRoot: ROOT, key: pasted });
      expect(result.text).toContain('Ship the parser');
    }
  });

  it('accepts the whole instruction line it minted, pasted into a shell', async () => {
    // resumeInstruction reads "... paste this into any Knowl session: knowl resume k3t9m4",
    // and a user who pastes that into a terminal reaches this command with the key alone --
    // but one who quotes the tail of the line reaches it with the prefix still attached.
    const point = await createResumePoint(ROOT, { goal: 'Ship the parser' });

    const result = await runCliResume({ projectRoot: ROOT, key: `knowl resume ${point.key}` });

    expect(result.text).toContain('Ship the parser');
  });

  it('lists what is parked here when given no key', async () => {
    await createResumePoint(ROOT, { goal: 'Something parked' });

    const result = await runCliResume({ projectRoot: ROOT });

    expect(result.kind).toBe('list');
    expect(result.text).toContain('Something parked');
  });

  it('says nothing is parked rather than printing an empty list', async () => {
    const result = await runCliResume({ projectRoot: ROOT });

    expect(result.kind).toBe('list');
    expect(result.text).toMatch(/nothing is parked/i);
  });

  it('reports an unknown key as a failure the caller can exit non-zero on', async () => {
    const result = await runCliResume({ projectRoot: ROOT, key: 'k3t9m4' });

    expect(result.kind).toBe('unknown-key');
    expect(result.text).toMatch(/no parked workstream/i);
  });

  it('finds a key parked from a different directory', async () => {
    // The whole point of the feature: the key is held by the user, not by a directory.
    const point = await createResumePoint('/somewhere/else', { goal: 'Parked elsewhere' });

    const result = await runCliResume({ projectRoot: ROOT, key: point.key });

    expect(result.text).toContain('Parked elsewhere');
  });

  it('resumes a key even when the caller is not inside a Knowl project at all', async () => {
    // Verified against the built CLI before this was written: parked work stored in a
    // project's own database was unreachable from any other directory, which made the
    // instruction line Knowl hands the user wrong more often than right.
    const point = await createResumePoint('/repo/api', { goal: 'Parked in api' });

    const result = await runCliResume({ key: point.key });

    expect(result.kind).toBe('brief');
    expect(result.text).toContain('Parked in api');
  });

  it('explains itself rather than failing when listing outside a project', async () => {
    const result = await runCliResume({});

    expect(result.kind).toBe('list');
    expect(result.text).toMatch(/not inside a knowl project/i);
  });
});
