import http from 'node:http';
import { initDb, closeDb } from '../store/database.js';
import { listKnowledgeItems } from '../store/repository.js';
import { listAssertions } from '../store/assertions.js';
import { listActiveConflictKeys } from '../store/conflicts.js';
import { getKnowledgeAccessReport } from '../store/access-feedback.js';
import { listSkillPackages } from '../skills/registry.js';
import { queryKnowledgeForAgentExplained } from '../store/agent-query.js';
import { listEvidenceForItem } from '../store/evidence-repository.js';
import { VIEWER_HTML } from './ui.js';

export type ViewerServer = { url: string; close: () => Promise<void> };

function json(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

type GraphNode = {
  id: string; title: string; category: string; status: string; freshness: string;
  tags: string[]; confidence: number | null; updatedAt: string | null; degree: number;
  content: string; reasoning: string | null;
};
type GraphLink = { source: string; target: string; weight: number; kind: 'tag' | 'category' };

// Build a graph of knowledge atoms (nodes) linked by shared tags, so the viewer
// can render memory as a connected neural map instead of a flat list. Large tag
// groups fan out from a hub to avoid a hairball; otherwise pairs are fully linked.
// Any atom left isolated is tied to a same-category neighbour so nothing floats free.
async function buildGraph(): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const items = await listKnowledgeItems();
  const nodes: GraphNode[] = items.map((item: any) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    status: item.status,
    freshness: item.freshness,
    tags: Array.isArray(item.tags) ? item.tags : [],
    confidence: typeof item.confidence === 'number' ? item.confidence : null,
    updatedAt: item.updatedAt ?? null,
    degree: 0,
    content: typeof item.content === 'string' ? item.content : '',
    reasoning: typeof item.reasoning === 'string' ? item.reasoning : null,
  }));

  const links = new Map<string, GraphLink>();
  const addLink = (a: string, b: string, weight: number, kind: 'tag' | 'category') => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = x + '|' + y;
    const existing = links.get(key);
    if (existing) { existing.weight += weight; if (kind === 'tag') existing.kind = 'tag'; }
    else links.set(key, { source: x, target: y, weight, kind });
  };

  const byTag = new Map<string, string[]>();
  for (const node of nodes) {
    for (const tag of node.tags) {
      const bucket = byTag.get(tag) ?? [];
      bucket.push(node.id);
      byTag.set(tag, bucket);
    }
  }
  for (const ids of byTag.values()) {
    if (ids.length < 2) continue;
    if (ids.length <= 5) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addLink(ids[i], ids[j], 1, 'tag');
    } else {
      const hub = ids[0];
      for (let k = 1; k < ids.length; k++) addLink(hub, ids[k], 1, 'tag');
    }
  }

  const degree = new Map<string, number>();
  for (const link of links.values()) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  for (const node of nodes) {
    if ((degree.get(node.id) ?? 0) === 0) {
      const neighbour = nodes.find(other => other.id !== node.id && other.category === node.category);
      if (neighbour) { addLink(node.id, neighbour.id, 0.5, 'category'); degree.set(node.id, 1); }
    }
    node.degree = degree.get(node.id) ?? 0;
  }

  return { nodes, links: [...links.values()] };
}

export async function startViewer(projectRoot: string, options: { port?: number } = {}): Promise<ViewerServer> {
  await initDb(projectRoot);
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/api/graph') return json(response, await buildGraph());
    if (pathname === '/api/brain') return json(response, await listKnowledgeItems());
    if (pathname === '/api/decisions') return json(response, (await listKnowledgeItems()).filter(item => item.category === 'decision'));
    if (pathname === '/api/stale') return json(response, (await listKnowledgeItems()).filter(item => item.freshness !== 'fresh'));
    if (pathname === '/api/conflicts') return json(response, await listActiveConflictKeys());
    if (pathname === '/api/access') return json(response, await getKnowledgeAccessReport());
    if (pathname === '/api/skills') return json(response, await listSkillPackages(projectRoot));
    if (pathname === '/api/retrieval') return json(response, await queryKnowledgeForAgentExplained('local', { query: url.searchParams.get('q') ?? '', limit: 10, surface: 'viewer' }));
    if (pathname.startsWith('/api/evidence/')) return json(response, await listEvidenceForItem(decodeURIComponent(pathname.slice('/api/evidence/'.length))));
    if (pathname.startsWith('/api/timeline/')) return json(response, await listAssertions(decodeURIComponent(pathname.slice('/api/timeline/'.length))));
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(VIEWER_HTML); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer failed to bind a local port.');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); } };
}
