import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus.js';

describe('loadCorpus', () => {
  it('loads every committed session with its events attached', async () => {
    const sessions = await loadCorpus();

    expect(sessions).toHaveLength(32);
    expect(sessions.reduce((total, s) => total + s.events.length, 0)).toBe(1424);
  });

  it('parses event payloads into objects rather than leaving them as JSON strings', async () => {
    const sessions = await loadCorpus();
    const withPaths = sessions
      .flatMap((session) => session.events)
      .find((event) => (event.payload.changedPaths?.length ?? 0) > 0);

    expect(withPaths).toBeDefined();
    expect(Array.isArray(withPaths!.payload.changedPaths)).toBe(true);
  });
});

// The committed corpus is dumped `ORDER BY session_id, observed_at`, so it is already sorted on
// disk and cannot tell a working sort from a missing one. This fixture is deliberately shuffled.
describe('loadCorpus on an out-of-order corpus', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unassisted-capture-corpus-'));
    await fs.writeFile(
      path.join(dir, 'sessions.json'),
      JSON.stringify([{ id: 's1', title: 'Shuffled', started_at: '2026-07-30T10:00:00.000Z', finished_at: null }]),
    );
    await fs.writeFile(
      path.join(dir, 'events.json'),
      JSON.stringify([
        { id: 'e3', session_id: 's1', type: 'command', payload: '{"command":"third"}', observed_at: '2026-07-30T10:03:00.000Z' },
        { id: 'e1', session_id: 's1', type: 'error', payload: '{"message":"first"}', observed_at: '2026-07-30T10:01:00.000Z' },
        { id: 'e2', session_id: 's1', type: 'checkpoint', payload: '{"changedPaths":["second.ts"]}', observed_at: '2026-07-30T10:02:00.000Z' },
      ]),
    );
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('sorts events within a session by observation time', async () => {
    const [session] = await loadCorpus(dir);

    // File order is e3, e1, e2. Anything that preserves input order fails here.
    expect(session.events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3']);
    expect(session.events.map((event) => event.observedAt)).toEqual([
      '2026-07-30T10:01:00.000Z',
      '2026-07-30T10:02:00.000Z',
      '2026-07-30T10:03:00.000Z',
    ]);
  });
});
