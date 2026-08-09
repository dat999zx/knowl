import type { ProjectConfig } from '../core/types.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { LOCAL_PROJECT_ID } from '../store/repository.js';
import { reindexKnowledgeEmbeddings } from '../store/vector-index.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import { ensureAccessToken } from './token.js';
import { runSync, type SyncResult } from './sync.js';
import { withTeamStore } from './team-store.js';

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
  });

  await embedReplica(input.projectRoot, input.config, pointer.workspaceId, result);

  return { status: 'pulled', sync: result };
}

/**
 * Embed what just landed, best-effort and after the rows are already stored.
 *
 * Exactly how local writes are embedded: a forward pass is slow, and failing it must not lose
 * knowledge that is already committed. The replica stays lexically searchable either way --
 * the FTS mirror is trigger-maintained, so it was populated by the apply itself -- and the next
 * pull closes the gap.
 *
 * The project id is the synthetic `LOCAL_PROJECT_ID` rather than a row looked up from the
 * replica: this schema has no projects table, and `getProjectByRootPath` returns that same
 * constant for every root. The embedder is built from the *project's* config and root, not the
 * replica's, so team rows land in the same vector space as local ones -- embedded under any
 * other profile they would be filtered out by the local ranker and the replica would silently
 * contribute nothing.
 */
async function embedReplica(
  projectRoot: string,
  config: ProjectConfig,
  workspaceId: string,
  result: SyncResult,
): Promise<void> {
  if (result.upserted === 0 || !isVectorSearchEnabled(config)) return;

  await withTeamStore(workspaceId, projectRoot, async () => {
    const embedder = await createLocalEmbeddingProvider(config, projectRoot);
    await reindexKnowledgeEmbeddings(LOCAL_PROJECT_ID, embedder);
  }).catch(() => {});
}
