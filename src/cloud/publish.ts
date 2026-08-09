import type { KnowledgeCategory, ProjectConfig } from '../core/types.js';
import { closeDb, getClient, initDb } from '../store/database.js';
import { selectOwnedItems, type PromoteTarget } from '../workspace/promote.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import {
  listStaged, publishedVersion, recordPushed, restageForPublish, stageForPublish,
} from './ledger.js';
import { checkPublishGate, currentBranchOf } from './publish-gate.js';
import { readSyncState } from './sync-state.js';
import { listAssertions } from '../store/assertions.js';
import { listEvidenceForItem } from '../store/evidence-repository.js';
import type { PublishAssertion, PublishEvidence, PublishItem, PublishOutcome } from './sync-contract.js';
import { withTeamStore } from './team-store.js';
import { ensureAccessToken } from './token.js';

export type StageResult =
  | { status: 'not-connected' }
  | { status: 'staged'; items: PromoteTarget[]; applied: boolean; skippedForeign: number };

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
  const pointer = input.config.cloud;
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const { items, skippedForeign } = await selectOwnedItems({
      repoName: pointer.repo,
      categories: input.categories,
      ids: input.ids,
    });

    if (input.apply && items.length > 0) {
      // Swallowed on purpose, and only here. The branch is what the push's refusal quotes back,
      // not what it decides on -- `checkPublishGate` re-reads git itself and reports being
      // unable to run it as its own verdict. Failing to record an intent because git is missing
      // would refuse the one half of publishing that is safe from every vantage.
      let branch: string | null = null;
      try { branch = currentBranchOf(input.projectRoot); } catch { branch = null; }

      // Naming ids is a deliberate act about items the caller has in hand, and it is the only
      // way to send a correction, so it re-stages what was already pushed. A category sweep
      // means "publish what is not published yet" and leaves those alone -- otherwise every
      // `knowl publish --category decision --apply` would re-send the whole category, spending a
      // version bump and a server-side embedding job per atom on identical content.
      const stage = input.ids?.length ? restageForPublish : stageForPublish;
      await stage(items.map(item => item.id), pointer.workspaceId, branch);
    }

    return { status: 'staged', items, applied: Boolean(input.apply) && items.length > 0, skippedForeign };
  } finally {
    await closeDb();
  }
}

export type PushResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'gated'; reason: string; detail: string; staged: number }
  | { status: 'forbidden'; role: string }
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
export async function pushStaged(input: {
  projectRoot: string;
  config: ProjectConfig;
  api?: CloudApi;
}): Promise<PushResult> {
  const pointer = input.config.cloud;
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const staged = await listStaged(pointer.workspaceId);

    // Before the gate, deliberately. Reporting `gated` when there is nothing to send would be a
    // refusal about nothing -- it would tell a developer on a feature branch to go and pull, for
    // a push that had no work in it either way.
    if (staged.length === 0) {
      return { status: 'pushed', created: 0, updated: 0, conflicts: [], rejected: [] };
    }

    const verdict = checkPublishGate(input.projectRoot);
    if (!verdict.ok) {
      return { status: 'gated', reason: verdict.reason, detail: verdict.detail, staged: staged.length };
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

    const items: PublishItem[] = [];
    for (const record of staged) {
      const item = await loadPublishItem(record.itemId, pointer.workspaceId);
      // A staged id whose row is gone cannot be published and must not be invented. It stays in
      // the ledger rather than being swept: the ledger is a record of intent, and deleting the
      // intent here would be this command silently editing what the user asked for.
      if (item) items.push(item);
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
async function loadPublishItem(itemId: string, workspace: string): Promise<PublishItem | null> {
  const result = await getClient().execute({
    sql: `SELECT id, category, title, content, reasoning, alternatives, tags, source, source_commit,
                 affected_paths, content_hash, lifecycle_hash, status, freshness, confidence, tier,
                 provenance, conflict_key, conflict_scope, conflict_exclusive
          FROM knowledge_items WHERE id = ?`,
    args: [itemId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

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

  return {
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
  };
}
