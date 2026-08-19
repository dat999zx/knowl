import crypto from 'node:crypto';
import http from 'node:http';
import { initDb, closeDb } from '../store/database.js';
import {
  createKnowledgeItem, getKnowledgeItem, listKnowledgeItems, updateKnowledgeItem,
} from '../store/repository.js';
import { listAssertions } from '../store/assertions.js';
import { listActiveConflictKeys } from '../store/conflicts.js';
import { getAccessSummary, getKnowledgeAccessReport } from '../store/access-feedback.js';
import { KnowledgeValidationError } from '../core/knowledge-validation.js';
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

/** A local editor sends a form, not a file. 64 KB is far past the longest atom in any store. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    // Over the cap we keep READING and stop KEEPING. Breaking or throwing out of a `for await`
    // calls the iterator's return(), which destroys the IncomingMessage and with it the socket
    // — while the client is still writing. The 413 then never arrives: a body just over the cap
    // got a status, a 5 MB one got ECONNRESET. Draining costs nothing we were not already
    // reading off the socket, and nothing beyond the cap is ever buffered.
    if (!tooLarge) chunks.push(chunk as Buffer);
  }
  if (tooLarge) throw new BodyTooLarge();
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * What a person may change. `id`, `status`, `version`, `originRepo` and `writtenBy` are absent
 * deliberately: an atom keeps its identity, its lineage and its authorship across every
 * revision, and archiving has its own route so it cannot happen by mistyping a field name.
 *
 * An unknown key is refused rather than dropped. A silently ignored field looks exactly like a
 * successful edit to whoever sent it, which is the worst outcome available here -- the user
 * walks away believing the correction landed.
 */
const CATEGORIES = ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'];

/**
 * Names alone are not enough: the shape has to be checked too.
 *
 * `tags` is the one that bites. `stringFields`'s `arrayField`
 * (`src/core/knowledge-validation.ts`) returns `[]` for anything that is not an array, so the
 * secret scanner simply skips a non-array — `tags: ["ghp_…"]` is refused and the identical
 * `tags: "ghp_…"` as a string was stored. A name-only whitelist made "all writes are
 * secret-validated" false.
 *
 * `category` is the other: the column is `text().notNull()` with no CHECK and nothing validates
 * it at runtime, so an atom could be filed under a category no query or MCP enum will ever name,
 * making it invisible rather than wrong.
 */
function assertFieldShape(key: string, value: unknown): void {
  switch (key) {
    case 'title':
    case 'content':
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${key} must be a non-empty string.`);
      }
      return;
    case 'reasoning':
      // The edit form clears this by sending null, so null is a value here and not an omission.
      if (value !== null && typeof value !== 'string') throw new TypeError('reasoning must be a string or null.');
      return;
    case 'tags':
      if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) {
        throw new TypeError('tags must be an array of strings.');
      }
      return;
    case 'category':
      if (typeof value !== 'string' || !CATEGORIES.includes(value)) {
        throw new TypeError(`category must be one of: ${CATEGORIES.join(', ')}.`);
      }
      return;
    case 'confidence':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError('confidence must be a number between 0 and 1.');
      }
      return;
    default:
      throw new TypeError(`Not editable: ${key}`);
  }
}

function onlyEditableFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Body must be an object.');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    assertFieldShape(key, value);
    patch[key] = value;
  }
  return patch;
}

/**
 * A new atom, from the same whitelist as an edit plus the three fields that have no default.
 *
 * Spreading the request body into `createKnowledgeItem` instead would let a caller set
 * `freshness`, `conflictKey`, `conflictExclusive`, `contentHash` or `sourceCommit` — fields the
 * store derives or reserves — and would contradict the refusal `onlyEditableFields` performs one
 * function above. The two paths accepting different sets is how one of them ends up wrong.
 */
function pickCreatable(body: unknown): Record<string, unknown> {
  const fields = onlyEditableFields(body);
  for (const required of ['category', 'title', 'content']) {
    if (typeof fields[required] !== 'string' || (fields[required] as string).trim() === '') {
      throw new TypeError('category, title and content are required.');
    }
  }
  fields.provenance = 'user_stated';
  return fields;
}

function pickEditable(body: unknown): Record<string, unknown> {
  const patch = onlyEditableFields(body);
  if (Object.keys(patch).length === 0) throw new TypeError('Nothing to change.');
  // The human said so. This is `provenance`'s defined meaning and what makes "show me what I
  // wrote" possible -- unlike `writtenBy`, which marks a foreign origin repo, not a person.
  patch.provenance = 'user_stated';
  return patch;
}

/**
 * A write the store refuses is the caller's fault, not the server's.
 *
 * Without this every store-level rejection escaped to the generic handler as
 * `500 Internal viewer error`: a confidence outside 0..1, a field over the length cap, and --
 * worst -- content holding a secret. Somebody pastes a token into an atom, the store correctly
 * refuses it, and the editor tells them the server broke. The one message they most needed is
 * the one that was swallowed.
 *
 * Anything that is not a known validation refusal still throws, because a genuine internal
 * fault must not be reported as the user's mistake.
 */
async function withStoreRejection(response: http.ServerResponse, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof KnowledgeValidationError) {
      json(response, { error: error.message, code: error.code }, 400);
      return;
    }
    // `assertConfidenceInRange` and the SQLite bind layer throw plain Errors, so the message is
    // the only discriminator available. Narrow, and deliberately not a catch-all.
    const message = error instanceof Error ? error.message : String(error);
    if (/confidence/i.test(message) || /SQLite3 can only bind/i.test(message)) {
      json(response, { error: message }, 400);
      return;
    }
    throw error;
  }
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

    // ---- writes ----
    // **`SameSite=Strict` is NOT the CSRF defence here, and believing it was is how this
    // surface shipped writable and exposed.** "Same site" is the registrable domain, and for an
    // IP host that is the IP with the PORT EXCLUDED -- so a page served from any other
    // 127.0.0.1 port is same-site with this viewer and the browser attaches `knowl_viewer` on
    // its own. The Host check above cannot help: the browser sends OUR authority, correctly.
    // The `application/json` preflight 401s, but `text/plain` POST, `<form
    // enctype="text/plain">` and `sendBeacon` are simple requests that never preflight.
    // Measured: such a POST created an atom with the cookie alone and no token in the URL.
    //
    // `Origin` is the one header that names the page making the request, and a browser always
    // sends it on a cross-site write. Absent is allowed so curl and the tests still work; a
    // browser never omits it here, so absence is not a bypass a page can arrange.
    if (request.method !== 'GET') {
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== `http://${host}`) ||
          (typeof site === 'string' && site !== 'same-origin')) {
        json(response, { error: 'Cross-origin write refused.' }, 403);
        return;
      }
    }

    // Reached only after the Host check and the token check above, which is why removing the
    // blanket method gate is safe: that gate used to run first, and now nothing runs before
    // those two.
    //
    // These sit ABOVE the GET routes because those match on pathname alone and never inspect
    // the method -- a PATCH reaching `/api/graph` would be answered with a graph.
    if (request.method === 'POST' && pathname === '/api/atoms') {
      let fields: Record<string, unknown>;
      try {
        fields = pickCreatable(await readJson(request));
      } catch (error) {
        if (error instanceof BodyTooLarge) return json(response, { error: 'Body too large.' }, 413);
        return json(response, { error: (error as Error).message }, 400);
      }
      return withStoreRejection(response, async () =>
        json(response, { item: await createKnowledgeItem('local', fields as any) }, 201));
    }

    if (pathname.startsWith('/api/atoms/')) {
      // Split on the RAW pathname, then decode. Decoding first gave `/archive` a second
      // spelling: `%2Farchive` decodes to `/archive` and archived the atom, so any later
      // path-based audit line, allowlist or rate limit keyed on the literal suffix would
      // silently miss it.
      const rawRest = pathname.slice('/api/atoms/'.length);
      const action = rawRest.endsWith('/archive') ? 'archive'
        : rawRest.endsWith('/restore') ? 'restore'
        : null;
      const rawId = action === null ? rawRest : rawRest.slice(0, -(action.length + 1));
      const id = decodeURIComponent(rawId);

      if (request.method === 'POST' && action !== null) {
        const current = await getKnowledgeItem(id);
        if (!current) return json(response, { error: 'No such atom.' }, 404);
        const next = action === 'archive' ? 'archived' : 'active';
        // A no-op must not write. `updateKnowledgeItem` bumps version, updatedAt and
        // lifecycleHash, which re-stages the atom to the cloud — so archiving an already
        // archived atom would queue a push that changes nothing.
        if (current.status === next) return json(response, { item: current });
        // Archived, not deleted, and genuinely reversible: `restore` is the undo, because the
        // one destructive act a misclick can reach must have one on the surface that offers it.
        return withStoreRejection(response, async () =>
          json(response, { item: await updateKnowledgeItem(id, { status: next }) }));
      }

      if (request.method === 'PATCH' && action === null) {
        let patch: Record<string, unknown>;
        try {
          patch = pickEditable(await readJson(request));
        } catch (error) {
          if (error instanceof BodyTooLarge) return json(response, { error: 'Body too large.' }, 413);
          return json(response, { error: (error as Error).message }, 400);
        }
        if (!(await getKnowledgeItem(id))) return json(response, { error: 'No such atom.' }, 404);
        return withStoreRejection(response, async () =>
          json(response, { item: await updateKnowledgeItem(id, patch as any) }));
      }

      // The resource exists in principle, so do not answer with the GET-only Allow header the
      // fallthrough below would send for a path that serves no methods at all.
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'PATCH, POST', ...SECURITY_HEADERS });
        response.end();
        return;
      }
    }

    // Everything below is a GET route that does not check its own method.
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', ...SECURITY_HEADERS });
      response.end();
      return;
    }

    if (pathname === '/api/graph') return json(response, await buildGraph());
    if (pathname === '/api/brain') return json(response, await listKnowledgeItems());
    if (pathname === '/api/decisions') return json(response, (await listKnowledgeItems()).filter(item => item.category === 'decision'));
    if (pathname === '/api/stale') return json(response, (await listKnowledgeItems()).filter(item => item.freshness !== 'fresh'));
    if (pathname === '/api/conflicts') return json(response, await listActiveConflictKeys());
    if (pathname === '/api/access') return json(response, await getKnowledgeAccessReport());
    if (pathname === '/api/reads') {
      // A plain object of counts, absent meaning zero. The map is built from `knowledge_access`,
      // so an atom nobody has ever retrieved has no row and therefore no key -- which is what
      // makes the Unread lens a lookup miss rather than a second query. `getKnowledgeAccessReport`
      // cannot serve this: it INNER JOINs that table, so the never-read atoms are exactly the
      // rows it drops.
      const summary = await getAccessSummary();
      const counts: Record<string, number> = {};
      for (const [id, entry] of summary) counts[id] = entry.retrievalCount;
      return json(response, counts);
    }
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
