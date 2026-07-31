import fs from 'node:fs/promises';
import path from 'node:path';
import type { CorpusEvent, CorpusSession, EventPayload, EventType } from './types.js';

const DEFAULT_CORPUS_DIR = path.join('benchmarks', 'unassisted-capture', 'corpus');

const readJson = async <T>(dir: string, name: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as T;

/** Payloads are stored as JSON strings in SQLite and survive the dump that way. */
function parsePayload(raw: unknown): EventPayload {
  if (typeof raw !== 'string') return (raw ?? {}) as EventPayload;
  try {
    return JSON.parse(raw) as EventPayload;
  } catch {
    return {};
  }
}

export async function loadCorpus(dir: string = DEFAULT_CORPUS_DIR): Promise<CorpusSession[]> {
  const sessionRows = await readJson<any[]>(dir, 'sessions.json');
  const eventRows = await readJson<any[]>(dir, 'events.json');

  const eventsBySession = new Map<string, CorpusEvent[]>();
  for (const row of eventRows) {
    const sessionId = String(row.session_id);
    const event: CorpusEvent = {
      id: String(row.id),
      sessionId,
      type: String(row.type) as EventType,
      payload: parsePayload(row.payload),
      observedAt: String(row.observed_at),
    };
    const bucket = eventsBySession.get(sessionId);
    if (bucket) bucket.push(event);
    else eventsBySession.set(sessionId, [event]);
  }

  for (const bucket of eventsBySession.values()) {
    bucket.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  return sessionRows.map((row) => ({
    sessionId: String(row.id),
    title: String(row.title),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    events: eventsBySession.get(String(row.id)) ?? [],
  }));
}
