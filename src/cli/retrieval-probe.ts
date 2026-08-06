import { sql } from 'drizzle-orm';
import { getDb } from '../store/database.js';
import { rankKnowledge } from '../store/agent-query.js';

export type RetrievalProbeCheck = { status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string };

/**
 * What the probe found. Kept separate from the message so the wording is testable without a
 * database, the way `vectorCoverageCheck` is.
 */
export type RetrievalProbeOutcome =
  | { kind: 'empty' }
  | { kind: 'unprobeable'; inspected: number }
  | { kind: 'found'; title: string; terms: string[]; rank: number; returned: number }
  | { kind: 'missed'; title: string; terms: string[]; returned: number };

/**
 * Whether every stored item is in the lexical index, not just the one the probe queried.
 *
 * The probe proves the query path works on a single item. That is exactly one item: deleting the
 * FTS rows of 624 of a real store's 625 items leaves the probe passing at "rank 1 of 1" -- and
 * "of 1" is the tell, but nothing was reading it. So membership is counted rather than sampled,
 * the same way `vectorCoverageCheck` counts embeddings instead of trusting one query.
 *
 * `dark` is the number that decides severity: an item missing from the FTS index is still
 * reachable semantically if it has a usable embedding, so a lexical gap alone is degradation.
 * An item in neither index is reachable by nothing -- it is stored, counted, backed up, and
 * permanently invisible to every agent that asks for it -- which is a failure, not a warning.
 */
export function lexicalCoverageCheck(input: {
  activeItems: number;
  indexedItems: number;
  darkItems: number;
}): RetrievalProbeCheck {
  if (input.darkItems > 0) {
    return {
      status: 'FAIL',
      message: `${input.darkItems} of ${input.activeItems} active item(s) are in neither the FTS index nor the vector index, so no query can reach them`,
      fix: 'run `knowl audit` to list them; `missing-index-row` findings are the same items',
    };
  }

  // The probe below already says an empty store is empty, and "covers all 0 item(s)" would be a
  // second line saying the same thing in worse English.
  if (input.activeItems === 0) {
    return { status: 'OK', message: 'Lexical index has nothing to cover yet' };
  }

  const missing = Math.max(0, input.activeItems - input.indexedItems);
  if (missing === 0) {
    return {
      status: 'OK',
      message: `Lexical index covers all ${input.activeItems} active item(s)`,
    };
  }

  return {
    status: 'WARN',
    message: `${missing} of ${input.activeItems} active item(s) are missing from the FTS index, so keyword search cannot reach them; they remain reachable by vector search only`,
    fix: 'run `knowl audit` to list them (`missing-index-row`)',
  };
}

/** How many stored items to consider before giving up on finding a probeable title. */
const PROBE_CANDIDATES = 25;

/**
 * How deep the item is allowed to be and still count as found. Deliberately looser than the
 * default query limit: this check asks whether search can reach a known item at all, not how
 * well it ranks it. A store where every title shares a word would otherwise fail a check about
 * something else entirely.
 */
const PROBE_DEPTH = 10;

/**
 * Words that prove nothing about retrieval because they match everything. A probe whose only
 * term is "the" passes on a store whose index is empty, since the LIKE fallback in
 * `queryKnowledgeCandidates` will still return rows.
 */
const PROBE_STOPWORDS = new Set([
  'about', 'after', 'also', 'because', 'been', 'before', 'being', 'both', 'does', 'done',
  'each', 'even', 'every', 'from', 'have', 'into', 'just', 'made', 'make', 'more', 'most',
  'must', 'only', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'under', 'until', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

/**
 * The distinctive words of a title, longest first.
 *
 * Longest first because a rare long word discriminates and a short common one does not, and the
 * probe only needs one term that genuinely points at this item. Non-ASCII titles reduce to
 * nothing here and are reported as unprobeable rather than failed -- a check that cannot build a
 * fair question must not answer it.
 */
export function probeTermsFromTitle(title: string): string[] {
  return [...new Set(title.toLowerCase().split(/[^a-z0-9]+/))]
    .filter(term => term.length >= 4 && !PROBE_STOPWORDS.has(term))
    .sort((left, right) => right.length - left.length)
    .slice(0, 4);
}

function truncate(title: string): string {
  return title.length <= 60 ? title : `${title.slice(0, 57)}...`;
}

export function retrievalProbeCheck(outcome: RetrievalProbeOutcome): RetrievalProbeCheck {
  switch (outcome.kind) {
    case 'empty':
      // An empty store is a new repository, not a broken one, and since WARN no longer decides
      // the verdict this can stay a nudge instead of a false alarm.
      return {
        status: 'WARN',
        message: 'No knowledge stored yet, so retrieval could not be probed',
        fix: 'store at least one durable fact, decision, constraint, architecture note, state item, or skill',
      };
    case 'unprobeable':
      return {
        status: 'WARN',
        message: `Retrieval self-test skipped: none of the ${outcome.inspected} most recent item(s) has a title distinctive enough to query with`,
      };
    case 'found':
      return {
        status: 'OK',
        message: `Retrieval self-test passed: "${truncate(outcome.title)}" came back at rank ${outcome.rank} of ${outcome.returned} when queried by its own title words`,
      };
    case 'missed':
      return {
        status: 'FAIL',
        message: `Retrieval self-test FAILED: querying "${outcome.terms.join(' ')}" returned ${outcome.returned} item(s), none of them "${truncate(outcome.title)}" -- the item those words are the title of. Stored knowledge is not reachable by search.`,
        fix: 'run `knowl audit`: a `missing-index-row` finding means the FTS index lost rows the item table still has',
      };
  }
}

/**
 * Whether an agent querying this store would actually get its knowledge back.
 *
 * The check this replaces called `queryKnowledgeForAgent` with no query string and no vector,
 * which `selectCandidates` treats as browsing -- it skips lexical scoring ("Browsing has no
 * lexical evidence, only an order") and skips vector search entirely. So it was `COUNT(active)
 * > 0` wearing a query's clothes, and an item present in the table but absent from the index
 * counted as proof that retrieval worked.
 *
 * What this covers and what it does not, stated plainly so nobody reads a green line as more
 * than it is: it covers the FTS index and the ranker. Vector reachability is `vectorCoverageCheck`,
 * not this. The MCP response-shaping layer is covered by neither -- this calls `rankKnowledge`,
 * below where `compactKnowledgeItem` runs, so the class of defect where a field is dropped on the
 * way out to the agent still has no doctor check.
 *
 * Probing the most recently written item is deliberate: the FTS rows are maintained by triggers,
 * so a trigger that has stopped firing shows up here immediately instead of being masked by old
 * rows that were indexed correctly back when it worked.
 *
 * Lexical only, on purpose. Embedding a probe query would download and load an ONNX model, and a
 * diagnostic that takes thirty seconds is one people stop running; vector reachability is already
 * measured separately by `vectorCoverageCheck`. Reads only -- `rankKnowledge` rather than
 * `queryKnowledgeForAgent`, because the latter records a `knowledge_access` row per hit, and
 * those rows are counted as tier confirmations and as GC liveness. Doctor runs in every
 * repository on the machine under `knowl-sync`, so the old check was quietly inflating the usage
 * signal of whichever three items happened to sort first.
 */
/**
 * Count index membership for every active item.
 *
 * `profileFingerprint` is the vector profile search will actually filter on, or null when vector
 * search is switched off. Null makes every lexically-missing item dark, which is correct: with no
 * semantic fallback configured, an item outside the FTS index has nothing left to find it.
 */
export async function runLexicalCoverage(profileFingerprint: string | null): Promise<RetrievalProbeCheck> {
  const rows = await (getDb() as any).all(sql`
    SELECT
      (SELECT COUNT(*) FROM knowledge_items WHERE status = 'active') AS active,
      (SELECT COUNT(*) FROM knowledge_items i
         WHERE i.status = 'active'
           AND EXISTS (SELECT 1 FROM knowledge_items_fts f WHERE f.item_id = i.id)) AS indexed,
      (SELECT COUNT(*) FROM knowledge_items i
         WHERE i.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM knowledge_items_fts f WHERE f.item_id = i.id)
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_embeddings e
             WHERE e.knowledge_item_id = i.id
               AND ${profileFingerprint === null ? sql`1 = 0` : sql`e.profile_fingerprint = ${profileFingerprint}`}
           )) AS dark
  `);

  return lexicalCoverageCheck({
    activeItems: Number(rows[0]?.active ?? 0),
    indexedItems: Number(rows[0]?.indexed ?? 0),
    darkItems: Number(rows[0]?.dark ?? 0),
  });
}

export async function runRetrievalProbe(projectId: string): Promise<RetrievalProbeCheck> {
  const rows = await (getDb() as any).all(sql`
    SELECT id, title FROM knowledge_items
    WHERE status = 'active'
    ORDER BY updated_at DESC
    LIMIT ${PROBE_CANDIDATES}
  `);

  if (rows.length === 0) return retrievalProbeCheck({ kind: 'empty' });

  const target = rows
    .map((row: any) => ({ id: String(row.id), title: String(row.title) }))
    .map((row: { id: string; title: string }) => ({ ...row, terms: probeTermsFromTitle(row.title) }))
    .find((row: { terms: string[] }) => row.terms.length > 0);

  if (!target) return retrievalProbeCheck({ kind: 'unprobeable', inspected: rows.length });

  const results = await rankKnowledge(projectId, {
    query: target.terms.join(' '),
    status: 'active',
    limit: PROBE_DEPTH,
  });

  const position = results.findIndex(item => item.id === target.id);
  return position >= 0
    ? retrievalProbeCheck({
      kind: 'found', title: target.title, terms: target.terms, rank: position + 1, returned: results.length,
    })
    : retrievalProbeCheck({
      kind: 'missed', title: target.title, terms: target.terms, returned: results.length,
    });
}
