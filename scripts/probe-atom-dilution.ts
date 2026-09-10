/**
 * Does one vector per atom still find that atom when the query quotes its TAIL?
 *
 * An atom gets exactly one embedding, built from `buildKnowledgeEmbeddingText` -- title,
 * content, reasoning and tags concatenated -- and pooled into a single vector. Pooling is an
 * average, so every sentence in a long atom is one of many contributors and none of them
 * dominates. A short atom's vector nearly *is* its one idea; a 6,000-character atom's vector is
 * the centroid of a dozen. The prediction that follows is that a verbatim quote from the end of
 * a long atom retrieves its own parent badly, because the parent's vector has been diluted by
 * everything the quote is not about. #281 measured that it does.
 *
 * This is the standing form of that measurement. It reads any repo's store, never writes to it,
 * and prints the corpus's own size and age first, because the whole finding is a claim about
 * LONG atoms and a store with none of them can only report that it has none.
 *
 * Two rankings are reported, and they answer different questions:
 *
 * - **Vector-only, over every stored vector.** This is the dilution measurement itself. Nothing
 *   in the fusion layer can move it, so it is the number that would falsify or confirm #281.
 * - **Fused, through `rankKnowledge` at the shipped limit.** This is the path a real query
 *   takes -- BM25 and cosine combined, priors applied, candidates capped. It is here because
 *   the vector-only table cannot see `candidateLimit` (`agent-query.ts`) at all, and that
 *   constant is the one candidate remedy that does not require chunking.
 *
 * The windowed control is what makes the result a statement about POOLING rather than about the
 * model: the same query is scored against a 500-character window cut around the quoted sentence,
 * embedded as a document by the same embedder. If the window beats the whole-atom vector, the
 * text was always retrievable and the averaging is what lost it.
 *
 * A TITLE control runs alongside and is an assertion rather than a print. A title is the first
 * line of the embed text and the least diluted query available, so if titles cannot find their
 * own parents either, the harness is broken and every number below it is meaningless -- see the
 * assertion for the exact bar and why it is set where it is.
 *
 * Usage:
 *   npx tsx scripts/probe-atom-dilution.ts                        # this repo
 *   npx tsx scripts/probe-atom-dilution.ts D:/other/repo          # a project root
 *   npx tsx scripts/probe-atom-dilution.ts /path/to/knowl.db      # a database directly
 *   npx tsx scripts/probe-atom-dilution.ts --sample 30 --min-chars 3500 --json out.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot, loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider } from '../src/ai/embeddings.js';
import { fingerprintProfile, resolveVectorProfile } from '../src/core/vector-profile.js';
import { openPeerStore } from '../src/store/store-handle.js';
import { LOCAL_PROJECT_ID, getKnowledgeItems } from '../src/store/repository.js';
import { buildKnowledgeEmbeddingText } from '../src/store/vector-index.js';
import { cosineSimilarity, decodeVector, searchKnowledgeEmbeddings } from '../src/store/vector.js';
import { rankKnowledge } from '../src/store/agent-query.js';
import { releaseAll } from '../src/store/connection-pool.js';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const number = (name: string, fallback: number): number => {
  const raw = flag(name);
  return raw === undefined ? fallback : Number(raw);
};

/** Atoms at or above this many characters of embed text are the population under test. */
const MIN_CHARS = number('min-chars', 3_500);
/** How many of them to quote. Even stride over the id-sorted population, so it is reproducible. */
const SAMPLE = number('sample', 30);
/** The page size the fused half asks for. 10 matches MRR@10 and the accuracy bench's topK. */
const FUSED_LIMIT = number('fused-limit', 10);
/** Characters of context the control gets, centred on the quoted sentence. */
const WINDOW_CHARS = number('window', 500);
const JSON_OUT = flag('json');

/** A quote shorter than this is not distinctive; longer than this is not a quote. */
const MIN_SENTENCE = 60;
const MAX_SENTENCE = 300;

/** The first argument that is neither a `--flag` nor a flag's value. */
const positional = (() => {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    return args[i];
  }
  return undefined;
})();

/**
 * Accept either half of the pair, because the two are not interchangeable to a reader: a path
 * ending in `.db` is unambiguous, and anything else is a project root. The config that names the
 * embedding profile lives beside the database, so one is always derivable from the other.
 */
async function resolveTarget(arg: string | undefined): Promise<{ root: string; dbPath: string }> {
  if (!arg) {
    const root = await findProjectRoot(process.cwd());
    return { root, dbPath: path.join(root, '.knowl', 'knowl.db') };
  }
  const resolved = path.resolve(arg);
  if (resolved.endsWith('.db')) return { root: path.dirname(path.dirname(resolved)), dbPath: resolved };
  return { root: resolved, dbPath: path.join(resolved, '.knowl', 'knowl.db') };
}

/**
 * Sentences with their offsets, because the control needs to cut a window around one and a
 * sentence with no position cannot be located in the text it came from.
 *
 * Newlines end a sentence as firmly as a full stop does: atom content is full of bullet lists
 * and table rows that never terminate with punctuation, and treating those as one continuous
 * sentence produces "quotes" spanning half the atom.
 */
function sentencesWithOffsets(text: string): Array<{ text: string; start: number }> {
  const boundary = /(?<=[.!?])\s+|\n+/g;
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    out.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  out.push({ text: text.slice(start), start });
  // Trimmed, with the offset moved by however much leading whitespace was dropped, so `start`
  // still points at the first character of the returned string.
  return out.map(entry => {
    const lead = entry.text.length - entry.text.trimStart().length;
    return { text: entry.text.trim(), start: entry.start + lead };
  });
}

/**
 * The longest quotable sentence from the final third of the text, or null when the atom has none.
 *
 * `start >= tailStart` rather than "overlaps the tail": a sentence that begins in the middle
 * third and runs into the last one is not a tail quote, and counting it would weaken exactly the
 * effect being measured.
 */
function tailQuote(text: string): { text: string; start: number } | null {
  const tailStart = Math.floor((text.length * 2) / 3);
  const candidates = sentencesWithOffsets(text).filter(entry =>
    entry.start >= tailStart && entry.text.length >= MIN_SENTENCE && entry.text.length <= MAX_SENTENCE);
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, entry) => (entry.text.length > longest.text.length ? entry : longest));
}

/** `WINDOW_CHARS` centred on the sentence and clamped to the text -- the control's document. */
function windowAround(text: string, quote: { text: string; start: number }): string {
  const centre = quote.start + quote.text.length / 2;
  const from = Math.max(0, Math.min(text.length - WINDOW_CHARS, Math.round(centre - WINDOW_CHARS / 2)));
  return text.slice(from, from + WINDOW_CHARS);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
const mean = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0) / (values.length || 1);
const days = (from: string, to: number) => (to - new Date(from).getTime()) / 86_400_000;

async function main() {
  const { root, dbPath } = await resolveTarget(positional);
  // The read-only claim, stated as a measurement rather than as a promise. `openPeerStore` opens
  // with `PRAGMA query_only = ON`, so SQLite itself refuses a write -- this is the second belt.
  const before = await fs.stat(dbPath);

  const config = await loadConfig(root);
  const profile = resolveVectorProfile(config);
  const fingerprint = fingerprintProfile(profile);
  const embedder = await createLocalEmbeddingProvider(config, root);
  const store = await openPeerStore(dbPath);
  const sql = async (text: string, args: unknown[] = []) =>
    (await store.client.execute({ sql: text, args: args as any[] })).rows as any[];

  // ---- the corpus, stated before anything is concluded about it -------------------------------
  const [counts] = await sql(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            MIN(created_at) AS oldest, MAX(created_at) AS newest
     FROM knowledge_items`);
  const [embedded] = await sql(
    `SELECT COUNT(*) AS total FROM knowledge_embeddings e
     JOIN knowledge_items i ON i.id = e.knowledge_item_id
     WHERE i.status = 'active' AND e.profile_fingerprint = ?`, [fingerprint]);
  const ages = (await sql(`SELECT created_at FROM knowledge_items WHERE status = 'active'`))
    .map(row => days(String(row.created_at), Date.now()));
  const corpus = {
    dbPath,
    fingerprint,
    model: profile.model,
    dtype: profile.dtype,
    pooling: profile.pooling,
    atoms: Number(counts.total),
    active: Number(counts.active),
    /** The ranking denominator: every vector a query is actually scored against. */
    rankedAgainst: Number(embedded.total),
    oldest: String(counts.oldest),
    newest: String(counts.newest),
    medianAgeDays: Number(median(ages).toFixed(1)),
  };
  console.log(`\n## Corpus\n`);
  console.log('```');
  console.log(`db                ${corpus.dbPath}`);
  console.log(`model             ${corpus.model} ${corpus.dtype}/${corpus.pooling}  (${corpus.fingerprint})`);
  console.log(`atoms             ${corpus.atoms} total, ${corpus.active} active`);
  console.log(`ranked against    ${corpus.rankedAgainst} vectors under this profile`);
  console.log(`age               oldest ${corpus.oldest.slice(0, 10)}, newest ${corpus.newest.slice(0, 10)},`
    + ` median atom ${corpus.medianAgeDays}d old`);
  console.log('```');

  // ---- the population, sampled by even stride over id order -----------------------------------
  const ids = (await sql(
    `SELECT i.id FROM knowledge_items i JOIN knowledge_embeddings e ON e.knowledge_item_id = i.id
     WHERE i.status = 'active' AND e.profile_fingerprint = ?
       AND LENGTH(i.title) + LENGTH(i.content) + LENGTH(COALESCE(i.reasoning, '')) >= ?
     ORDER BY i.id`, [fingerprint, MIN_CHARS])).map(row => String(row.id));

  // The SQL length is a prefilter over three columns; the real population is defined by the text
  // the embedder was actually given, which also carries the tag line.
  const items = await getKnowledgeItems(ids, store.db);
  const population = ids
    .map(id => items.get(id)!)
    .filter(item => item && buildKnowledgeEmbeddingText(item).length >= MIN_CHARS);

  if (population.length === 0) {
    console.log(`\n**No atom in this store reaches ${MIN_CHARS} characters. Nothing to measure.**\n`);
    store.client.close();
    return;
  }

  const stride = Math.max(1, Math.floor(population.length / SAMPLE));
  const sampled = [];
  for (let i = 0; sampled.length < SAMPLE && i * stride < population.length; i++) {
    sampled.push(population[i * stride]);
  }

  // Stored vectors for the control, read once. `decodeVector` handles both encodings.
  const vectorRows = await sql(
    `SELECT knowledge_item_id AS id, vector FROM knowledge_embeddings
     WHERE profile_fingerprint = ? AND knowledge_item_id IN (${sampled.map(() => '?').join(', ')})`,
    [fingerprint, ...sampled.map(item => item.id)]);
  const storedVectors = new Map(vectorRows.map(row => [String(row.id), decodeVector(row.vector)]));

  /** The parent's position in the full vector ranking, or `rankedAgainst + 1` when unreachable. */
  const vectorRankOf = async (embedding: number[], parentId: string): Promise<number> => {
    const ranked = await searchKnowledgeEmbeddings(LOCAL_PROJECT_ID, {
      vector: embedding, status: 'active', profileFingerprint: fingerprint, limit: corpus.rankedAgainst,
    }, store);
    const at = ranked.findIndex(hit => hit.item.id === parentId);
    return at < 0 ? corpus.rankedAgainst + 1 : at + 1;
  };

  const rows: any[] = [];
  const skipped: string[] = [];
  for (const item of sampled) {
    const full = buildKnowledgeEmbeddingText(item);
    // Quote from the CLIPPED text, not the full text. A quote past the token budget was never in
    // the vector at all, and finding it missing would measure truncation (#132) rather than
    // dilution -- a different defect with a different fix.
    const clip = embedder.clipToBudget?.(full) ?? { text: full, tokens: 0, clipped: false };
    const quote = tailQuote(clip.text);
    if (!quote) { skipped.push(item.id); continue; }

    const queryVector = await embedder.embedQuery(quote.text);
    const [windowVector] = await embedder.embed([windowAround(clip.text, quote)], { maxBatch: 1 });
    const stored = storedVectors.get(item.id);

    const fused = await rankKnowledge(LOCAL_PROJECT_ID, {
      query: quote.text,
      status: 'active',
      limit: FUSED_LIMIT,
      vector: {
        enabled: true,
        profileFingerprint: fingerprint,
        embedding: queryVector,
        relevanceFloor: embedder.relevanceFloor,
      },
    }, store);
    const fusedAt = fused.findIndex(hit => hit.id === item.id);

    rows.push({
      id: item.id,
      title: item.title,
      chars: full.length,
      clipped: clip.clipped,
      quote: quote.text,
      vectorRank: await vectorRankOf(queryVector, item.id),
      fusedRank: fusedAt < 0 ? null : fusedAt + 1,
      wholeCosine: stored ? cosineSimilarity(queryVector, stored) : null,
      windowCosine: cosineSimilarity(queryVector, windowVector),
    });
  }

  // ---- the control that decides whether any of the above is evidence --------------------------
  //
  // A title is the first line of the embed text and the shortest, least diluted query this store
  // can be asked. If titles cannot find their own parents, the store, the profile filter or the
  // embedder is wrong and the tail numbers measure the harness. The bar is deliberately far below
  // any plausible healthy value and far above a broken one: a working store returns the parent at
  // rank 1 for very nearly every title, and a broken one returns it for none.
  const titleRanks: number[] = [];
  for (const item of sampled.slice(0, Math.min(10, sampled.length))) {
    titleRanks.push(await vectorRankOf(await embedder.embedQuery(item.title), item.id));
  }
  const titleTop1 = titleRanks.filter(rank => rank === 1).length;
  if (!(titleTop1 >= Math.ceil(titleRanks.length / 2))) {
    throw new Error(
      `CONTROL FAILED: only ${titleTop1}/${titleRanks.length} atom titles retrieve their own atom at `
      + `rank 1 (ranks: ${titleRanks.join(', ')}). The probe cannot rank this store correctly, so `
      + `nothing it says about tail quotes is evidence about pooling.`);
  }

  // ---- the table from #281 --------------------------------------------------------------------
  const table = (label: string, ranks: Array<number | null>, ceiling: number) => {
    const found = ranks.map(rank => rank ?? ceiling);
    const atMost = (n: number) => found.filter(rank => rank <= n).length;
    const mrr = mean(found.map(rank => (rank <= 10 ? 1 / rank : 0)));
    console.log(`\n### ${label}\n`);
    console.log('| metric | value |');
    console.log('| --- | --- |');
    console.log(`| queries | ${found.length} |`);
    console.log(`| parent at rank 1 | ${atMost(1)}/${found.length} |`);
    console.log(`| parent in top 3 | ${atMost(3)}/${found.length} |`);
    console.log(`| parent in top 10 | ${atMost(10)}/${found.length} |`);
    console.log(`| median rank | ${median(found)} |`);
    console.log(`| worst rank | ${Math.max(...found)}${label.startsWith('Vector') ? ` / ${ceiling - 1}` : ` (of ${FUSED_LIMIT} returned)`} |`);
    console.log(`| MRR@10 | ${mrr.toFixed(4)} |`);
    return {
      queries: found.length, rank1: atMost(1), top3: atMost(3), top10: atMost(10),
      median: median(found), worst: Math.max(...found), mrr: Number(mrr.toFixed(4)),
    };
  };

  console.log(`\n## Tail-quote retrieval\n`);
  console.log(`Sampled ${rows.length} of ${population.length} atoms at or above ${MIN_CHARS} characters`
    + ` (stride ${stride}${skipped.length ? `, ${skipped.length} skipped for having no ${MIN_SENTENCE}-${MAX_SENTENCE} char tail sentence` : ''}).`);
  console.log(`Title control: ${titleTop1}/${titleRanks.length} at rank 1.`);
  const vectorTable = table('Vector-only, over all ' + corpus.rankedAgainst + ' stored vectors', rows.map(row => row.vectorRank), corpus.rankedAgainst + 1);
  const fusedTable = table(`Fused (rankKnowledge, limit ${FUSED_LIMIT})`, rows.map(row => row.fusedRank), FUSED_LIMIT + 1);

  // ---- the windowed control -------------------------------------------------------------------
  const scored = rows.filter(row => row.wholeCosine !== null);
  const whole = mean(scored.map(row => row.wholeCosine));
  const windowed = mean(scored.map(row => row.windowCosine));
  const advantage = mean(scored.map(row => row.windowCosine - row.wholeCosine));
  const windowWins = scored.filter(row => row.windowCosine > row.wholeCosine).length;
  console.log(`\n### Windowed control (${WINDOW_CHARS}-char window around the quoted sentence)\n`);
  console.log('| quantity | mean cosine |');
  console.log('| --- | --- |');
  console.log(`| whole-atom vector (the one stored) | ${whole.toFixed(4)} |`);
  console.log(`| ${WINDOW_CHARS}-char window around the sentence | ${windowed.toFixed(4)} |`);
  console.log(`| **window advantage** | **${advantage >= 0 ? '+' : ''}${advantage.toFixed(4)}** |`);
  console.log(`\nThe window scores higher for ${windowWins}/${scored.length} sampled atoms.`);

  const after = await fs.stat(dbPath);
  console.log(`\n### Read-only\n`);
  console.log('```');
  console.log(`before  ${before.size} bytes  mtime ${before.mtime.toISOString()}`);
  console.log(`after   ${after.size} bytes  mtime ${after.mtime.toISOString()}`);
  console.log(before.size === after.size && before.mtimeMs === after.mtimeMs
    ? 'unchanged' : 'CHANGED -- this probe wrote to the database, which is a bug in it');
  console.log('```');

  if (JSON_OUT) {
    await fs.writeFile(JSON_OUT, JSON.stringify({
      corpus,
      settings: { minChars: MIN_CHARS, sample: SAMPLE, fusedLimit: FUSED_LIMIT, windowChars: WINDOW_CHARS, stride },
      population: population.length,
      titleControl: { ranks: titleRanks, rank1: titleTop1 },
      vector: vectorTable,
      fused: fusedTable,
      control: { whole, windowed, advantage, windowWins, of: scored.length },
      rows,
    }, null, 2));
    console.error(`\nwrote ${JSON_OUT}`);
  }

  store.client.close();
  await releaseAll();
}

await main();
