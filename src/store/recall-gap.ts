import crypto from 'node:crypto';
import { getClient } from './database.js';
import { knowledgeMentionsChangedPath } from './freshness.js';

/**
 * `affected_paths` is a JSON array in a TEXT column, and both existing readers of it keep their
 * own private parser (`bootstrap.ts`, `integrity.ts`). A third one here rather than exporting
 * one of theirs: this is four lines, and widening a module's surface to share four lines is the
 * more expensive change.
 */
function parsePaths(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * How often an agent touched something the store already knew about, and whether it had asked.
 *
 * The read side's negative signal, and the twin of `capture-outcome.ts`. That one counts what a
 * session should have WRITTEN and did not. This counts what it should have READ and did not --
 * the failure nobody can see from inside a session, because an agent that never retrieved an
 * atom has no way to notice the atom exists.
 *
 * **This shows the agent nothing.** It is a measurement, and the whole point of building it
 * before any injection feature is that "the agent misses things" is currently a belief with no
 * number under it. If the gap turns out small, the reminder-based pull already works and no
 * push mechanism is worth its context budget; if it is large, the size says which hosts and
 * which surfaces matter. Either way the decision stops being an argument.
 *
 * **It is a LOWER BOUND, by construction.** Only knowledge carrying `affectedPaths` can be
 * matched to a file, so an atom about a decision that names no file -- which is most decisions
 * -- is invisible here and never counts as a miss. Undercounting is the right direction for a
 * number that exists to justify building something.
 */

/**
 * How recently an atom must have been retrieved to count as "the agent already had it".
 *
 * A proxy for conversation scope, because `knowledge_access` has no session column (see the
 * `ponytail:` note on `recordRederivationBestEffort`). Adding one would mean editing the table
 * two other in-flight changes are already in, for a measurement that does not need that
 * precision.
 *
 * The error direction is what makes the proxy acceptable: a *second* session retrieving the same
 * atom inside the window makes this read "already retrieved" when this session never asked, so
 * the proxy UNDERSTATES the gap. It cannot invent one.
 *
 * ponytail: time-window proxy for session scope, replace with a session column on
 * `knowledge_access` if the number ever has to be exact rather than indicative.
 */
const DEFAULT_WINDOW_MINUTES = 120;

export type RecallObservation = { held: number; retrieved: number };

export type RecallGapReport = {
  /** Tool touches observed. The denominator: without it, `held` is a number with no scale. */
  touches: number;
  /** Touches where the store held at least one atom naming the path. */
  held: number;
  /** Of those, touches where at least one of those atoms had been retrieved in the window. */
  retrieved: number;
  /** `held - retrieved`. The gap this whole thing exists to size. */
  missed: number;
};

type PathCitingItem = { id: string; source: string | null; affectedPaths: string[] };

/**
 * Active items that cite any file at all. Everything else can never match a path.
 *
 * Not scoped by project, because `knowledge_items` has no project column -- one database is one
 * project, and `checkKnowledgeDrift` reads the same table the same way. The `projectId` the
 * callers pass is the store handle's identity, not a filter.
 */
async function itemsCitingPaths(): Promise<PathCitingItem[]> {
  const result = await getClient().execute({
    sql: `SELECT id, source, affected_paths FROM knowledge_items
          WHERE status = 'active' AND (affected_paths IS NOT NULL OR source IS NOT NULL)`,
    args: [],
  });
  return result.rows.map((row: any) => ({
    id: String(row.id),
    source: row.source === null || row.source === undefined ? null : String(row.source),
    affectedPaths: parsePaths(row.affected_paths),
  }));
}

/** Which of these items were retrieved inside the window, by an actual agent read. */
async function retrievedWithin(itemIds: string[], since: string): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const placeholders = itemIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    // `surface` is filtered, not merely counted. `knowledge_access` also carries feedback rows
    // and the re-derivation signal, and neither is the agent reading the atom -- counting them
    // as retrieval would mark a touch "already had it" on the strength of a WRITE.
    sql: `SELECT DISTINCT knowledge_item_id FROM knowledge_access
          WHERE knowledge_item_id IN (${placeholders})
            AND retrieved_at >= ?
            AND surface NOT IN ('feedback', 'rederived')`,
    args: [...itemIds, since],
  });
  return new Set(result.rows.map((row: any) => String(row.knowledge_item_id)));
}

/**
 * Record one tool touch. Returns what was observed so a caller can log it without a second read.
 *
 * Best-effort is the caller's job, not this function's: it runs on the hook path, and a
 * measurement that can fail a tool call is worse than no measurement.
 */
export async function observeRecallGap(_projectId: string, input: {
  conversation: string;
  paths: string[];
  windowMinutes?: number;
  at?: string;
}): Promise<RecallObservation> {
  const now = input.at ?? new Date().toISOString();
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const since = new Date(Date.parse(now) - windowMinutes * 60_000).toISOString();

  const matched = (await itemsCitingPaths())
    .filter(item => knowledgeMentionsChangedPath(item, input.paths))
    .map(item => item.id);
  const retrieved = matched.length > 0 ? await retrievedWithin(matched, since) : new Set<string>();

  const observation: RecallObservation = { held: matched.length, retrieved: retrieved.size };
  await getClient().execute({
    sql: `INSERT INTO recall_observations (id, conversation, paths, held, retrieved, observed_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(), input.conversation, JSON.stringify(input.paths),
      observation.held, observation.retrieved, now,
    ],
  });
  return observation;
}

/** Never throws, never blocks the tool call it rides on. */
export async function observeRecallGapBestEffort(projectId: string, input: {
  conversation: string;
  paths: string[];
}): Promise<void> {
  try {
    await observeRecallGap(projectId, input);
  } catch {
    // A measurement is not worth a failed tool call.
  }
}

export async function recallGapReport(_projectId: string): Promise<RecallGapReport> {
  const result = await getClient().execute({
    // Counted per TOUCH, not per atom. "Three atoms named this file" is not three misses -- it
    // is one moment where the agent could have been told something and was not, and the decision
    // this number feeds is about moments, not rows.
    sql: `SELECT COUNT(*) AS touches,
                 SUM(CASE WHEN held > 0 THEN 1 ELSE 0 END) AS held,
                 SUM(CASE WHEN held > 0 AND retrieved > 0 THEN 1 ELSE 0 END) AS retrieved
          FROM recall_observations`,
    args: [],
  });
  const row: any = result.rows[0] ?? {};
  const touches = Number(row.touches ?? 0);
  const held = Number(row.held ?? 0);
  const retrieved = Number(row.retrieved ?? 0);
  return { touches, held, retrieved, missed: held - retrieved };
}
