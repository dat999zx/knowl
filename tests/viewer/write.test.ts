import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, getKnowledgeItem } from '../../src/store/repository.js';

/**
 * `fetch` refuses to let JS set the `Host` header -- it is on the WHATWG forbidden-header list,
 * enforced by undici too. A raw `http.request` is the only way to send one that disagrees with
 * the socket it is actually reaching, which is what the Host-check case needs.
 */
function raw(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname, port: target.port,
        path: `${target.pathname}${target.search}`, method: options.method,
        headers: { 'content-type': 'application/json', ...options.headers },
      },
      response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on('error', reject);
    request.end(options.body ?? '{}');
  });
}

function requestWithHost(url: string, host: string, method: string): Promise<{ status: number }> {
  return raw(url, { method, headers: { host } });
}

const ROOT = path.resolve('./.knowl-viewer-write-test');
let running: any;
let atomId = '';

describe('viewer writes', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Original title', content: 'Original content.',
    });
    atomId = item.id;
    const viewer = await import('../../src/viewer/server.js') as any;
    running = await viewer.startViewer(ROOT, { port: 0 });
  });
  afterAll(async () => {
    await running?.close();
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const url = (p: string) => `${running.url}${p}?token=${running.token}`;
  const send = (p: string, method: string, body?: unknown) => fetch(url(p), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('edits an atom and marks it as the human speaking', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', {
      title: 'Corrected title', content: 'Corrected content.',
    });
    expect(response.status).toBe(200);

    const stored = await getKnowledgeItem(atomId);
    expect(stored?.title).toBe('Corrected title');
    expect(stored?.content).toBe('Corrected content.');
    expect(stored?.provenance).toBe('user_stated');
  });

  it('leaves written_by alone, because it means cross-repo authorship', async () => {
    await send(`/api/atoms/${atomId}`, 'PATCH', { title: 'Another correction' });
    const stored = await getKnowledgeItem(atomId);
    expect(stored?.writtenBy ?? null).toBeNull();
  });

  it('creates an atom', async () => {
    const response = await send('/api/atoms', 'POST', {
      category: 'constraint', title: 'Written by hand', content: 'A person typed this.',
    });
    expect(response.status).toBe(201);
    const created = (await response.json()).item;
    const stored = await getKnowledgeItem(created.id);
    expect(stored?.title).toBe('Written by hand');
    expect(stored?.provenance).toBe('user_stated');
  });

  it('refuses a create that is missing a required field', async () => {
    const response = await send('/api/atoms', 'POST', { category: 'fact', title: 'No content' });
    expect(response.status).toBe(400);
  });

  it('refuses a create carrying a field the store derives or reserves', async () => {
    // The edit path refuses unknown keys; create must refuse them too, or a caller can set
    // freshness, contentHash or a conflict key that no human should be choosing.
    for (const extra of [
      { freshness: 'fresh' }, { contentHash: 'deadbeef' },
      { conflictKey: 'auth', conflictExclusive: true }, { sourceCommit: 'abc123' },
    ]) {
      const response = await send('/api/atoms', 'POST', {
        category: 'fact', title: 'Sneaky', content: 'Body.', ...extra,
      });
      expect(response.status).toBe(400);
    }
  });

  it('archives rather than destroys', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Doomed', content: 'To be archived.',
    });
    const response = await send(`/api/atoms/${item.id}/archive`, 'POST');
    expect(response.status).toBe(200);
    const stored = await getKnowledgeItem(item.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('archived');
  });

  it('refuses a field that is not editable', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', { id: 'hijacked', status: 'active' });
    expect(response.status).toBe(400);
    expect((await getKnowledgeItem(atomId))?.id).toBe(atomId);
  });

  it('refuses an edit that changes nothing', async () => {
    expect((await send(`/api/atoms/${atomId}`, 'PATCH', {})).status).toBe(400);
  });

  it('404s an atom that does not exist', async () => {
    const response = await send('/api/atoms/nope-not-here', 'PATCH', { title: 'x' });
    expect(response.status).toBe(404);
  });

  it('405s a method the route does not serve, and still 405s an unknown path', async () => {
    // `/api/graph` is a GET route that matches on pathname alone and never inspects the
    // method, so this is the case that pins the write routes sitting ABOVE it with the
    // method gate in between. Place them below and this returns a graph.
    expect((await send('/api/graph', 'PATCH', {})).status).toBe(405);
    expect((await send('/api/atoms', 'DELETE')).status).toBe(405);
    expect((await send('/api/nothing-here', 'POST', {})).status).toBe(405);
  });

  it('refuses a write with no token, exactly as it refuses a read', async () => {
    const response = await fetch(`${running.url}/api/atoms/${atomId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no token' }),
    });
    expect(response.status).toBe(401);
    expect((await getKnowledgeItem(atomId))?.title).not.toBe('no token');
  });

  it('refuses a write whose Host header is not a loopback literal', async () => {
    const response = await requestWithHost(url(`/api/atoms/${atomId}`), 'knowl.example.com', 'PATCH');
    expect(response.status).toBe(400);
  });

  it('refuses a body larger than the cap', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', { content: 'x'.repeat(70_000) });
    expect(response.status).toBe(413);
  });

  it('still issues the cookie HttpOnly and SameSite=Strict', async () => {
    // Worth keeping, but NOT as the CSRF defence -- see the cross-origin cases below.
    // SameSite is computed from the registrable domain and excludes the port, so every other
    // 127.0.0.1 port is same-site with this one. HttpOnly is the real value here: page script
    // cannot read the token and leak it.
    const page = await fetch(url('/'));
    const cookie = page.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses a write from another loopback port, which SameSite treats as same-site', async () => {
    // The exact shape that got through: a simple request that never preflights, carrying the
    // cookie a browser attaches on its own, with no token in the URL.
    const cookied = await raw(`${running.url}/api/atoms`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'http://127.0.0.1:3000',
        cookie: `knowl_viewer=${running.token}`,
      },
      body: JSON.stringify({ category: 'fact', title: 'Injected', content: 'By another port.' }),
    });
    expect(cookied.status).toBe(403);

    const before = (await (await fetch(url('/api/brain'))).json()).length;
    expect(JSON.stringify(await (await fetch(url('/api/brain'))).json())).not.toContain('Injected');
    expect(before).toBeGreaterThan(0);
  });

  it('refuses a write whose Sec-Fetch-Site says it came from elsewhere', async () => {
    const response = await raw(url(`/api/atoms/${atomId}`), {
      method: 'PATCH',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ title: 'From a hostile page' }),
    });
    expect(response.status).toBe(403);
  });

  it('allows a write that names this viewer as its origin', async () => {
    const host = new URL(running.url).host;
    const response = await raw(url('/api/atoms'), {
      method: 'POST',
      headers: { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ category: 'fact', title: 'From the viewer page', content: 'Body.' }),
    });
    expect(response.status).toBe(201);
  });

  it('reports a store refusal as the caller s fault, not an internal error', async () => {
    // The one that matters most: a person pastes a token into an atom, the store refuses it,
    // and the reason has to reach them. This used to surface as 500 "Internal viewer error."
    const response = await send('/api/atoms', 'POST', {
      category: 'fact', title: 'Holds a secret',
      content: 'The key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it should be refused.',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/secret/i);
  });

  it('refuses a confidence outside the range instead of returning 500', async () => {
    for (const confidence of [999, -5]) {
      expect((await send(`/api/atoms/${atomId}`, 'PATCH', { confidence })).status).toBe(400);
    }
  });

  it('type-checks the whitelist, so a secret cannot ride in on a non-array tags', async () => {
    // arrayField returns [] for a non-array, so the secret scanner skipped it entirely: the
    // same token was refused as ["ghp_..."] and stored as "ghp_...".
    const secret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    for (const tags of [secret, { a: 1 }, [1, 2], 5]) {
      const response = await send('/api/atoms', 'POST', {
        category: 'fact', title: 'Tag shape', content: 'Body.', tags,
      });
      expect(response.status).toBe(400);
    }
  });

  it('refuses a category outside the known set, which would file an atom where nothing looks', async () => {
    expect((await send('/api/atoms', 'POST', {
      category: 'nonsense; DROP', title: 'Bad category', content: 'Body.',
    })).status).toBe(400);
    expect((await send(`/api/atoms/${atomId}`, 'PATCH', { category: 'zzz' })).status).toBe(400);
  });

  it('does not accept an encoded slash as a second spelling of /archive', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Not via an encoded slash', content: 'Body.',
    });
    const response = await send(`/api/atoms/${item.id}%2Farchive`, 'POST');
    expect(response.status).not.toBe(200);
    expect((await getKnowledgeItem(item.id))?.status).toBe('active');
  });

  it('restores an archived atom, so the destructive action has an undo', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'There and back', content: 'Body.',
    });
    expect((await send(`/api/atoms/${item.id}/archive`, 'POST')).status).toBe(200);
    expect((await getKnowledgeItem(item.id))?.status).toBe('archived');
    expect((await send(`/api/atoms/${item.id}/restore`, 'POST')).status).toBe(200);
    expect((await getKnowledgeItem(item.id))?.status).toBe('active');
  });

  it('does not write when archiving an atom that is already archived', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Already filed', content: 'Body.',
    });
    await send(`/api/atoms/${item.id}/archive`, 'POST');
    const after = await getKnowledgeItem(item.id);
    expect((await send(`/api/atoms/${item.id}/archive`, 'POST')).status).toBe(200);
    // A second archive must not bump the row: the version and timestamp are what re-stage an
    // atom to the cloud, so a no-op would queue a push that changes nothing.
    const again = await getKnowledgeItem(item.id);
    expect(again?.updatedAt).toBe(after?.updatedAt);
  });

  it('reports read counts, with never-read atoms simply absent', async () => {
    const response = await fetch(url('/api/reads'));
    expect(response.status).toBe(200);
    const reads = await response.json();
    expect(typeof reads).toBe('object');
    // The fixture atoms have never been retrieved, so they must not appear at all --
    // absence is what the Unread lens reads as zero.
    expect(reads[atomId]).toBeUndefined();
  });
});
