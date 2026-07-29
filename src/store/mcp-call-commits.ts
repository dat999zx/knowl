import crypto from 'node:crypto';
import { canonicalProjectRoot } from '../core/project-path.js';
import { getClient } from './database.js';
import type { ChangeAttributionKeys } from './change-watermark.js';

/**
 * Which commits each MCP write produced, so the hook path can recognise its own work.
 *
 * The hook path and the MCP server are separate processes with no shared session identity,
 * which is why hook-side attribution had to guess: it matched the ids and titles in its own
 * `tool_input` against the titles in new commits. That guess is wrong in both directions --
 * a write's indirect effects (a dedup supersede of a differently-titled item, GC, promotion)
 * carry none of the caller's keys and get reported back as somebody else's work, while a
 * genuinely foreign change that happens to share a title is silently hidden.
 *
 * The MCP process does know exactly what it committed: it reads the head before dispatch,
 * so its own commits are precisely the rows above that. Recording the range lets the hook
 * stop reasoning about titles at all. It confirms the range is its own using the keys it
 * already has, then excludes the whole range -- indirect effects included.
 */
export type CommitRange = { from: number; to: number };

/** Ranges older than this cannot belong to the tool call a hook is currently reporting. */
const RANGE_TTL_MS = 5 * 60_000;

const newId = (): string => crypto.randomUUID().replace(/-/g, '').substring(0, 16);

export async function recordMcpCallCommits(input: {
  projectRoot: string;
  toolName: string;
  range: CommitRange;
}): Promise<void> {
  const now = Date.now();
  await getClient().execute({
    sql: `INSERT INTO mcp_call_commits (id, project_root, tool_name, from_rowid, to_rowid, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      newId(),
      canonicalProjectRoot(input.projectRoot),
      input.toolName,
      input.range.from,
      input.range.to,
      new Date(now).toISOString(),
    ],
  });
  // Swept on write rather than on a timer: the table only grows when someone writes, so
  // that is exactly when it needs trimming, and it keeps this off every read path.
  await getClient().execute({
    sql: 'DELETE FROM mcp_call_commits WHERE created_at < ?',
    args: [new Date(now - RANGE_TTL_MS).toISOString()],
  });
}

/**
 * Recent ranges recorded for this project root and tool, newest first.
 *
 * Scoped by tool name as well as time because a hook event names the tool it fired for;
 * a `knowl_store` event has no business claiming a `knowl_update` range.
 */
export async function findRecentCallRanges(
  projectRoot: string,
  toolName: string,
  within = RANGE_TTL_MS,
): Promise<CommitRange[]> {
  const rows = (await getClient().execute({
    sql: `SELECT from_rowid, to_rowid FROM mcp_call_commits
      WHERE project_root = ? AND tool_name = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 20`,
    args: [
      canonicalProjectRoot(projectRoot),
      toolName,
      new Date(Date.now() - within).toISOString(),
    ],
  })).rows;
  return rows.map(row => ({ from: Number(row.from_rowid), to: Number(row.to_rowid) }));
}

/**
 * True when a recorded range is demonstrably the caller's own work.
 *
 * Time and tool name alone would be a guess -- two sessions can call `knowl_store` in the
 * same second. Requiring one of the caller's own `tool_input` keys to appear inside the
 * range is what turns it into evidence. One match is enough: having established the range
 * belongs to this call, everything in it does, including the changes that carry no key.
 */
export function rangeBelongsToCaller(
  changesInRange: Array<{ itemId: string; title?: string }>,
  keys: ChangeAttributionKeys | undefined,
): boolean {
  if (!keys) return false;
  const ids = new Set(keys.ids);
  const titles = new Set(keys.titles);
  return changesInRange.some(change => ids.has(change.itemId) || (change.title !== undefined && titles.has(change.title)));
}
