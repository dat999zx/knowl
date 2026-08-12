import type { ProjectConfig } from '../core/types.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { LOCAL_PROJECT_ID } from '../store/repository.js';
import { reindexKnowledgeEmbeddings } from '../store/vector-index.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import { ensureAccessToken } from './token.js';
import { runSync, type SyncResult } from './sync.js';
import { withTeamStore } from './team-store.js';
import { getClient } from '../store/database.js';
import { fingerprintProfile, resolveVectorProfile, type VectorProfile } from '../core/vector-profile.js';

/**
 * The sync outcome is nested, not spread.
 *
 * `SyncResult` carries its own `status` -- `synced`, `incomplete` or `resynced` -- so
 * spreading it beside `status: 'pulled'` would make one field mean two different things, and
 * whichever came last would silently win.
 */
export type PullResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'pulled'; sync: SyncResult };

export async function runPull(input: {
  projectRoot: string;
  config: ProjectConfig;
  api?: CloudApi;
}): Promise<PullResult> {
  const pointer = input.config.cloud;
  if (!pointer) return { status: 'not-connected' };

  const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return { status: 'not-logged-in' };

  const result = await runSync({
    workspaceId: pointer.workspaceId,
    apiHost: pointer.apiHost,
    configRoot: input.projectRoot,
    api,
    accessToken: credential.accessToken,
    vectors: await localVectorContext(input.projectRoot, input.config, pointer.workspaceId),
  });

  await embedReplica(input.projectRoot, input.config, pointer.workspaceId, result);

  return { status: 'pulled', sync: result };
}

/**
 * What a received vector should be stored as, and how wide it must be.
 *
 * The fingerprint written locally is the LOCAL one, which is correct rather than a shortcut:
 * this client only connected because its profile matches the workspace's, so a vector the server
 * built genuinely belongs to the local space and must be filterable by local search like any
 * other row.
 *
 * The width comes from what this repository has already produced, because knowl's presets do not
 * record one -- it appears only in their prose labels. A repo with no embeddings yet has nothing
 * to be inconsistent with, so `null` accepts whatever arrives.
 */
async function localVectorContext(
  projectRoot: string,
  config: ProjectConfig,
  workspaceId: string,
): Promise<{ profile: VectorProfile; fingerprint: string; dimensions: number | null } | undefined> {
  if (!isVectorSearchEnabled(config)) return undefined;

  const profile = resolveVectorProfile(config);
  const fingerprint = fingerprintProfile(profile);
  const dimensions = await withTeamStore(workspaceId, projectRoot, async () => {
    const row = await getClient().execute({
      sql: 'SELECT dimensions FROM knowledge_embeddings WHERE profile_fingerprint = ? LIMIT 1',
      args: [fingerprint],
    });
    return row.rows[0] ? Number(row.rows[0].dimensions) : null;
  }).catch(() => null);

  return { profile, fingerprint, dimensions };
}

/**
 * Embed only what arrived WITHOUT a usable vector.
 *
 * Narrowed rather than deleted. The design's first draft said this function disappears once the
 * feed carries vectors; it does not, because every row of a workspace mid-reindex arrives
 * text-only by design -- so removing it would break pull during exactly the operation it most
 * needs to survive. It also covers a client that connected while some atoms were still
 * unindexed server-side.
 *
 * The narrowing needs no id list: `reindexKnowledgeEmbeddings` already skips any item whose
 * stored row carries the current fingerprint, and the apply has just written exactly those. So
 * the rows that arrived with a vector are skipped for free, and only `needEmbedding` costs a
 * forward pass.
 *
 * Best-effort and after the rows are already stored: a forward pass is slow, and failing it must
 * not lose knowledge that is already committed. The replica stays lexically searchable either
 * way -- the FTS mirror is trigger-maintained, so the apply populated it -- and the next pull
 * closes the gap.
 *
 * The project id is the synthetic `LOCAL_PROJECT_ID` rather than a row looked up from the
 * replica: this schema has no projects table, and `getProjectByRootPath` returns that same
 * constant for every root. The embedder is built from the *project's* config and root, not the
 * replica's, so team rows land in the same vector space as local ones.
 */
async function embedReplica(
  projectRoot: string,
  config: ProjectConfig,
  workspaceId: string,
  result: SyncResult,
): Promise<void> {
  if (result.needEmbedding.length === 0 || !isVectorSearchEnabled(config)) return;

  await withTeamStore(workspaceId, projectRoot, async () => {
    const embedder = await createLocalEmbeddingProvider(config, projectRoot);
    await reindexKnowledgeEmbeddings(LOCAL_PROJECT_ID, embedder);
  }).catch(() => {});
}
