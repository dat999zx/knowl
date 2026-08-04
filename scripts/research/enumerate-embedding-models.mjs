// Enumerate every embedding model that could actually run here, from the registry itself.
//
// Fixes two defects in ~/.claude/skills/research-station/scripts/enumerate-hf-models.mjs
// that silently disabled its own recency leg:
//   1. `lastModified` is not returned by /api/models unless asked for, so every row
//      printed `?` and the "sorted by modified" output was sorted by nothing.
//   2. Verification (`?blobs=true`, the step that decides whether a model is even a
//      candidate) ran over `candidates.slice(0, 70)` AFTER sorting by downloads. Anything
//      recent-but-not-yet-popular -- the entire reason for the recency leg -- was cut
//      before it was ever checked.
//
// Here: both orders are kept as separate populations, and the verified slice is the UNION
// of the top N of each.

const QUERIES = [
  'embedding', 'embed', 'gte', 'nomic', 'jina', 'granite-embedding',
  'arctic-embed', 'mxbai', 'qwen3-embedding', 'embeddinggemma', 'stella', 'bge',
  'retrieval', 'sentence-transformers', 'modernbert', 'e5',
];
const AUTHORS = ['onnx-community', 'Xenova', 'jinaai', 'Snowflake', 'ibm-granite', 'nomic-ai', 'mixedbread-ai', 'Alibaba-NLP'];

const seen = new Map();
const perOrder = { popular: new Set(), recent: new Set() };

async function collect(url, label, order) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'knowl-model-sweep' } });
    if (!res.ok) return;
    const body = await res.json();
    for (const m of body) {
      const row = seen.get(m.id) ?? { id: m.id, downloads: 0, modified: null, via: [] };
      row.downloads = Math.max(row.downloads, m.downloads ?? 0);
      if (m.lastModified) row.modified = m.lastModified.slice(0, 10);
      row.via.push(label);
      seen.set(m.id, row);
      perOrder[order].add(m.id);
    }
  } catch { /* one dead query must not kill the sweep */ }
}

// expand[] is what actually makes the API return lastModified/downloads on a search.
const EXPAND = 'expand[]=lastModified&expand[]=downloads';
for (const q of QUERIES) {
  await collect(`https://huggingface.co/api/models?search=${q}&filter=onnx&sort=downloads&direction=-1&limit=50&${EXPAND}`, `${q}/pop`, 'popular');
  await collect(`https://huggingface.co/api/models?search=${q}&filter=onnx&sort=lastModified&direction=-1&limit=50&${EXPAND}`, `${q}/new`, 'recent');
}
for (const a of AUTHORS) {
  await collect(`https://huggingface.co/api/models?author=${a}&filter=onnx&sort=lastModified&direction=-1&limit=200&${EXPAND}`, `${a}/new`, 'recent');
  await collect(`https://huggingface.co/api/models?author=${a}&filter=onnx&sort=downloads&direction=-1&limit=200&${EXPAND}`, `${a}/pop`, 'popular');
}

const EXCLUDE = /whisper|clip|vit|wav2vec|detr|yolo|florence|moondream|llava|reranker|rerank|cross-encoder|sd-|stable-diffusion|kokoro|parler|distil-whisper|codegen|janus|qwen2-vl|siglip|colbert|zeroshot|vision/i;
const KEEP = /embed|gte|bge|e5|minilm|nomic|jina|arctic|mxbai|stella|granite|gemma-embed|potion|static-retrieval/i;

const all = [...seen.values()].filter(m => KEEP.test(m.id) && !EXCLUDE.test(m.id));

const byDownloads = [...all].sort((a, b) => b.downloads - a.downloads);
const byModified = [...all].sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')));

const SLICE = 110;
const union = new Map();
for (const m of byDownloads.slice(0, SLICE)) union.set(m.id, { ...m, leg: 'popular' });
for (const m of byModified.slice(0, SLICE)) {
  const existing = union.get(m.id);
  if (existing) existing.leg = 'both'; else union.set(m.id, { ...m, leg: 'recent' });
}

console.log(JSON.stringify({
  seen: seen.size,
  plausible: all.length,
  popularOnlyIds: perOrder.popular.size,
  recentOnlyIds: perOrder.recent.size,
  verifying: union.size,
}));

const rows = [];
for (const c of union.values()) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${c.id}?blobs=true`, { headers: { 'User-Agent': 'knowl-model-sweep' } });
    if (!res.ok) continue;
    const info = await res.json();
    const files = info.siblings ?? [];
    const onnx = files.filter(s => s.rfilename.endsWith('.onnx'));
    if (onnx.length === 0) continue;
    const sizeOf = re => files.filter(s => re.test(s.rfilename)).reduce((sum, s) => sum + (s.size ?? 0), 0);
    // .onnx_data holds the weights when the graph is externalised (granite, gemma, jina v5).
    const q8Bytes = sizeOf(/model_quantized\.onnx(_data)?$/) || sizeOf(/(int8|uint8|quint8).*\.onnx(_data)?$/i);
    const fp32Bytes = sizeOf(/onnx\/model\.onnx(_data)?$/);
    rows.push({
      id: c.id,
      leg: c.leg,
      downloads: c.downloads,
      modified: c.modified ?? '?',
      q8Mb: Math.round(q8Bytes / 1e6),
      fp32Mb: Math.round(fp32Bytes / 1e6),
      dims: info.config?.hidden_size ?? null,
      lib: info.library_name ?? '',
      tags: (info.tags ?? []).filter(t => /sentence-similarity|feature-extraction|onnx|transformers\.js|mteb/.test(t)).join(','),
    });
  } catch { /* skip */ }
}

rows.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
console.log(JSON.stringify(rows, null, 1));
