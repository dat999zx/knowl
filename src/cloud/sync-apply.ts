import type { InValue } from '@libsql/client';
import { getClient } from '../store/database.js';
import type { SyncAtom, SyncRow } from './sync-contract.js';
import type { VectorProfile } from '../core/vector-profile.js';
import { decodeVector, VectorDecodeError } from './vector-codec.js';

/**
 * The received vector, or null when there is nothing usable to store.
 *
 * A wrong-width or malformed vector is refused rather than stored: the replica's column has no
 * width constraint, so it would sit there ranking as noise forever. Refusing it costs one local
 * forward pass and is the recoverable direction.
 */
function decodeIfUsable(value: string | undefined, dimensions: number | null): Float32Array | null {
  if (value === undefined) return null;
  try {
    // A null expectation still goes through the codec: base64 validity and a whole number of
    // float32s are checked regardless, and only the width comparison is skipped.
    const bytes = Buffer.from(value, 'base64');
    return decodeVector(value, dimensions ?? bytes.byteLength / 4);
  } catch (error) {
    if (error instanceof VectorDecodeError) return null;
    throw error;
  }
}

/** float32 bytes, the packing `src/store/vector.ts` reads back. */
function packVector(values: Float32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

export type ApplyOutcome = {
  upserted: number;
  deleted: number;
  /**
   * Ids that arrived WITHOUT a usable vector and still need embedding locally.
   *
   * Empty on the normal path. Non-empty while a workspace is mid-reindex, where the feed sends
   * every row text-only by design -- which is the case `embedReplica` now exists to cover.
   */
  needEmbedding: string[];
};

/**
 * One statement, in the shape both `batch` and this module's own bookkeeping need.
 *
 * `args: unknown[]` does not satisfy libSQL's `InArgs`, so `batch` refused the array outright.
 * Typing it as `InStatement[]` instead would compile and then break the deleted-row count below,
 * which reads `.sql` off each entry -- `InStatement` may be a bare string. Naming the narrower
 * shape keeps both true at once.
 */
type Statement = { sql: string; args: InValue[] };

const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * Local NOT NULL columns the payload treats as optional.
 *
 * `knowledge_items.confidence` and `.tier` carry NOT NULL DEFAULT in the schema, but a default
 * only applies when the column is omitted -- and this statement names every column, so binding
 * null would fail the whole page over a field the server was entitled to leave out. The values
 * match the schema's own defaults so a synced atom and a locally written one agree.
 */
const DEFAULT_CONFIDENCE = 1;
const DEFAULT_TIER = 'asserted';

/** The schema's CHECK allows only these three, and the payload may omit the field entirely. */
const DEFAULT_RELATIONSHIP = 'supports';

/**
 * One statement per atom, carrying the server's own identity.
 *
 * Ids, versions and timestamps are the server's, never regenerated: the replica has to be the
 * same rows on every machine, and cross-store dedup keys on `content_hash`. `ON CONFLICT` is
 * what makes replay a no-op, and replay is the normal case -- the watermark advances only when
 * a whole traversal completes, so any interruption re-delivers pages already applied.
 *
 * `published_at`, `author_user_id` and `review` are deliberately not written: this schema has no
 * columns for them. They ride in the payload for Plan D, which adds them.
 */
function upsertStatement(item: SyncAtom) {
  return {
    sql: `INSERT INTO knowledge_items (
            id, category, title, content, status, freshness, confidence, reasoning, alternatives,
            tags, provenance, source, source_commit, affected_paths, conflict_key, conflict_scope,
            conflict_exclusive, content_hash, lifecycle_hash, tier, tier_since, origin_repo,
            visibility, superseded_by_id, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            category = excluded.category, title = excluded.title, content = excluded.content,
            status = excluded.status, freshness = excluded.freshness,
            confidence = excluded.confidence, reasoning = excluded.reasoning,
            alternatives = excluded.alternatives, tags = excluded.tags,
            provenance = excluded.provenance, source = excluded.source,
            source_commit = excluded.source_commit, affected_paths = excluded.affected_paths,
            conflict_key = excluded.conflict_key, conflict_scope = excluded.conflict_scope,
            conflict_exclusive = excluded.conflict_exclusive,
            content_hash = excluded.content_hash, lifecycle_hash = excluded.lifecycle_hash,
            tier = excluded.tier, tier_since = excluded.tier_since,
            origin_repo = excluded.origin_repo, visibility = excluded.visibility,
            superseded_by_id = excluded.superseded_by_id, version = excluded.version,
            updated_at = excluded.updated_at`,
    args: [
      item.id, item.category, item.title, item.content, item.status, item.freshness,
      item.confidence ?? DEFAULT_CONFIDENCE, item.reasoning ?? null, json(item.alternatives),
      json(item.tags), item.provenance ?? null, item.source ?? null, item.sourceCommit ?? null,
      json(item.affectedPaths), item.conflictKey ?? null, json(item.conflictScope),
      item.conflictExclusive ? 1 : 0, item.contentHash, item.lifecycleHash ?? null,
      item.tier ?? DEFAULT_TIER, item.tierSince ?? null, item.originRepo, item.visibility,
      item.supersededById, item.version, item.createdAt, item.updatedAt,
    ],
  };
}

export async function applySyncRows(
  rows: SyncRow[],
  vectors?: {
    profile: VectorProfile;
    fingerprint: string;
    /**
     * The width this repository's own embeddings use, or null when it has none yet.
     *
     * knowl's presets do not record a dimension -- it appears only in their prose labels -- so
     * the authoritative source is what this repo has actually produced. Null means there is
     * nothing to be inconsistent with, so whatever the server sends is accepted; the client
     * only connected because the two profiles match.
     */
    dimensions: number | null;
  },
): Promise<ApplyOutcome> {
  if (rows.length === 0) return { upserted: 0, deleted: 0, needEmbedding: [] };

  const statements: Statement[] = [];
  const needEmbedding: string[] = [];
  let upserted = 0;

  for (const row of rows) {
    if (row.op === 'upsert') {
      statements.push(upsertStatement(row.item));
      // Rewritten wholesale rather than diffed: evidence is a set attached to one atom, and
      // the server's copy is authoritative, so a removed citation must disappear here too.
      statements.push({
        sql: 'DELETE FROM knowledge_evidence WHERE knowledge_item_id = ?',
        args: [row.item.id],
      });
      for (const evidence of row.item.evidence ?? []) {
        statements.push({
          sql: `INSERT INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  type = excluded.type, locator = excluded.locator,
                  content_hash = excluded.content_hash, excerpt = excluded.excerpt,
                  observed_at = excluded.observed_at, metadata = excluded.metadata`,
          args: [
            evidence.id, evidence.type, evidence.locator, evidence.contentHash ?? null,
            evidence.excerpt ?? null,
            // `observed_at` is NOT NULL here and optional in the payload. Falling back to the
            // atom's own `updatedAt` rather than a local clock keeps the replica byte-identical
            // across machines -- stamping "now" would make the same atom differ per laptop.
            evidence.observedAt ?? row.item.updatedAt,
            json(evidence.metadata),
          ],
        });
        statements.push({
          sql: `INSERT INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship)
                VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [row.item.id, evidence.id, evidence.relationship ?? DEFAULT_RELATIONSHIP],
        });
      }
      // A vector the server built with the profile it is serving. Stored under the LOCAL
      // fingerprint, which is correct rather than a shortcut: this client only accepted the
      // workspace because the two profiles match, so the vector genuinely belongs to the local
      // space and must be filterable by local search like any other row.
      //
      // A malformed or wrong-width vector is not fatal -- the atom is already stored and text
      // -searchable, so it falls back to being embedded locally rather than failing the page.
      const decoded = vectors ? decodeIfUsable(row.item.vector, vectors.dimensions) : null;
      if (decoded && vectors) {
        statements.push({
          sql: `INSERT INTO knowledge_embeddings
                  (knowledge_item_id, provider, model, profile_fingerprint, dimensions, vector, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(knowledge_item_id) DO UPDATE SET
                  provider = excluded.provider, model = excluded.model,
                  profile_fingerprint = excluded.profile_fingerprint,
                  dimensions = excluded.dimensions, vector = excluded.vector,
                  updated_at = excluded.updated_at`,
          args: [
            row.item.id, vectors.profile.provider, vectors.profile.model, vectors.fingerprint,
            decoded.length, packVector(decoded), new Date().toISOString(),
          ],
        });
      } else {
        needEmbedding.push(row.item.id);
      }

      upserted += 1;
    } else {
      // Tolerated when it matches nothing: reachable on a first sync from a non-zero watermark
      // and after a resync, where the row is already in the state the delete asks for.
      statements.push({ sql: 'DELETE FROM knowledge_evidence WHERE knowledge_item_id = ?', args: [row.id] });
      statements.push({ sql: 'DELETE FROM knowledge_items WHERE id = ?', args: [row.id] });
    }
  }

  // One transaction for the whole page. A partial apply would leave rows the watermark says
  // were never delivered -- invisible until they went stale with nothing to refresh them.
  const applied = await getClient().batch(statements, 'write');

  // Counted from what the database actually removed, not from how many delete rows arrived.
  // A delete for an id this replica never held is legitimate -- reachable on a first sync
  // from a non-zero watermark -- and reporting it as a deletion would tell the user rows
  // vanished that were never there.
  const deletedRows = applied.reduce((total, result, index) =>
    statements[index].sql.startsWith('DELETE FROM knowledge_items')
      ? total + Number(result.rowsAffected ?? 0)
      : total, 0);

  return { upserted, deleted: deletedRows, needEmbedding };
}
