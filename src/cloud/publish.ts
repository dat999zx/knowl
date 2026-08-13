import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory, type ProjectConfig } from '../core/types.js';
import { closeDb, getClient, initDb } from '../store/database.js';
import { selectOwnedItems, type PromoteTarget } from '../workspace/promote.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import {
  listStaged, publishedVersion, recordPushed, restageForPublish, stageForPublish,
} from './ledger.js';
import { filterExcluded } from './exclusions.js';
import { currentBranchOf } from './publish-gate.js';
import { readSyncState } from './sync-state.js';
import { listAssertions } from '../store/assertions.js';
import { listEvidenceForItem } from '../store/evidence-repository.js';
import type { PublishAssertion, PublishEvidence, PublishItem, PublishOutcome } from './sync-contract.js';
import { EMBED_RECIPE_VERSION } from '../core/embed-recipe.js';
import { fingerprintProfile, resolveVectorProfile, type VectorProfile } from '../core/vector-profile.js';
import { decodeVector as decodeStoredVectorValue } from '../store/vector.js';
import { encodeVector as encodeVectorToBase64 } from './vector-codec.js';
import { withTeamStore } from './team-store.js';
import { ensureAccessToken } from './token.js';
import { cloudPointer } from '../core/cloud-pointer.js';

export type StageResult =
  | { status: 'not-connected' }
  | {
    status: 'staged';
    items: PromoteTarget[];
    applied: boolean;
    skippedForeign: number;
    /**
     * Excluded atoms a sweep passed over. Reported rather than silent for the same reason
     * `skippedForeign` is: a sweep that quietly stages fewer atoms than the category holds is
     * indistinguishable from a sweep that found nothing, and the remedy differs.
     */
    skippedExcluded: number;
  };

/**
 * Record the intent to publish. Sends nothing.
 *
 * Staging is deliberately ungated: an intent can be formed on any branch at any time, and
 * refusing to record one would mean a developer has to remember it themselves until the merge
 * lands. The branch is stored beside it so the push can explain what it is waiting for.
 *
 * `visibility` is not touched, at all. Publication state lives in the ledger (decision
 * `ee191dd7db024bec`), and `repo`/`workspace` keep meaning exactly what they meant: who may read
 * this item on this machine.
 *
 * `initDb`/`closeDb` are correct **here** and only here: this runs from a CLI command, which owns
 * its process. Constraint `defde27f6f234535` forbids them from anything reachable by an MCP tool
 * call, and nothing in this module is.
 */
export async function stagePublish(input: {
  projectRoot: string;
  config: ProjectConfig;
  ids?: string[];
  categories?: KnowledgeCategory[];
  apply?: boolean;
}): Promise<StageResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    return await stageInContext(input, pointer);
  } finally {
    await closeDb();
  }
}

/**
 * The same staging, for a caller that already holds a database context -- an MCP request.
 *
 * `stagePublish` owns the process-wide context and must never be reached from one: its
 * `closeDb` would leave every LATER tool call in that server with no database. See constraint
 * `defde27f6f234535`.
 */
export async function stagePublishInRequest(input: {
  projectRoot: string;
  config: ProjectConfig;
  ids?: string[];
  categories?: KnowledgeCategory[];
  apply?: boolean;
}): Promise<StageResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };
  return stageInContext(input, pointer);
}

async function stageInContext(
  input: {
    projectRoot: string;
    config: ProjectConfig;
    ids?: string[];
    categories?: KnowledgeCategory[];
    apply?: boolean;
  },
  pointer: NonNullable<ProjectConfig['cloud']>,
): Promise<StageResult> {
  const { items, skippedForeign } = await selectOwnedItems({
    // The local name, not `pointer.repo`. A repo has two of them and both are right: local
    // workspace membership stamps `origin_repo` with the member name from the manifest
    // ("web"), while `cloud connect` records the git identity ("github.com/acme/web")
    // because that is the bucket the server keys publications on -- which is why the push
    // below still sends `pointer.repo`. Asking the ownership question with the cloud name
    // compared the two namespaces against each other, so every item in a locally-linked repo
    // came back foreign and such a repo could never publish anything at all. Outside a
    // workspace `origin_repo` is NULL, which `selectOwnedItems` claims regardless, so the
    // fallback only has to be a name nothing is stamped with.
    repoName: input.config.workspace?.repo ?? pointer.repo,
    categories: input.categories,
    ids: input.ids,
    verb: 'stage',
  });

  // A sweep means "publish what is not published yet"; an excluded atom is one this machine was
  // told never to publish, so it is not a candidate. Naming an id deliberately overrides that --
  // `knowl cloud unstage --forever` promises exactly this in its own output, and an exclusion
  // that naming could not override would be irreversible without hand-editing SQLite.
  //
  // Applied before the `apply` branch so the dry run and the real run list the same atoms. A
  // preview that showed an atom `--apply` would then skip is worse than no preview.
  const namedIds = Boolean(input.ids?.length);
  const eligible = namedIds
    ? items
    : await (async () => {
      const allowed = new Set(await filterExcluded(items.map(item => item.id)));
      return items.filter(item => allowed.has(item.id));
    })();
  const skippedExcluded = items.length - eligible.length;

  if (input.apply && eligible.length > 0) {
    // Swallowed on purpose, and only here. `staged_on_branch` is a record of where an intent was
    // formed -- displayed by `cloud status`, read by nothing that decides anything. Failing to
    // record an intent because git is missing would refuse a step that never needed git at all.
    let branch: string | null;
    try { branch = currentBranchOf(input.projectRoot); } catch { branch = null; }

    // Naming ids is a deliberate act about items the caller has in hand, and it is the only
    // way to send a correction, so it re-stages what was already pushed. A category sweep
    // means "publish what is not published yet" and leaves those alone -- otherwise every
    // `knowl cloud stage --category decision --apply` would re-send the whole category, spending a
    // version bump and a server-side embedding job per atom on identical content.
    const stage = input.ids?.length ? restageForPublish : stageForPublish;
    await stage(eligible.map(item => item.id), pointer.workspaceId, branch);
  }

  return {
    status: 'staged',
    items: eligible,
    applied: Boolean(input.apply) && eligible.length > 0,
    skippedForeign,
    skippedExcluded,
  };
}

export type PushResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'forbidden'; role: string }
  /**
   * Staged atoms that have no vector under this repo's current embedding profile.
   *
   * Not an error and not silence. They stay staged and go out as soon as they are embedded --
   * but a push that said nothing would report success for work it did not do, which is the
   * failure `loadPublishItem` returning a bare `null` used to cause.
   *
   * The server refuses these too. This is the same verdict one round trip earlier, with a
   * message that names the command that fixes it.
   */
  | { status: 'needs-embedding'; count: number; remedy: string }
  | {
    /**
     * The queue is not what the human confirmed. Nothing was sent.
     *
     * `changed` means a listed atom's text moved between the prompt and the answer; `added`
     * means the queue grew, which only refuses under `strict`.
     */
    status: 'snapshot-stale';
    added: string[];
    changed: string[];
  }
  | {
    status: 'pushed';
    created: number;
    updated: number;
    /** Stale locally. A retry after re-reading can succeed, which is why these are their own field. */
    conflicts: PublishOutcome[];
    /**
     * Refused in a way no retry improves: `foreign_origin`, and `deleted`/`tombstoned` should the
     * server ever answer with them.
     *
     * Named for the verdict rather than for `foreign_origin`, which is only the variant reachable
     * today -- a bucket named after one of its members tells the next reader the wrong thing about
     * the others the moment retraction is wired.
     */
    rejected: PublishOutcome[];
  };

/** The contract's own cap. An unbounded batch is an unbounded transaction on the server. */
const MAX_BATCH = 200;

const parseJson = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(String(value)) as T; } catch { return null; }
};

/**
 * Send what is staged, if this checkout may speak for the team.
 *
 * The gate is checked ONCE, before the batch. The branch cannot change mid-push, and re-checking
 * per atom would spend a `spawnSync` per item for one answer.
 *
 * Nothing is un-staged until the server has confirmed it. An atom whose outcome was a conflict,
 * a foreign origin, or a failure stays staged, so the next run retries exactly it and no more.
 */
/**
 * What a confirmation prompt was shown, as a thing that can be checked later.
 *
 * `pushStaged` reads `listStaged` live, and once auto-staging is on a long-lived MCP server is
 * writing to that queue continuously -- so between drawing a prompt and reading the answer,
 * another process can stage new atoms or rewrite the text of listed ones. Confirming a live read
 * would send items and content nobody was shown. **This risk is created by auto-staging; it did
 * not exist when staging was manual and rare.**
 *
 * The payload is captured here rather than re-read at send time, and that is the whole
 * mechanism. Comparing hashes and then loading the payload separately leaves a second window
 * open between the comparison and the load, so what was hashed, what was shown and what is sent
 * must be one object that nothing can edit in between.
 */
export type PushSnapshot = {
  items: Array<{
    itemId: string;
    contentHash: string | null;
    lifecycleHash: string | null;
    /** The exact bytes that will be sent. */
    payload: PublishItem;
  }>;
  /**
   * Staged atoms that have no vector under this repository's current embedding profile.
   *
   * Captured here rather than recomputed at send time for the same reason the payloads are: the
   * snapshot is what the human was shown, and a fresh read between the prompt and the send is
   * exactly the window this type exists to close.
   */
  unembedded: string[];
};

/** The hashes of the atoms currently staged, for comparison against a snapshot. */
async function stagedHashes(itemIds: string[]): Promise<Map<string, { contentHash: string | null; lifecycleHash: string | null }>> {
  if (itemIds.length === 0) return new Map();
  const placeholders = itemIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    sql: `SELECT id, content_hash, lifecycle_hash FROM knowledge_items WHERE id IN (${placeholders})`,
    args: itemIds,
  });
  return new Map(result.rows.map(row => [String(row.id), {
    contentHash: row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    lifecycleHash: row.lifecycle_hash === null || row.lifecycle_hash === undefined ? null : String(row.lifecycle_hash),
  }]));
}

/**
 * Capture what a push would send right now, so a human can be shown it and it can be sent unchanged.
 *
 * Opens and closes its own database context, like `stagePublish` and for the same reason: this
 * runs from a CLI command that owns its process.
 */
export async function computePushSnapshot(input: {
  projectRoot: string;
  config: ProjectConfig;
}): Promise<PushSnapshot> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { items: [], unembedded: [] };

  await initDb(input.projectRoot);
  try {
    const profile = resolveVectorProfile(input.config);
    const fingerprint = fingerprintProfile(profile);
    const staged = await listStaged(pointer.workspaceId);
    const hashes = await stagedHashes(staged.map(row => row.itemId));
    const items: PushSnapshot['items'] = [];
    const unembedded: string[] = [];
    for (const row of staged) {
      const loaded = await loadPublishItem(row.itemId, pointer.workspaceId, profile, fingerprint);
      // A staged id whose row is gone cannot be shown or sent. Skipped here for the same reason
      // the push skips it: the ledger records intent, and this command does not edit it.
      if (!('item' in loaded)) {
        // An atom with no current vector is a different case: it exists, it is staged, and the
        // push will refuse because of it. Carried out so the prompt can say so rather than
        // quietly showing a shorter list than the user staged.
        if (loaded.skipped === 'no-vector') unembedded.push(row.itemId);
        continue;
      }
      items.push({
        itemId: row.itemId,
        contentHash: hashes.get(row.itemId)?.contentHash ?? null,
        lifecycleHash: hashes.get(row.itemId)?.lifecycleHash ?? null,
        payload: loaded.item,
      });
    }
    return { items, unembedded };
  } finally {
    await closeDb();
  }
}

export async function pushStaged(input: {
  projectRoot: string;
  config: ProjectConfig;
  api?: CloudApi;
  /** What a human was shown. When given, only these atoms are sent, and only if unchanged. */
  snapshot?: PushSnapshot;
  /** Refuse when the queue merely GREW, not only when a listed atom changed. */
  strict?: boolean;
}): Promise<PushResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const staged = await listStaged(pointer.workspaceId);

    if (staged.length === 0) {
      return { status: 'pushed', created: 0, updated: 0, conflicts: [], rejected: [] };
    }

    // The role rides on every sync response, so refusing a reader here costs nothing and saves a
    // round trip that could only end in a 403. A replica synced by a build older than the column
    // has no role recorded: that is **unknown, not denied**, and the push proceeds and lets the
    // server decide, because refusing on missing local state would block a legitimate editor
    // over a column that had not been invented yet.
    const role = await withTeamStore(pointer.workspaceId, input.projectRoot, () => readSyncState())
      .then(state => state?.role ?? null)
      .catch(() => null);
    if (role === 'reader') return { status: 'forbidden', role };

    const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
    const credential = await ensureAccessToken({
      apiHost: pointer.apiHost,
      refresh: refreshToken => api.refresh(refreshToken),
    });
    if (!credential) return { status: 'not-logged-in' };

    // Read once for the whole batch rather than per atom: every item in this push is embedded by
    // the same local profile, and resolving it is not free.
    const profile = resolveVectorProfile(input.config);
    const fingerprint = fingerprintProfile(profile);

    let items: PublishItem[];
    let unembedded: string[];

    if (input.snapshot) {
      const promised = new Map(input.snapshot.items.map(entry => [entry.itemId, entry]));
      const stagedNow = new Set(staged.map(row => row.itemId));
      const hashes = await stagedHashes([...promised.keys()].filter(id => stagedNow.has(id)));

      const changed = [...promised.values()]
        .filter(entry => stagedNow.has(entry.itemId))
        .filter(entry => {
          const now = hashes.get(entry.itemId);
          return !now
            || now.contentHash !== entry.contentHash
            || now.lifecycleHash !== entry.lifecycleHash;
        })
        .map(entry => entry.itemId);

      const added = staged.map(row => row.itemId).filter(id => !promised.has(id));

      // A changed atom always refuses: its text is not what the human read. An addition only
      // refuses under `strict`, because it will go in the next push either way and refusing by
      // default would let a busy agent block every push it runs beside.
      if (changed.length > 0 || (input.strict && added.length > 0)) {
        return { status: 'snapshot-stale', added, changed };
      }

      // Sent from the SNAPSHOT, intersected with what is still staged. The payload is the object
      // that was hashed and shown -- never a fresh read, which is the window this closes.
      items = input.snapshot.items
        .filter(entry => stagedNow.has(entry.itemId))
        .map(entry => entry.payload);
      // Carried from the snapshot rather than recomputed. `computePushSnapshot` already did the
      // work of finding them, and re-reading here would reopen the very window the snapshot
      // exists to close -- an atom embedded between the prompt and the send would slip through.
      unembedded = input.snapshot.unembedded.filter(id => stagedNow.has(id));
    } else {
      items = [];
      unembedded = [];
      for (const record of staged) {
        const loaded = await loadPublishItem(
          record.itemId, pointer.workspaceId, profile, fingerprint,
        );
        // A staged id whose row is gone cannot be published and must not be invented. It stays in
        // the ledger rather than being swept: the ledger is a record of intent, and deleting the
        // intent here would be this command silently editing what the user asked for.
        if ('item' in loaded) items.push(loaded.item);
        // An atom that exists but has no vector under the current profile is a different case
        // with a different remedy, and reporting it is the whole reason this is not a bare null.
        else if (loaded.skipped === 'no-vector') unembedded.push(record.itemId);
      }
    }

    // One rule on both paths: an unembedded staged atom blocks the push and names the fix.
    // Refused here rather than at the server -- same verdict, one round trip earlier.
    if (unembedded.length > 0) {
      return { status: 'needs-embedding', count: unembedded.length, remedy: 'knowl reindex --vectors' };
    }
    if (items.length === 0) {
      return { status: 'pushed', created: 0, updated: 0, conflicts: [], rejected: [] };
    }

    let created = 0;
    let updated = 0;
    const conflicts: PublishOutcome[] = [];
    const rejected: PublishOutcome[] = [];

    for (let start = 0; start < items.length; start += MAX_BATCH) {
      // A thrown CloudApiError propagates. The secret case in particular must NOT be caught and
      // converted into a partial success: the batch failed, and the ledger correctly still says
      // every atom in it is unsent. The rejection is terminal -- never retried, and never
      // retried in altered form.
      const { outcomes } = await api.publishItems({
        workspaceId: pointer.workspaceId,
        accessToken: credential.accessToken,
        originRepo: pointer.repo,
        items: items.slice(start, start + MAX_BATCH),
      });

      for (const outcome of outcomes) {
        if (outcome.status === 'created' || outcome.status === 'updated') {
          await recordPushed(outcome.id, pointer.workspaceId, outcome.version);
          if (outcome.status === 'created') created += 1; else updated += 1;
          continue;
        }
        // Everything else stays staged. A conflict means the local copy is stale and the remedy
        // is to re-read, not to insist; `foreign_origin` and `tombstoned` mean a retry cannot
        // succeed at all, which is exactly why the server reports them separately.
        if (outcome.status === 'conflict') conflicts.push(outcome);
        else rejected.push(outcome);
      }
    }

    return { status: 'pushed', created, updated, conflicts, rejected };
  } finally {
    await closeDb();
  }
}

/**
 * One atom, as the wire wants it.
 *
 * `expectedVersion` is **omitted** on a first publish rather than sent as null: a first publish
 * has no remote version to be stale against, and a null would be a claim about a row that does
 * not exist. On a republish the ledger's number is the only copy on this machine, and the server
 * treats a republish without one as a conflict deliberately.
 */
/**
 * What a staged id yielded, and why it yielded nothing.
 *
 * `null` used to mean "the row is gone", and that was the only reason. There is a second one
 * now -- the atom has no vector under the current profile -- and the two have different
 * remedies: nothing can be done about a deleted row, while an unembedded one is
 * `knowl reindex --vectors`. Collapsing both to null made the second invisible, and a push
 * would report success for atoms it never sent.
 */
export type LoadedPublishItem =
  | { item: PublishItem }
  | { skipped: 'missing' | 'no-vector' };

async function loadPublishItem(
  itemId: string,
  workspace: string,
  profile: VectorProfile,
  fingerprint: string,
): Promise<LoadedPublishItem> {
  const result = await getClient().execute({
    sql: `SELECT id, category, title, content, reasoning, alternatives, tags, source, source_commit,
                 affected_paths, content_hash, lifecycle_hash, status, freshness, confidence, tier,
                 provenance, conflict_key, conflict_scope, conflict_exclusive
          FROM knowledge_items WHERE id = ?`,
    args: [itemId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { skipped: 'missing' };

  // READ, never recompute. The vector was built when the atom was written; re-embedding here
  // would spend a forward pass to reproduce a value already on disk -- and would produce a
  // DIFFERENT one if the local profile changed since, which is exactly the corruption the
  // fingerprint exists to prevent.
  //
  // Filtered on the current fingerprint, so a row built by an older profile or an older RECIPE
  // does not match and the atom is correctly treated as unembedded. `EMBED_RECIPE_VERSION` is
  // part of that hash, which is what makes a recipe change visible here at all.
  const embedding = await getClient().execute({
    sql: `SELECT vector, dimensions FROM knowledge_embeddings
          WHERE knowledge_item_id = ? AND profile_fingerprint = ?`,
    args: [itemId, fingerprint],
  });
  const stored = embedding.rows[0] as Record<string, unknown> | undefined;
  if (!stored) return { skipped: 'no-vector' };

  const values = decodeStoredVector(stored.vector);
  if (!values) return { skipped: 'no-vector' };

  // Citations travel with the atom. `sync-apply.ts` has always written them on the way DOWN, so
  // leaving them out here made the pipe one-directional: every atom this client published arrived
  // at the team store uncited, and nothing anywhere went red about it.
  //
  // Failing soft, like `steps` below: an atom that reaches the team without its citations is worth
  // more than one that never leaves because a join failed.
  const evidence: PublishEvidence[] = await listEvidenceForItem(itemId).then(
    rows => rows.map(entry => ({
      id: entry.id,
      type: entry.type,
      locator: entry.locator,
      contentHash: entry.contentHash ?? null,
      excerpt: entry.excerpt ?? null,
      observedAt: entry.observedAt,
      metadata: (entry.metadata ?? null) as Record<string, unknown> | null,
      relationship: entry.relationship,
    })),
    () => [],
  );

  // `knowledgeItemId` is dropped deliberately: the assertion rides inside the atom that owns it,
  // so repeating the owner on the wire would be a second source of truth for the same fact.
  const assertions: PublishAssertion[] = await listAssertions(itemId).then(
    rows => rows.map(entry => ({
      id: entry.id,
      content: entry.content,
      validFrom: entry.validFrom,
      validTo: entry.validTo ?? null,
      recordedAt: entry.recordedAt,
      replacedAt: entry.replacedAt ?? null,
      confidence: entry.confidence,
      sourceEvidenceId: entry.sourceEvidenceId ?? null,
    })),
    () => [],
  );

  const steps = await getClient().execute({
    sql: 'SELECT instruction FROM skill_steps WHERE knowledge_item_id = ? ORDER BY step_order',
    args: [itemId],
  }).then(
    found => found.rows.map(step => String(step.instruction)),
    // A skill whose steps could not be read publishes as an inert title, so it is better to send
    // none than to send a partial list that reads as the whole procedure.
    () => [] as string[],
  );

  const expectedVersion = await publishedVersion(itemId, workspace);

  const item: PublishItem = {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    content: String(row.content),
    reasoning: row.reasoning === null || row.reasoning === undefined ? null : String(row.reasoning),
    alternatives: parseJson<string[]>(row.alternatives),
    tags: parseJson<string[]>(row.tags),
    source: row.source === null || row.source === undefined ? null : String(row.source),
    sourceCommit: row.source_commit === null || row.source_commit === undefined ? null : String(row.source_commit),
    affectedPaths: parseJson<string[]>(row.affected_paths),
    contentHash: row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    lifecycleHash: row.lifecycle_hash === null || row.lifecycle_hash === undefined ? null : String(row.lifecycle_hash),
    status: String(row.status),
    freshness: String(row.freshness),
    confidence: Number(row.confidence),
    provenance: row.provenance === null || row.provenance === undefined ? null : String(row.provenance),
    conflictKey: row.conflict_key === null || row.conflict_key === undefined ? null : String(row.conflict_key),
    conflictScope: parseJson<Record<string, unknown>>(row.conflict_scope),
    conflictExclusive: Number(row.conflict_exclusive) === 1,
    // Omitted when absent rather than sent as null: the schema treats each as optional, and an
    // empty array would assert "this atom has no citations" where "none recorded" is the truth.
    ...(row.tier === null || row.tier === undefined ? {} : { tier: String(row.tier) }),
    ...(steps.length > 0 ? { steps } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(assertions.length > 0 ? { assertions } : {}),
    ...(expectedVersion === null ? {} : { expectedVersion }),
    vector: encodeVectorToBase64(values),
    profileFingerprint: {
      provider: profile.provider,
      model: profile.model,
      dtype: profile.dtype,
      pooling: profile.pooling,
      recipeVersion: EMBED_RECIPE_VERSION,
    },
  };
  return { item };
}

/**
 * The stored vector as numbers, whichever encoding the row happens to hold.
 *
 * `src/store/vector.ts` writes packed float32 and still reads the JSON arrays older builds wrote,
 * so this defers to it rather than assuming one shape.
 */
function decodeStoredVector(value: unknown): number[] | null {
  const decoded = decodeStoredVectorValue(value);
  if (!decoded) return null;
  return Array.from(decoded);
}

/**
 * How many rows a category sweep would stage, per category.
 *
 * Not the same question `countPromotable` asks. Promotion looks at `visibility`; staging looks at
 * the ledger -- an atom already queued or already pushed is not a candidate -- and at
 * `cloud_excluded`, because the sweep filters those out and a picker that offered them would
 * promise something the sweep then silently drops.
 *
 * Reads the ambient database. The caller owns opening it.
 */
export async function countStageable(
  workspaceId: string,
  repoName: string,
): Promise<Record<KnowledgeCategory, number>> {
  const rows = await getClient().execute({
    sql: `SELECT k.category AS category, COUNT(*) AS n
          FROM knowledge_items k
          LEFT JOIN cloud_published p
            ON p.item_id = k.id AND p.remote_workspace = ?
          WHERE k.status = 'active'
            AND (k.origin_repo IS NULL OR k.origin_repo = ?)
            AND (p.item_id IS NULL OR (p.stage_state <> 'pending' AND p.pushed_at IS NULL))
            AND k.id NOT IN (SELECT item_id FROM cloud_excluded)
          GROUP BY k.category`,
    args: [workspaceId, repoName],
  });
  const counts = Object.fromEntries(KNOWLEDGE_CATEGORIES.map(category => [category, 0])) as Record<KnowledgeCategory, number>;
  for (const row of rows.rows) {
    const category = String(row.category) as KnowledgeCategory;
    if (category in counts) counts[category] = Number(row.n);
  }
  return counts;
}
