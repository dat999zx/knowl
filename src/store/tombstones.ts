import { sql } from 'drizzle-orm';
import { DbConnection, getDb } from './database.js';

export type Tombstone = { id: string; deletedAt: string; reason: string | null };

/**
 * A hard delete leaves no trace in `knowledge_items`, so a peer that imports a later
 * export cannot tell the item was removed from one that never existed. The tombstone is
 * the only record that a delete happened, and the only way a delete can travel.
 */
export async function recordTombstone(
  id: string,
  deletedAt: string,
  reason?: string,
  dbConnection?: DbConnection,
): Promise<void> {
  const conn = (dbConnection ?? getDb()) as any;
  await conn.run(sql`
    INSERT INTO knowledge_tombstones (id, deleted_at, reason)
    VALUES (${id}, ${deletedAt}, ${reason ?? null})
    ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
  `);
}

export async function listTombstones(dbConnection?: DbConnection): Promise<Tombstone[]> {
  const conn = (dbConnection ?? getDb()) as any;
  const rows = await conn.all(sql`SELECT id, deleted_at, reason FROM knowledge_tombstones ORDER BY id`);
  return rows.map((row: any) => ({
    id: String(row.id),
    deletedAt: String(row.deleted_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  }));
}

/**
 * Tombstones would grow without bound otherwise. One older than any plausible export
 * round cannot affect a future import, so retention is bounded rather than infinite.
 */
export async function pruneTombstones(
  olderThanDays: number,
  now: Date = new Date(),
  dbConnection?: DbConnection,
): Promise<number> {
  const conn = (dbConnection ?? getDb()) as any;
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await conn.run(sql`DELETE FROM knowledge_tombstones WHERE deleted_at < ${cutoff}`);
  return Number(result?.rowsAffected ?? 0);
}
