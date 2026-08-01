import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { encodeProjectDir, ensureTranscriptIndex } from '../../src/store/transcript-index.js';
import { listSessionDirectory } from '../../src/store/session-directory.js';

const TEST_ROOT = path.resolve('./.knowl-session-directory-test');
// Injected store, never HOME: mutating HOME/USERPROFILE leaks into other suites.
const FAKE_STORE = path.join(TEST_ROOT, 'store', 'projects');
const STORES = [FAKE_STORE];
const PROJECT_DIR = 'D:\\Code\\DirectoryProject';

const line = (obj: object) => JSON.stringify(obj) + '\n';
const user = (text: string, ts: string) => line({ type: 'user', timestamp: ts, message: { content: text } });
const assistant = (text: string, ts: string) => line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

let sessionDir: string;
let projectId: string;

describe('session directory', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Session directory test')).id;

    sessionDir = path.join(FAKE_STORE, encodeProjectDir(PROJECT_DIR));
    await fs.mkdir(sessionDir, { recursive: true });

    // A renamed session: custom-title must beat the generated ai-title.
    await fs.writeFile(path.join(sessionDir, 'ui-session.jsonl'),
      line({ type: 'ai-title', sessionId: 'ui-session', aiTitle: 'Generated title about buttons' }) +
      user('<local-command-caveat>Caveat: local commands</local-command-caveat>', '2026-01-01T00:00:00Z') +
      user('polish the trial screen meta band and fix the fork stage', '2026-01-01T00:01:00Z') +
      assistant('Starting on the meta band.', '2026-01-01T00:02:00Z') +
      line({ type: 'custom-title', sessionId: 'ui-session', customTitle: 'ui-trial-screen' }));

    // Never named: must still appear, described by its opening ask.
    await fs.writeFile(path.join(sessionDir, 'unnamed.jsonl'),
      user('investigate the postgres migration ordering bug', '2026-01-02T00:00:00Z') +
      assistant('Reading the migrations.', '2026-01-02T00:01:00Z'));
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('lists sessions newest first with names from the transcript itself', async () => {
    const { entries, indexComplete } = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES });
    expect(indexComplete).toBe(true);
    expect(entries.length).toBe(2);
    const ui = entries.find(entry => entry.sessionId === 'ui-session')!;
    // The user's rename wins over the generated title.
    expect(ui.name).toBe('ui-trial-screen');
    expect(ui.opening).toContain('polish the trial screen');
    // The caveat wrapper is not an opening.
    expect(ui.opening).not.toContain('local-command-caveat');
  });

  it('includes unnamed sessions, described by their opening ask', async () => {
    const { entries } = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES });
    const unnamed = entries.find(entry => entry.sessionId === 'unnamed')!;
    expect(unnamed.name).toBeNull();
    expect(unnamed.opening).toContain('postgres migration ordering');
  });

  it('answers "which session was about X" with a keyword filter', async () => {
    const ui = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES, query: 'trial screen' });
    expect(ui.entries.map(entry => entry.sessionId)).toEqual(['ui-session']);
    const pg = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES, query: 'postgres migration' });
    expect(pg.entries.map(entry => entry.sessionId)).toEqual(['unnamed']);
    const none = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES, query: 'kubernetes' });
    expect(none.entries).toEqual([]);
  });

  it('a later rename appended to the transcript updates the name incrementally', async () => {
    await fs.appendFile(path.join(sessionDir, 'ui-session.jsonl'),
      line({ type: 'custom-title', sessionId: 'ui-session', customTitle: 'ui-trial-screen-v2' }));
    await ensureTranscriptIndex(PROJECT_DIR, STORES);
    const { entries } = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES });
    expect(entries.find(entry => entry.sessionId === 'ui-session')!.name).toBe('ui-trial-screen-v2');
  });

  it('derives status from lifecycle signals and surfaces declared cards, without storing anything', async () => {
    const client = getClient();
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const now = new Date().toISOString();

    // An unconsumed crash handoff names ui-session -> interrupted, outranking activity.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Rate limit interrupted the ui worksession',
      content: JSON.stringify({ kind: 'rate_limit', externalSessionId: 'ui-session', consumed: false }),
      tags: ['pending_handoff', 'rate_limit', 'claude', 'session:ui-session'],
    } as any, 'test');

    // A live memory session with a fresh heartbeat bound to unnamed -> active.
    await client.execute({
      sql: `INSERT INTO memory_sessions (id, title, status, started_at, last_heartbeat_at, expires_at)
            VALUES ('ms-live', 'Agent turn', 'active', ?, ?, '2099-01-01T00:00:00.000Z')`,
      args: [now, now],
    });
    await client.execute({
      sql: `INSERT INTO host_session_bindings (host, project_root, external_session_id, external_turn_id, memory_session_id, active, updated_at)
            VALUES ('claude', ?, 'unnamed', '__session__', 'ms-live', 1, ?)`,
      args: [PROJECT_DIR.toLowerCase(), now],
    });

    // A declared card, findable by the keyword filter.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'ui-trial-screen: meta band polish, parked at contrast pass',
      content: 'Session card.', tags: ['session-card', 'session:ui-session'],
    } as any, 'test');

    // A pre-tag-era handoff: session id only in content JSON. Real archives
    // have these, so the fallback is load-bearing, not defensive.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Provider outage stranded an unnamed legacy run',
      content: JSON.stringify({ kind: 'provider_outage', externalSessionId: 'unnamed-legacy', consumed: false }),
      tags: ['pending_handoff', 'provider_outage', 'claude'],
    } as any, 'test');

    const { entries } = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES });
    const ui = entries.find(entry => entry.sessionId === 'ui-session')!;
    const unnamed = entries.find(entry => entry.sessionId === 'unnamed')!;
    expect(ui.status).toBe('interrupted');
    expect(ui.card).toContain('meta band polish');
    expect(unnamed.status).toBe('active');

    // Cards are part of intent, so the filter can find a session through one.
    const byCard = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES, query: 'contrast parked' });
    expect(byCard.entries.map(entry => entry.sessionId)).toEqual(['ui-session']);
  });

  it('surfaces knowledge a session promoted, joined through the lifecycle chain', async () => {
    const client = getClient();
    // Minimal lifecycle chain: memory session -> binding -> promoted item.
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Water shader uses two scrolling layers', content: 'Decided during the ui session.',
    } as any, 'test');
    const itemId = stored.item.id;
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO memory_sessions (id, title, status, started_at, last_heartbeat_at, expires_at, promotion_status, promotion_items)
            VALUES ('ms-1', 'Agent turn', 'finished', ?, ?, ?, 'promoted', ?)`,
      args: [now, now, '2099-01-01T00:00:00Z', JSON.stringify([itemId])],
    });
    await client.execute({
      sql: `INSERT INTO host_session_bindings (host, project_root, external_session_id, external_turn_id, memory_session_id, active, updated_at)
            VALUES ('claude', ?, 'ui-session', '__session__', 'ms-1', 1, ?)`,
      args: [PROJECT_DIR.toLowerCase(), now],
    });

    const { entries } = await listSessionDirectory({ projectDir: PROJECT_DIR, stores: STORES });
    const ui = entries.find(entry => entry.sessionId === 'ui-session')!;
    expect(ui.promoted.length).toBeGreaterThan(0);
    expect(ui.promoted[0]).toContain('Water shader');
  });
});
