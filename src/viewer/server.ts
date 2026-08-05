import crypto from 'node:crypto';
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

export type ViewerServer = {
  /** Origin only, no trailing slash and no query: callers concatenate paths onto it. */
  url: string;
  token: string;
  /** What a human opens. The token is in the URL so a copied link authenticates. */
  browseUrl: string;
  close: () => Promise<void>;
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function json(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
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

/** `decodeURIComponent` throws on a malformed escape; that has to be a 400, not a dead process. */
function segment(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length));
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function startViewer(projectRoot: string, options: { port?: number } = {}): Promise<ViewerServer> {
  await initDb(projectRoot);
  // A fresh secret per launch. Binding to 127.0.0.1 keeps other machines out; it does not keep
  // out a page the user is already viewing, which can reach loopback ports from their browser.
  const token = crypto.randomBytes(24).toString('base64url');

  async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', ...SECURITY_HEADERS }); response.end(); return; }

    const bound = server.address();
    const port = bound && typeof bound !== 'string' ? bound.port : 0;
    const host = request.headers.host ?? '';
    // A browser sends the hostname it dialled. Only the loopback literals are ours; a name that
    // merely resolves to 127.0.0.1 belongs to whoever controls that name.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) {
      json(response, { error: 'Unexpected Host header.' }, 400);
      return;
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const cookie = /(?:^|;\s*)knowl_viewer=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (!tokenMatches(url.searchParams.get('token') ?? cookie ?? '', token)) {
      json(response, { error: 'Missing or invalid viewer token.' }, 401);
      return;
    }

    const pathname = url.pathname;
    if (pathname === '/api/graph') return json(response, await buildGraph());
    if (pathname === '/api/brain') return json(response, await listKnowledgeItems());
    if (pathname === '/api/decisions') return json(response, (await listKnowledgeItems()).filter(item => item.category === 'decision'));
    if (pathname === '/api/stale') return json(response, (await listKnowledgeItems()).filter(item => item.freshness !== 'fresh'));
    if (pathname === '/api/conflicts') return json(response, await listActiveConflictKeys());
    if (pathname === '/api/access') return json(response, await getKnowledgeAccessReport());
    if (pathname === '/api/skills') return json(response, await listSkillPackages(projectRoot));
    if (pathname === '/api/retrieval') return json(response, await queryKnowledgeForAgentExplained('local', { query: url.searchParams.get('q') ?? '', limit: 10, surface: 'viewer' }));
    if (pathname.startsWith('/api/evidence/')) return json(response, await listEvidenceForItem(segment(pathname, '/api/evidence/')));
    if (pathname.startsWith('/api/timeline/')) return json(response, await listAssertions(segment(pathname, '/api/timeline/')));
    if (pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The page then reaches the API on its own, without the token in every URL it builds.
        'set-cookie': `knowl_viewer=${token}; Path=/; HttpOnly; SameSite=Strict`,
        ...SECURITY_HEADERS,
      });
      response.end(VIEWER_HTML);
      return;
    }
    json(response, { error: 'Not found.' }, 404);
  }

  const server = http.createServer((request, response) => {
    // Node does not convert a rejected listener promise into a 500 -- it raises
    // `unhandledRejection`, which this process is configured to die on. One malformed
    // percent-escape in a URL was enough to take the viewer down.
    void route(request, response).catch(error => {
      const status = error instanceof URIError ? 400 : 500;
      if (!response.headersSent) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      }
      response.end(JSON.stringify({ error: status === 400 ? 'Malformed request.' : 'Internal viewer error.' }));
    });
  });

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer failed to bind a local port.');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    token,
    browseUrl: `${url}/?token=${token}`,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); },
  };
}
