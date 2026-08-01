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

const toolEvent = async (sessionId: string, command: string, exitCode = 0) => {
  await clearCaptureDebounce();
  return handleHostLifecycleEvent(projectId, {
    host: 'claude', event: 'session-event', type: 'command', projectRoot: TEST_ROOT,
    externalSessionId: sessionId, externalTurnId: `${sessionId}-turn`,
    payload: { command, exitCode }, knowlTool: false,
  } as any);
};

const sessionStart = (sessionId: string) => handleHostLifecycleEvent(projectId, {
  host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
  externalSessionId: sessionId, externalTurnId: `${sessionId}-turn`, payload: {},
} as any);

/** Every fixture uses the path `skillSourcePath` really writes. */
const saveSkill = (title: string, purpose: string) => repo.createKnowledgeItem(projectId, {
  category: 'skill',
  title,
  content: `File-backed learned skill package at \`.knowl/skills/${title}/SKILL.md\`.\nPurpose: ${purpose}`,
  source: `.knowl/skills/${title}/SKILL.md`,
});

const output = (result: { hostOutput?: unknown } | undefined) => JSON.stringify(result?.hostOutput ?? {});

// File scope, not per-describe: the later suites need the same store, and a `-t` filter
// that skips the first describe would otherwise leave the database uninitialised.
beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  await initDb(TEST_ROOT);
  projectId = (await repo.createProject(TEST_ROOT, 'skill-loop')).id;
});
// Knowledge is cleared too, so no test can depend on a skill a previous one happened to
// leave behind. Children before parents, in case foreign keys are enforced.
beforeEach(async () => {
  const db = getDb() as any;
  await db.run(sql`DELETE FROM memory_session_events`);
  await db.run(sql`DELETE FROM memory_sessions`);
  await db.run(sql`DELETE FROM host_session_bindings`);
  await db.run(sql`DELETE FROM skill_steps`);
  await db.run(sql`DELETE FROM skill_metadata`);
  await db.run(sql`DELETE FROM knowledge_access`);
  await db.run(sql`DELETE FROM knowledge_evidence`);
  await db.run(sql`DELETE FROM knowledge_assertions`);
  await db.run(sql`DELETE FROM knowledge_embeddings`);
  await db.run(sql`DELETE FROM knowledge_items`);
});
afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

describe('skill capture nudge', () => {
  it('nudges on the run that reaches the threshold and stays quiet after it', async () => {
    const command = 'npm run typecheck 2>&1 | grep "src/store"';
    await sessionStart('s1');

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s1', command);
    expect(output(last)).toContain('knowl_skill_create');

    // Run 4 must not re-ask. The agent either saved it or decided not to; repeating the
    // request every run afterwards is what made this nudge unlivable.
    const fourth = await toolEvent('s1', command);
    expect(output(fourth)).not.toContain('knowl_skill_create');
  });

  it('does not nudge for a bare command however often it repeats', async () => {
    await sessionStart('s2');

    let last;
    for (let index = 0; index < 6; index++) last = await toolEvent('s2', 'npm test');

    // The events really landed: without this the absence below could just mean the
    // pipeline never ran.
    const { countCommandRepeats } = await import('../../src/store/skill-capture.js');
    expect(await countCommandRepeats(last!.sessionId!, 'npm test')).toBe(6);
    expect(output(last)).not.toContain('knowl_skill_create');
  });

  it('counts the command asked about and not its neighbours', async () => {
    // The count is a scalar SQL aggregate over json_extract now, so the matching,
    // trimming and case-folding it used to do in JavaScript have to hold in SQL.
    const { countCommandRepeats } = await import('../../src/store/skill-capture.js');
    await sessionStart('s-mix');

    await toolEvent('s-mix', 'npm test');
    await toolEvent('s-mix', 'npm run lint');
    await toolEvent('s-mix', 'npm test');
    // Same command, typed differently. Folding happens on the stored side too, not only
    // on the argument, or these would count as two separate commands.
    const last = await toolEvent('s-mix', '  NPM Test  ');
    const session = last.sessionId!;

    expect(await countCommandRepeats(session, 'npm test')).toBe(3);
    expect(await countCommandRepeats(session, 'npm run lint')).toBe(1);
    expect(await countCommandRepeats(session, '   NPM Test  ')).toBe(3);
    expect(await countCommandRepeats(session, 'npm run build')).toBe(0);
    expect(await countCommandRepeats(session, '')).toBe(0);
  });

  it('does not count failed runs toward the threshold', async () => {
    // A command failing over and over is being debugged, not repeated as a workflow.
    const command = 'npm run build 2>&1 | grep error';
    await sessionStart('s-fail');

    for (let index = 0; index < 2; index++) await toolEvent('s-fail', command, 1);

    // The two failures must not have moved the count: if they had, this first success
    // would be run 3 and would nudge here.
    const firstSuccess = await toolEvent('s-fail', command, 0);
    expect(output(firstSuccess)).not.toContain('knowl_skill_create');
    const secondSuccess = await toolEvent('s-fail', command, 0);
    expect(output(secondSuccess)).not.toContain('knowl_skill_create');

    // The third success is the third run that counts, so the nudge lands here.
    const thirdSuccess = await toolEvent('s-fail', command, 0);
    expect(output(thirdSuccess)).toContain('knowl_skill_create');
  });

  it('never suggests running the captured command', async () => {
    const command = 'rm -rf dist | tee clean.log';
    await sessionStart('s3');

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s3', command);

    // Prove the nudge fired before asserting what it does not say: against a missing
    // nudge the negative assertion below passes while testing nothing.
    const text = output(last);
    expect(text).toContain('knowl_skill_create');
    expect(text).not.toMatch(/run it|execute/i);
  });
});

describe('skills in the session-start card', () => {
  const skillItems = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `s${index}`, category: 'skill', status: 'active', title: `skill-${index}`,
    content: `Purpose: ${'p'.repeat(80)}`, source: `.knowl/skills/skill-${index}/SKILL.md`,
    confidence: 1, freshness: 'fresh', version: 1,
    createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
  })) as any[];

  it('lists a runnable skill with its purpose', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const skill = {
      id: 's1', category: 'skill', status: 'active', title: 'verify-bench',
      content: 'File-backed learned skill package at `.knowl/skills/verify-bench/SKILL.md`.\nPurpose: run the benchmark suite and filter its output.',
      source: '.knowl/skills/verify-bench/SKILL.md', confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    } as any;

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills: [skill] }, { maxChars: 4_000 });

    expect(md).toContain('verify-bench');
    expect(md).toContain('run the benchmark suite');
  });

  it('omits the section entirely when there are no skills', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const md = formatRecentContextToMarkdown({ items: [], commits: [] }, { maxChars: 4_000 });

    // The card was really rendered, so the absence below means the section was skipped
    // rather than the whole document being empty.
    expect(md).toContain('## Recent Active Knowledge');
    expect(md).not.toMatch(/available skills/i);
  });

  it('stays inside the character cap it was given', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills: skillItems(60) }, { maxChars: 800 });
    const section = skillsSection(md);

    expect(md.length).toBeLessThanOrEqual(800);
    // The real constraint, not just the outer cap: a quarter of 800, header included.
    expect(section.length).toBeLessThanOrEqual(Math.floor(800 * 0.25));
    // And it actually spent the budget rather than passing by rendering nothing.
    expect(section).toContain('skill-0');
  });

  it('never spends the skills budget on more than a quarter of the real context cap', async () => {
    // bootstrapAgentSession formats with maxChars: Number.MAX_SAFE_INTEGER and slices the
    // result to DEFAULT_CONTEXT_MAX_CHARS afterwards. A budget derived from that maxChars
    // would be unbounded, and since skills render first they would push recent knowledge
    // out of the card entirely -- the exact regression this section must not cause.
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const { DEFAULT_CONTEXT_MAX_CHARS } = await import('../../src/core/token-budget.js');

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills: skillItems(200) }, {
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    const section = skillsSection(md);

    // The exact budget, not a doubled one that would pass with the clamp removed.
    expect(section.length).toBeLessThanOrEqual(Math.floor(DEFAULT_CONTEXT_MAX_CHARS * 0.25));
    expect(section).toContain('skill-0');
  });
});

/** The skills section alone, with both delimiters proven present rather than assumed. */
function skillsSection(md: string): string {
  const start = md.indexOf('## Available skills');
  const end = md.indexOf('## Recent Active Knowledge');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return md.slice(start, end);
}

describe('session start carries skills', () => {
  it('includes a stored skill in the bootstrap context', async () => {
    await saveSkill('verify-release', 'check publish readiness before tagging.');
    // getRecentContext returns the three most recent items of any category, so a skill can
    // ride into the card on recency alone. These newer facts crowd it out, leaving the
    // dedicated section as the only way it can still appear -- which is the point of this task.
    for (const index of [1, 2, 3]) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: `newer fact ${index}`, content: `Something learned later, ${index}.`,
      });
    }

    const result = await sessionStart('s-skills');
    const section = skillsSection(result.context ?? '');

    expect(section).toContain('verify-release');
    expect(section).toContain('check publish readiness');
  });
});

describe('capture and retrieval share one slot', () => {
  it('stops asking to save a command a saved skill already covers', async () => {
    // The loop only closes if complying silences the nudge. Capture outranks retrieval
    // for a genuinely new workflow, but not for one already on disk.
    await saveSkill('typecheck-filtered', 'run typecheck and filter it.');
    await sessionStart('s-saved');

    const command = 'npm run typecheck-filtered 2>&1 | grep src';
    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s-saved', command);

    const text = output(last);
    expect(text).toContain('knowl_skill_run');
    expect(text).not.toContain('knowl_skill_create');
  });

  it('prefers the capture nudge when no saved skill covers the command', async () => {
    // A skill exists, but not for this command: capture still outranks the drift reminder.
    await saveSkill('typecheck-filtered', 'run typecheck and filter it.');
    await sessionStart('s-prec');

    const command = 'npm run lint 2>&1 | grep src';
    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s-prec', command);

    const text = output(last);
    expect(text).toContain('knowl_skill_create');
    expect(text).not.toContain('knowl_skill_run');
  });

  it('suggests the saved skill when the command does not qualify for capture', async () => {
    await saveSkill('typecheck-filtered', 'run typecheck and filter it.');
    await sessionStart('s-retr');

    // Bare: no pipe, no redirect, no filter, so capture declines and retrieval speaks.
    const last = await toolEvent('s-retr', 'npm run typecheck-filtered');

    expect(output(last)).toContain('knowl_skill_run');
  });

  it('resets the drift counter when a skill nudge takes the slot', async () => {
    // The reminder fires every 12 tool calls that ignored Knowl. A skill nudge occupies
    // the same single slot, so like a change card it must reset the counter -- otherwise
    // the count freezes and the reminder is suppressed for as long as the nudge repeats.
    await saveSkill('typecheck-filtered', 'run typecheck and filter it.');
    await sessionStart('s-drift');

    let last;
    for (let index = 0; index < 11; index++) last = await toolEvent('s-drift', `echo filler-${index}`);
    expect(output(last)).not.toContain('KNOWL CONTINUATION');

    const nudged = await toolEvent('s-drift', 'npm run typecheck-filtered');
    expect(output(nudged)).toContain('knowl_skill_run');

    // With the counter frozen at 11 this next event would be the 12th and fire the
    // reminder. Reset, it is the first of a fresh run.
    const after = await toolEvent('s-drift', 'echo after-nudge');
    expect(output(after)).not.toContain('KNOWL CONTINUATION');
  });
});
