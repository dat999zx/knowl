import type { CloudRole } from './api-client.js';

/** Divergence between this mirror and the server's serializer. Never recoverable in-flight. */
export class SyncContractError extends Error {}

export type SyncReview = {
  reason: string;
  observedAtCommit: string | null;
  reportedBy: string | null;
  reportedAt: string;
};

/**
 * `type`, not `kind`.
 *
 * Both the server payload and this repo's `evidence` table name the column `type`. Mirroring it
 * under another name would leave every citation writing NULL into a NOT NULL column, and the
 * failure would only appear once a real atom carried evidence.
 */
export type SyncEvidence = {
  id: string;
  type: string;
  locator: string;
  contentHash?: string | null;
  excerpt?: string | null;
  observedAt?: string | null;
  metadata?: unknown;
  relationship?: string | null;
};

export type SyncAtom = {
  /**
   * The atom's vector, base64 float32, **only when the server built it with the profile the
   * workspace is currently serving**.
   *
   * Absent otherwise, and this client embeds the text itself. Not a degraded path: it is what
   * every row looks like while a workspace is mid-reindex, and a vector the workspace no longer
   * considers current would rank badly here with nothing to notice.
   */
  vector?: string;
  id: string;
  category: string;
  title: string;
  content: string;
  status: string;
  freshness: string;
  confidence?: number | null;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  provenance?: string | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  conflictKey?: string | null;
  conflictScope?: unknown;
  conflictExclusive?: boolean;
  /**
   * Nullable, because the server really sends null: an atom published without a hash has no
   * value to send, and `snapshot-page.json` -- generated from the real serializer -- carries
   * null on every row. Cross-store dedup keys on it when it is present and falls back to the
   * id when it is not.
   */
  contentHash: string | null;
  lifecycleHash?: string | null;
  tier?: string | null;
  tierSince?: string | null;
  originRepo: string | null;
  authorUserId: string | null;
  supersededById: string | null;
  version: number;
  visibility: string;
  review: SyncReview | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  evidence?: SyncEvidence[];
  steps?: string[];
  assertions?: unknown[];
};

/**
 * What travels up. `PublishItemSchema` on the server, mirrored to exactly the fields this client
 * can produce -- nothing here is invented locally, so a field the server adds is simply not sent.
 *
 * "Can produce" is the whole test, and it is easy to under-read. `evidence`, `assertions` and
 * `tier` were absent from this type for one release while the local store held all three and the
 * server accepted all three -- so every published atom arrived uncited, un-asserted, and at the
 * server's default tier, with nothing red anywhere. A field belongs here the moment the local
 * schema has it, not when someone notices it missing.
 */
export type PublishEvidence = {
  id: string;
  /** `type`, never `kind`. The wire and the local column agree; this client did not, once. */
  type: string;
  locator: string;
  contentHash?: string | null;
  excerpt?: string | null;
  observedAt: string;
  metadata?: Record<string, unknown> | null;
  /**
   * From the `knowledge_evidence` LINK row, not from `evidence`.
   *
   * The same citation can support one atom and contradict another, so the relationship belongs
   * to the pairing rather than to the evidence -- reading it off the evidence row would give
   * every atom citing a file the first one's verdict.
   */
  relationship: string;
};

/** A time-bounded sub-claim. `validTo: null` is an interval still open, not an unknown one. */
export type PublishAssertion = {
  id: string;
  content: string;
  validFrom: string;
  validTo?: string | null;
  recordedAt: string;
  replacedAt?: string | null;
  confidence: number;
  sourceEvidenceId?: string | null;
};

export type PublishItem = {
  id: string;
  category: string;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  contentHash?: string | null;
  lifecycleHash?: string | null;
  status?: string;
  freshness?: string;
  confidence?: number;
  provenance?: string | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
  /**
   * Earned, not asserted -- promoted from real retrievals since `tier_since`.
   *
   * Omitting it lets the server apply its default, which discards the one quality signal this
   * client measures rather than accepts, at the exact moment of sharing.
   */
  tier?: string;
  steps?: string[];
  evidence?: PublishEvidence[];
  assertions?: PublishAssertion[];
  /**
   * The version this client believes is current. **Omitted, never null, on a first publish** --
   * a first publish has no remote version to be stale against, and sending one would be a claim
   * about a row that does not exist. On a republish it is mandatory: the server treats a
   * republish without it as a conflict, deliberately, so an older client cannot acquire
   * overwrite rights by not knowing the field exists.
   */
  expectedVersion?: number;
  /**
   * This atom's vector, base64 of a little-endian Float32Array -- see `vector-codec.ts`.
   *
   * Read from `knowledge_embeddings` rather than computed at push time. It was built when the
   * atom was written; recomputing would spend a forward pass to reproduce a value already on
   * disk, and would produce a DIFFERENT one if the local profile changed since -- which is
   * precisely the corruption `profileFingerprint` exists to prevent.
   */
  vector?: string;
  /**
   * What produced `vector`, in five fields, never a preset name.
   *
   * The server compares all five against the workspace's own and refuses the whole request on a
   * difference. `recipeVersion` is the one a model-only fingerprint cannot express: it says what
   * TEXT went into the model, where the other four say which model.
   */
  profileFingerprint?: {
    provider: string;
    model: string;
    dtype: string;
    pooling: string;
    recipeVersion: number;
  };
};

/**
 * One outcome per atom, because the batch commits in one transaction and reports per item -- a
 * single stale atom must not discard the rest.
 *
 * `foreign_origin` is separate from `conflict` and the distinction is the point: a conflict tells
 * the client to re-read and retry, and here a retry would fail identically forever. `tombstoned`
 * is separate for the same reason.
 */
export type PublishOutcome =
  | { id: string; status: 'created'; version: number }
  | { id: string; status: 'updated'; version: number }
  | { id: string; status: 'conflict'; currentVersion: number }
  | { id: string; status: 'foreign_origin'; originRepo: string }
  | { id: string; status: 'deleted' }
  | { id: string; status: 'tombstoned'; deletedAt: string };

/**
 * The three verbs this client sends on the update endpoint, and their asymmetry is deliberate.
 *
 * `needsReview` takes no version and bumps none: a drift report is an observation about an atom,
 * not a revision of it, so a report is never dropped for arriving mid-edit. `reviewed` is a
 * positive claim about specific content, so it takes `expectedVersion` and refuses to vouch for
 * text the caller did not read.
 *
 * `delete` is the destructive one and takes `expectedVersion` for the sharper version of the same
 * reason: deleting an atom a colleague edited since you read it destroys a correction you never
 * saw. The server hard-deletes the row and writes a tombstone in one transaction, then refuses
 * every later publish of that id, so this cannot be undone from either side. `reason` is required
 * and stored on the tombstone -- a deletion nobody can explain later is its own problem.
 *
 * This is a strict subset of the server's patch union, which also carries `transfer`. A verb
 * absent here is one this client has no path for, not one the server lacks.
 */
export type UpdateItemBody =
  | { op: 'needsReview'; reason: string; observedAtCommit?: string }
  | { op: 'reviewed'; expectedVersion: number; sourceCommit: string; note?: string }
  | { op: 'delete'; expectedVersion: number; reason: string };

export type SyncRow =
  | { op: 'upsert'; seq: string; item: SyncAtom }
  | { op: 'delete'; seq: string; id: string; deletedAt: string };

export type SyncPage = {
  rows: SyncRow[];
  /**
   * Opaque `(seq, id)` position. Non-null means the traversal is mid-flight and the watermark
   * must NOT advance -- a 200-item commit read at limit 50 never completes without it.
   */
  cursor: string | null;
  /** Decimal bigint as a string. Constant across one traversal; applied when it completes. */
  nextSeq: string;
  role: CloudRole;
  /** The server refused `since` as below retention. Not an empty page -- a full resync. */
  resyncRequired: boolean;
};

function fail(what: string): never {
  throw new SyncContractError(
    `Sync response does not match this client's contract mirror: ${what}. ` +
    'This means knowl-cloud and knowl have diverged. Regenerate tests/fixtures/sync/ from ' +
    'the server and update src/cloud/sync-contract.ts -- do not apply a page this build ' +
    'cannot fully read, because the replica would silently lose whatever field was added.',
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ROLES = new Set(['owner', 'admin', 'editor', 'reader']);

/**
 * Structural validation only, and deliberately shallow on the atom body.
 *
 * The fields this client reads are checked; the rest ride through untouched, so a server that
 * adds a field does not break a client that does not use it. What is NOT tolerated is an
 * unrecognised `op` or a `seq` that is not a string: the first would be silently skipped and
 * the second is the bigint-through-a-float bug.
 */
export function parseSyncPage(value: unknown): SyncPage {
  if (!isRecord(value)) fail('the payload is not an object');
  if (!Array.isArray(value.rows)) fail('`rows` is missing or not an array');

  const rows: SyncRow[] = value.rows.map((row, index) => {
    if (!isRecord(row)) fail(`row ${index} is not an object`);
    if (typeof row.seq !== 'string') fail(`row ${index} has a non-string \`seq\``);

    if (row.op === 'upsert') {
      if (!isRecord(row.item)) fail(`upsert row ${index} has no \`item\``);
      if (typeof row.item.id !== 'string') fail(`upsert row ${index} has no \`item.id\``);
      if (typeof row.item.version !== 'number') fail(`upsert row ${index} has no \`item.version\``);
      // Checked for TYPE, not for presence: null is a value the server legitimately sends.
      // Absent is different from null and means the field was renamed or dropped.
      if (!('contentHash' in row.item)) fail(`upsert row ${index} has no \`item.contentHash\``);
      if (row.item.contentHash !== null && typeof row.item.contentHash !== 'string') {
        fail(`upsert row ${index} has a non-string, non-null \`item.contentHash\``);
      }
      return { op: 'upsert', seq: row.seq, item: row.item as unknown as SyncAtom };
    }

    if (row.op === 'delete') {
      if (typeof row.id !== 'string') fail(`delete row ${index} has no \`id\``);
      if (typeof row.deletedAt !== 'string') fail(`delete row ${index} has no \`deletedAt\``);
      return { op: 'delete', seq: row.seq, id: row.id, deletedAt: row.deletedAt };
    }

    return fail(`row ${index} has unknown op "${String(row.op)}"`);
  });

  const cursor = value.cursor === null || value.cursor === undefined ? null : String(value.cursor);
  if (typeof value.nextSeq !== 'string') fail('`nextSeq` is missing or not a string');
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) fail('`role` is missing or unknown');

  return {
    rows,
    cursor,
    nextSeq: value.nextSeq,
    role: value.role as CloudRole,
    resyncRequired: value.resyncRequired === true,
  };
}
