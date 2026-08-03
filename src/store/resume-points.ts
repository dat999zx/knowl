import { getClient } from './database.js';
import { mintResumeKey, normalizeResumeKey } from './resume-keys.js';

export type ResumeBrief = {
  goal: string;
  completed?: string[];
  nextAction?: string;
  blocker?: string;
  artifactRefs?: string[];
  verificationStatus?: 'verified' | 'unverified';
  /** The session that parked it, so a resuming session can read the transcript itself. */
  sessionId?: string;
};

export type ResumePoint = ResumeBrief & {
  key: string;
  projectDir: string;
  createdAt: string;
};

/**
 * Retries on a key collision rather than lengthening every key.
 *
 * Collisions are expected, not exceptional: the keyspace is 1,259,712 and 2,000 independent
 * draws collide about 80% of the time. What matters is that a *stored* key is unique, which the
 * primary key enforces and this retry absorbs.
 */
const MINT_ATTEMPTS = 5;

export async function createResumePoint(projectDir: string, brief: ResumeBrief): Promise<ResumePoint> {
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const key = mintResumeKey();
    try {
      await getClient().execute({
        sql: 'INSERT INTO resume_points (key, project_dir, brief, created_at) VALUES (?, ?, ?, ?)',
        args: [key, projectDir, JSON.stringify(brief), createdAt],
      });
      return { ...brief, key, projectDir, createdAt };
    } catch (error) {
      const text = String(error).toUpperCase();
      // Only a key collision is worth another draw. Anything else -- a missing table, a closed
      // database -- would be retried five times and then reported as a minting failure, which
      // is a misleading diagnosis of a completely different problem.
      if (!text.includes('UNIQUE') && !text.includes('PRIMARY KEY')) throw error;
    }
  }

  throw new Error('Could not mint a unique resume key.');
}

function toPoint(row: Record<string, unknown>): ResumePoint | null {
  try {
    return {
      ...(JSON.parse(String(row.brief)) as ResumeBrief),
      key: String(row.key),
      projectDir: String(row.project_dir),
      createdAt: String(row.created_at),
    };
  } catch {
    // A brief that will not parse is unusable; treating it as absent beats throwing at the
    // one moment the user is trying to get their work back.
    return null;
  }
}

/**
 * The brief behind a key, from anywhere.
 *
 * Deliberately takes no project argument. A key is held by the user, not by a directory, and
 * pasting one while sitting in a different repo is the normal case rather than a mistake.
 *
 * Reading does not consume it: work gets picked up, put down, and picked up again.
 */
export async function readResumePoint(rawKey: string): Promise<ResumePoint | null> {
  const key = normalizeResumeKey(rawKey);
  if (!key) return null;

  const rows = (await getClient().execute({
    sql: 'SELECT key, project_dir, brief, created_at FROM resume_points WHERE key = ?',
    args: [key],
  })).rows;

  return rows[0] ? toPoint(rows[0] as Record<string, unknown>) : null;
}

/** What is parked in this project, newest first. The "what did I leave here" view. */
export async function listResumePoints(projectDir: string, limit = 20): Promise<ResumePoint[]> {
  const rows = (await getClient().execute({
    // `rowid` breaks the tie, not `created_at` alone: several parks in one tick share an
    // identical ISO timestamp, and ordering on it alone returns them in engine order.
    sql: `SELECT key, project_dir, brief, created_at FROM resume_points
          WHERE project_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [projectDir, limit],
  })).rows;

  return rows
    .map(row => toPoint(row as Record<string, unknown>))
    .filter((point): point is ResumePoint => point !== null);
}
