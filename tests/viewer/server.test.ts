import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem } from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-viewer-test');
let stop: (() => Promise<void>) | undefined;

describe('viewer server', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); await createKnowledgeItem('local', { category: 'decision', title: 'Viewer decision', content: 'Viewer is read-only.' }); });
  afterAll(async () => { await stop?.(); await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('binds localhost only and exposes read-only brain data without raw session events', async () => {
    const viewer = await import('../../src/viewer/server.js') as any;
    expect(viewer.startViewer).toBeTypeOf('function');
    const running = await viewer.startViewer(ROOT, { port: 0 });
    stop = running.close;
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const response = await fetch(`${running.url}/api/brain`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain('Viewer decision');
    expect(JSON.stringify(body)).not.toContain('memory_session_events');
    expect((await fetch(`${running.url}/api/decisions`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/stale`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/access`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/skills`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/retrieval?q=viewer`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/evidence/${body[0].id}`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/brain`, { method: 'POST' })).status).toBe(405);
  });
});
