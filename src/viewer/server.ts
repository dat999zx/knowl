import http from 'node:http';
import { initDb, closeDb } from '../store/database.js';
import { listKnowledgeItems } from '../store/repository.js';
import { listAssertions } from '../store/assertions.js';
import { listActiveConflictKeys } from '../store/conflicts.js';
import { getKnowledgeAccessReport } from '../store/access-feedback.js';
import { listSkillPackages } from '../skills/registry.js';

export type ViewerServer = { url: string; close: () => Promise<void> };

function json(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function startViewer(projectRoot: string, options: { port?: number } = {}): Promise<ViewerServer> {
  await initDb(projectRoot);
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/brain') return json(response, await listKnowledgeItems('local'));
    if (pathname === '/api/decisions') return json(response, (await listKnowledgeItems('local')).filter(item => item.category === 'decision'));
    if (pathname === '/api/stale') return json(response, (await listKnowledgeItems('local')).filter(item => item.freshness !== 'fresh'));
    if (pathname === '/api/conflicts') return json(response, await listActiveConflictKeys());
    if (pathname === '/api/access') return json(response, await getKnowledgeAccessReport());
    if (pathname === '/api/skills') return json(response, await listSkillPackages(projectRoot));
    if (pathname.startsWith('/api/timeline/')) return json(response, await listAssertions(pathname.slice('/api/timeline/'.length)));
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Knowl Viewer</title><main><h1>Knowl Viewer</h1><p>Read-only local memory viewer.</p></main>'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer failed to bind a local port.');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); } };
}
