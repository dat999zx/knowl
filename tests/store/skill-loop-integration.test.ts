import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

const TEST_ROOT = path.resolve('./.knowl-skill-loop-test');
let projectId: string;

/**
 * `claimCapture` fingerprints on the command with a 1.5s window, so a test firing the
 * same command three times in a millisecond would see two of them debounced away. Real
 * repeats are seconds apart; clearing the claim cache reproduces that without a sleep.
 */
const clearCaptureDebounce = () =>
  fs.rm(path.join(TEST_ROOT, '.knowl', 'cache', 'hook-debounce'), { recursive: true, force: true });

const toolEvent = async (sessionId: string, command: string) => {
  await clearCaptureDebounce();
  return handleHostLifecycleEvent(projectId, {
    host: 'claude', event: 'session-event', type: 'command', projectRoot: TEST_ROOT,
    externalSessionId: sessionId, externalTurnId: `${sessionId}-turn`,
    payload: { command, exitCode: 0 }, knowlTool: false,
  } as any);
};

describe('skill capture nudge', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'skill-loop')).id;
  });
  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM memory_session_events`);
    await db.run(sql`DELETE FROM memory_sessions`);
    await db.run(sql`DELETE FROM host_session_bindings`);
  });
  afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('nudges once a qualifying command has repeated enough', async () => {
    const command = 'npm run typecheck 2>&1 | grep "src/store"';
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's1', externalTurnId: 's1-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s1', command);

    const text = JSON.stringify(last?.hostOutput ?? {});
    expect(text).toContain('knowl_skill_create');
  });

  it('does not nudge for a bare command however often it repeats', async () => {
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's2', externalTurnId: 's2-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 6; index++) last = await toolEvent('s2', 'npm test');

    expect(JSON.stringify(last?.hostOutput ?? {})).not.toContain('knowl_skill_create');
  });

  it('never suggests running the captured command', async () => {
    const command = 'rm -rf dist | tee clean.log';
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's3', externalTurnId: 's3-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s3', command);

    expect(JSON.stringify(last?.hostOutput ?? {})).not.toMatch(/run it|execute/i);
  });
});

describe('skills in the session-start card', () => {
  it('lists a runnable skill with its purpose', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const skill = {
      id: 's1', category: 'skill', status: 'active', title: 'verify-bench',
      content: 'File-backed learned skill package at `.knowl/skills/verify-bench/`.\nPurpose: run the benchmark suite and filter its output.',
      source: '.knowl/skills/verify-bench/', confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    } as any;

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills: [skill] }, { maxChars: 4_000 });

    expect(md).toContain('verify-bench');
    expect(md).toContain('run the benchmark suite');
  });

  it('omits the section entirely when there are no skills', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');

    expect(formatRecentContextToMarkdown({ items: [], commits: [] }, { maxChars: 4_000 }))
      .not.toMatch(/available skills/i);
  });

  it('stays inside the character cap it was given', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const skills = Array.from({ length: 60 }, (_, index) => ({
      id: `s${index}`, category: 'skill', status: 'active', title: `skill-${index}`,
      content: `Purpose: ${'p'.repeat(80)}`, source: `.knowl/skills/skill-${index}/`,
      confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    })) as any[];

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills }, { maxChars: 800 });

    expect(md.length).toBeLessThanOrEqual(800);
  });

  it('never spends the skills budget on more than a quarter of the real context cap', async () => {
    // bootstrapAgentSession formats with maxChars: Number.MAX_SAFE_INTEGER and slices the
    // result to DEFAULT_CONTEXT_MAX_CHARS afterwards. A budget derived from that maxChars
    // would be unbounded, and since skills render first they would push recent knowledge
    // out of the card entirely -- the exact regression this section must not cause.
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const { DEFAULT_CONTEXT_MAX_CHARS } = await import('../../src/core/token-budget.js');
    const skills = Array.from({ length: 200 }, (_, index) => ({
      id: `s${index}`, category: 'skill', status: 'active', title: `skill-${index}`,
      content: `Purpose: ${'p'.repeat(80)}`, source: `.knowl/skills/skill-${index}/`,
      confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    })) as any[];

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills }, {
      maxChars: Number.MAX_SAFE_INTEGER,
    });

    const section = md.slice(md.indexOf('## Available skills'), md.indexOf('## Recent Active Knowledge'));
    expect(section.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_MAX_CHARS / 2);
  });
});
