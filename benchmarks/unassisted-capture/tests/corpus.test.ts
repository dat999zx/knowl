import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus.js';

describe('loadCorpus', () => {
  it('loads every committed session with its events attached', async () => {
    const sessions = await loadCorpus();

    expect(sessions).toHaveLength(32);
    expect(sessions.reduce((total, s) => total + s.events.length, 0)).toBe(1424);
  });

  it('sorts events within a session by observation time', async () => {
    const sessions = await loadCorpus();
    const busiest = sessions.reduce((a, b) => (a.events.length >= b.events.length ? a : b));
    const times = busiest.events.map((event) => event.observedAt);

    expect(times).toEqual([...times].sort());
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
