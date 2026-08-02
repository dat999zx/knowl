import { getClient } from './database.js';
import { normalizeProjectDir } from './project-dir.js';

// A named, re-usable resume point: park a workstream, get a short key, and hand
// that key to any future session to pick the work up exactly where it stopped.
//
// The existing session handoff is a one-shot baton - one per project, delivered
// automatically to whoever starts next, then archived. That is the right shape
// for "I am stopping, someone continue", and the wrong shape for "I have three
// workstreams parked and I want THAT one now". This is the second shape:
// addressable, persistent, and resumable more than once.
//
// The brief is deliberately THIN and carries the session id. Semantic transcript
// search covers the whole archive, so the resuming agent can read the original
// conversation for any detail the brief left out. A fat brief goes stale the
// moment the work moves; a pointer into a searchable transcript does not.

export interface ResumeBrief {
  goal: string;
  nextAction: string;
  completed?: string[];
  blocker?: string;
  verificationStatus?: string;
  artifactRefs?: string[];
  sessionId?: string;
}

export interface ResumePoint {
  key: string;
  projectDir: string;
  brief: ResumeBrief;
  createdAt: string;
  lastResumedAt: string | null;
  resumeCount: number;
}

/**
 * The key is MINTED, never chosen, and always contains a digit.
 *
 * Both properties exist to stop a key from reading as an instruction. A key the
 * user picks would be something like `fix-login-bug`, and a fresh session
 * receiving that has no reason to treat it as a lookup - it would simply start
 * fixing a login bug. An opaque token has no competing interpretation, so the
 * only sensible move left to the model is to go and find out what it refers to.
 *
 * Randomness alone does not guarantee that: six draws from a letters-and-digits
 * alphabet can legitimately spell `budget` or `answer`, which lands straight
 * back in the failure the design is avoiding. Forcing at least one digit makes
 * a word structurally impossible, at a trivial cost in entropy.
 *
 * The alphabet also omits every character people transcribe wrongly from a
 * screen: no 0/O, no 1/I/L. 23 letters and 8 digits over six characters is ~887
 * million combinations - far past any plausible number of parked workstreams,
 * and still short enough to retype from a screenshot.
 */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const KEY_LENGTH = 6;

function mintKey(): string {
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(DIGITS)];
  while (chars.length < KEY_LENGTH) chars.push(pick(LETTERS + DIGITS));

  // The guaranteed digit must not always sit first, or every key looks alike and
  // the position leaks that it was special-cased.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Accepts what a person actually pastes: bare, prefixed, spaced, or shouted.
 *
 * Separators go first, then each label is stripped on its own — `knowl:x`,
 * `resume x` and `knowl/resume/x` are all things a user will type, and a single
 * pattern expecting both labels together silently mangles the first two.
 */
export function normalizeKey(raw: string): string {
  let key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const label of ['knowl', 'resume']) {
    if (key.startsWith(label) && key.length > label.length) key = key.slice(label.length);
  }
  return key;
}

/**
 * The line a user pastes into a fresh session.
 *
 * A bare key depends on the receiving model choosing to investigate an opaque
 * token. That is usually enough - the token has no other sensible reading - but
 * "usually" is the wrong standard for the one message whose whole job is to not
 * be misread. Naming the action and the tool removes the guess entirely, and
 * still works in a session that never read knowl's tool descriptions.
 */
export function resumeInstruction(key: string): string {
  return `Continue the parked workstream with key ${key} — use the knowl memory MCP (knowl_resume).`;
}

export async function createResumePoint(projectDir: string, brief: ResumeBrief): Promise<ResumePoint> {
  const client = getClient();
  const dir = normalizeProjectDir(projectDir);
  const createdAt = new Date().toISOString();

  // Retry on the astronomically unlikely collision rather than pretend it cannot happen.
  for (let attempt = 0; ; attempt++) {
    const key = mintKey();
    try {
      await client.execute({
        sql: `INSERT INTO resume_points (key, project_dir, brief, created_at, last_resumed_at, resume_count)
              VALUES (?, ?, ?, ?, NULL, 0)`,
        args: [key, dir, JSON.stringify(brief), createdAt],
      });
      return { key, projectDir: dir, brief, createdAt, lastResumedAt: null, resumeCount: 0 };
    } catch (error) {
      if (attempt >= 4 || !/UNIQUE|CONSTRAINT/i.test(String((error as Error).message))) throw error;
    }
  }
}

/**
 * Look up a key and record that it was used.
 *
 * Deliberately NOT consumed: the same workstream can be picked up on Monday,
 * parked again, and picked up on Wednesday. A one-shot key would make resuming
 * twice an error, which is not how work behaves.
 *
 * The project is not part of the lookup. A key is unique on its own, and someone
 * pasting one into the wrong directory means to go to the work, not to be told
 * it does not exist here.
 */
export async function readResumePoint(rawKey: string): Promise<ResumePoint | null> {
  const client = getClient();
  const key = normalizeKey(rawKey);
  if (!key) return null;

  const row = (await client.execute({
    sql: 'SELECT key, project_dir, brief, created_at, last_resumed_at, resume_count FROM resume_points WHERE key = ?',
    args: [key],
  })).rows[0];
  if (!row) return null;

  await client.execute({
    sql: 'UPDATE resume_points SET last_resumed_at = ?, resume_count = resume_count + 1 WHERE key = ?',
    args: [new Date().toISOString(), key],
  });

  let brief: ResumeBrief;
  try { brief = JSON.parse(String(row.brief)); } catch { return null; }

  return {
    key,
    projectDir: String(row.project_dir),
    brief,
    createdAt: String(row.created_at),
    lastResumedAt: row.last_resumed_at ? String(row.last_resumed_at) : null,
    resumeCount: Number(row.resume_count),
  };
}

/** Parked workstreams for a project, newest first — for "what did I leave open?". */
export async function listResumePoints(projectDir: string, limit = 20): Promise<ResumePoint[]> {
  const rows = (await getClient().execute({
    sql: `SELECT key, project_dir, brief, created_at, last_resumed_at, resume_count
          FROM resume_points WHERE project_dir = ? ORDER BY created_at DESC LIMIT ?`,
    args: [normalizeProjectDir(projectDir), limit],
  })).rows;

  return rows.flatMap(row => {
    try {
      return [{
        key: String(row.key),
        projectDir: String(row.project_dir),
        brief: JSON.parse(String(row.brief)) as ResumeBrief,
        createdAt: String(row.created_at),
        lastResumedAt: row.last_resumed_at ? String(row.last_resumed_at) : null,
        resumeCount: Number(row.resume_count),
      }];
    } catch {
      return [];
    }
  });
}

/**
 * What the resuming session reads. Written as an instruction to that session
 * rather than as a record, because it arrives as the first thing in a context
 * that knows nothing: it has to say what the work is, what to do next, and
 * where to look for everything it does not contain.
 */
export function formatResumeBrief(point: ResumePoint): string {
  const { brief } = point;
  const lines = [
    `# RESUMING PARKED WORK — key ${point.key}`,
    '',
    `Parked ${point.createdAt}${point.resumeCount > 0 ? ` · resumed ${point.resumeCount} time(s) before` : ''}.`,
    `Project: ${point.projectDir}`,
    '',
    `## Goal`,
    brief.goal,
    '',
    `## Do this next`,
    brief.nextAction,
  ];

  if (brief.completed?.length) {
    lines.push('', '## Already done — do not redo', ...brief.completed.map(item => `- ${item}`));
  }
  if (brief.blocker) lines.push('', '## Blocker', brief.blocker);
  if (brief.verificationStatus) lines.push('', '## Verification state', brief.verificationStatus);
  if (brief.artifactRefs?.length) {
    lines.push('', '## Artifacts', ...brief.artifactRefs.map(ref => `- ${ref}`));
  }

  if (brief.sessionId) {
    lines.push(
      '',
      '## Where the detail lives',
      `The originating session is \`${brief.sessionId}\`. This brief is deliberately short — for anything`,
      `it does not answer, call knowl_transcript_search with sessionId "${brief.sessionId}" and read the`,
      `original conversation rather than guessing at what was decided.`,
    );
  }

  lines.push(
    '',
    'STOP HERE. This brief restores context; it is not authorisation to act. A resume key means the user',
    'wants the work REMEMBERED, not resumed on their behalf. Give them a short orientation — where the',
    'work stands, what the next action would be, and any blocker that needs their ruling — then wait.',
    'Do not edit files, run builds, or start the next action until they say go.',
  );
  return lines.join('\n');
}
