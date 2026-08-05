import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem } from '../../src/store/repository.js';

/**
 * `fetch` refuses to let JS set the `Host` header -- it is on the WHATWG forbidden-header list,
 * enforced by undici too. A raw `http.request` is the only way to send one that disagrees with
 * the socket it is actually reaching, which is exactly what the Host-check test needs to send.
 */
function requestWithHost(url: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', headers: { host } },
      response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode ?? 0 })); },
    );
    request.on('error', reject);
    request.end();
  });
}

const ROOT = path.resolve('.knowl-viewer-test');
let stop: (() => Promise<void>) | undefined;
let running: any;

describe('viewer server', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); await createKnowledgeItem('local', { category: 'decision', title: 'Viewer decision', content: 'Viewer is read-only.' }); });
  afterAll(async () => { await stop?.(); await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('binds localhost only and exposes read-only brain data without raw session events', async () => {
    const viewer = await import('../../src/viewer/server.js') as any;
    expect(viewer.startViewer).toBeTypeOf('function');
    running = await viewer.startViewer(ROOT, { port: 0 });
    stop = running.close;
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const response = await fetch(`${running.url}/api/brain?token=${running.token}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain('Viewer decision');
    expect(JSON.stringify(body)).not.toContain('memory_session_events');
    expect((await fetch(`${running.url}/api/decisions?token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/stale?token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/access?token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/skills?token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/retrieval?q=viewer&token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/evidence/${body[0].id}?token=${running.token}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/brain?token=${running.token}`, { method: 'POST' })).status).toBe(405);
  });

  it('answers a malformed percent-escape with 400 instead of hanging or crashing', async () => {
    const response = await fetch(`${running.url}/api/evidence/%?token=${running.token}`);
    expect(response.status).toBe(400);
    await response.json();
  });

  it('refuses an API request with no token', async () => {
    expect((await fetch(`${running.url}/api/brain`)).status).toBe(401);
  });

  it('refuses a request whose Host header is not the bound loopback address', async () => {
    const response = await requestWithHost(`${running.url}/api/brain?token=${running.token}`, 'knowl.example.com');
    expect(response.status).toBe(400);
  });

  it('serves the page with hardening headers and a session cookie', async () => {
    const response = await fetch(running.browseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('set-cookie') ?? '').toContain('knowl_viewer=');
  });
});
