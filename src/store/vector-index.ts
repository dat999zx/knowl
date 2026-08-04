import { KnowledgeItem } from '../core/types.js';
import { getClient } from './database.js';
import { iterateKnowledgeItemsForIndexing } from './index-scan.js';
import { purgeEmbeddingsNotMatching, upsertKnowledgeEmbeddings } from './vector.js';

/**
 * How the texts handed to `embed` may be grouped into forward passes.
 *
 * `maxBatch: 1` means "give me a vector that depends on nothing but this text". The q8 graph
 * quantises per batch, so a text's vector moves depending on which neighbours share its forward
 * pass: measured on this store's own 483 atoms, alone against the shipped planner, the cosine
 * moves up to 4.79e-2, and a batch of 32 identical copies is exact while any heterogeneous
 * neighbour is not. It is not sequence length -- length-sorting does not reduce it.
 *
 * That matters because the same text is embedded by two different callers with different batch
 * shapes: a write embeds one item, a reindex embeds a page of 500. Without this option the two
 * disagree, and the ranking a store returns depends on when it was last reindexed.
 */
export type EmbedOptions = { maxBatch?: number };

export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  pooling: 'mean' | 'cls';
  /** Stamped on every row this embedder writes, and the filter its queries search under. */
  profileFingerprint: string;
  /**
   * Below this raw cosine, this model's best match is noise. `null` when nobody has measured
   * this model, which means no abstention rather than a borrowed number.
   *
   * It lives on the embedder because a cosine scale belongs to the model that produced it, so
   * the thing that makes the vectors is the thing that knows what they mean. Every caller that
   * already passes an embedding passes this beside it and needs to know nothing more.
   */
  relevanceFloor: number | null;
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  /**
   * A QUERY, not a document.
   *
   * Retrieval models are trained asymmetrically: the query carries an instruction the
   * document does not. Arctic and E5 want `query: `, Nomic wants `search_query: `. Omitting
   * it is the same class of silent mistake as the wrong pooling -- the model still returns
   * vectors, they are just measurably worse, and nothing reports a problem.
   *
   * A separate entry point rather than a flag on `embed`, because the asymmetry is invisible
   * at the call site otherwise, and every caller that forgets it loses accuracy silently.
   */
  embedQuery(text: string): Promise<number[]>;
};

export type VectorReindexResult = {
  indexed: number;
  /** Items left alone because this profile already has a current vector for them. */
  skipped: number;
  purged: number;
  byStatus: Record<string, number>;
};

export type VectorReindexOptions = {
  /**
   * Re-embed every item even when its stored vector is current.
   *
   * The escape hatch for staleness the fingerprint cannot see: `buildKnowledgeEmbeddingText`
   * changing what it feeds the model produces different vectors from the same profile, and
   * nothing in the database records which shape of text a row was built from.
   */
  force?: boolean;
};

export function buildKnowledgeEmbeddingText(item: KnowledgeItem): string {
  const tags = item.tags?.length ? `\nTags: ${item.tags.join(', ')}` : '';
  const reasoning = item.reasoning ? `\nReasoning: ${item.reasoning}` : '';
  return `${item.title}\n${item.content}${reasoning}${tags}`;
}

/**
 * Bring every stored vector up to date under the embedder's current profile.
 *
 * Every status, not just active: a superseded or archived item is still returned by
 * time-travel and archive queries, and leaving it unembedded made it reachable by
 * keyword alone while its active neighbours ranked semantically.
 *
 * Only the items that need it are embedded. A model change invalidates everything at once
 * -- no row carries the new fingerprint -- so that case still rebuilds the whole store,
 * while a routine run after a few writes costs a few forward passes instead of one per
 * item. Embedding is the expensive part by orders of magnitude, so re-embedding a corpus
 * to write back vectors identical to the ones already stored was the whole cost of the run.
 */
export async function reindexKnowledgeEmbeddings(
  projectId: string,
  embedder: KnowledgeEmbedder,
  options: VectorReindexOptions = {},
): Promise<VectorReindexResult> {
  let indexed = 0;
  const byStatus: Record<string, number> = {};
  // Read before the loop: an item embedded during this run must not be counted as skipped.
  const total = options.force ? 0 : await countKnowledgeItems();

  const scan = iterateKnowledgeItemsForIndexing(projectId, {
    needsEmbeddingFor: options.force ? undefined : embedder.profileFingerprint,
  });

  for await (const batch of scan) {
    // One text per forward pass, so a reindex reproduces exactly what write-time embedding
    // produced for the same text rather than shifting it by up to 4.79e-2 cosine. See
    // `EmbedOptions`.
    //
    // It costs nothing on real atoms, because at the token budget 447 of the 483 in this
    // store are already alone in their batch. The only work that changes is the 12 batches
    // holding the other 36: 2.18 s grouped against 2.13 s one at a time, i.e. -0.06 s across
    // the whole corpus. It is a real cost only where atoms are short enough to pack -- 300
    // atoms of ~35 tokens take 4.9 s in 10 passes and 6.1 s in 300 -- which is the transcript
    // path's shape, and why the transcript path keeps batching.
    //
    // This pairs with `needsEmbeddingFor` above, and the pairing is what makes the guarantee
    // hold across an upgrade rather than only within one build. Skipping a row trusts its
    // stored vector, and a row written by a build that batched carries the same profile
    // fingerprint while holding a materially different vector -- so the skip would preserve
    // exactly the disagreement `maxBatch: 1` exists to remove. `batchPolicy` is therefore part
    // of the fingerprint (see `core/vector-profile.ts`): the shape of the forward pass is an
    // input to the vector, so it belongs in the identity of the vector, and every row written
    // under the old policy is invalidated the way a model change invalidates one.
    const vectors = await embedder.embed(batch.map(buildKnowledgeEmbeddingText), { maxBatch: 1 });

    // One transaction per page, not one per row. Embedding happens above, outside it, so the
    // transaction is open only for the writes. See `upsertKnowledgeEmbeddings`: a row written
    // on its own fsyncs the WAL, which cost 11.57 ms per row against 0.088 ms batched.
    const writes = [];
    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      writes.push({
        projectId,
        knowledgeItemId: batch[i].id,
        provider: embedder.provider,
        model: embedder.model,
        profileFingerprint: embedder.profileFingerprint,
        dimensions: vector.length,
        vector,
      });
      indexed++;
      const status = batch[i].status ?? 'active';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    await upsertKnowledgeEmbeddings(writes);
  }

  // Runs last so an interrupted rebuild never deletes rows it has not replaced.
  const purged = await purgeEmbeddingsNotMatching(projectId, embedder.profileFingerprint);

  return { indexed, skipped: Math.max(0, total - indexed), purged, byStatus };
}

/** How many items a full pass would have visited, for the skipped count. */
async function countKnowledgeItems(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM knowledge_items');
  return Number((rows.rows[0] as any)?.total ?? 0);
}
