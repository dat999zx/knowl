import { MemoryCandidate, MemorySessionEvent } from '../core/types.js';
import { getClient } from './database.js';

function eventEvidence(sessionId: string, event: MemorySessionEvent) {
  return [{ type: 'agent' as const, locator: `session://${sessionId}/event/${event.id}`, relationship: 'derived_from' as const, observedAt: event.observedAt }];
}

function eventsForSession(rows: any[]): MemorySessionEvent[] {
  return rows.map(row => ({ id: String(row.id), sessionId: String(row.session_id), type: row.type, payload: JSON.parse(String(row.payload)), observedAt: String(row.observed_at), expiresAt: String(row.expires_at) }));
}

export async function extractSessionMemoryCandidates(sessionId: string): Promise<MemoryCandidate[]> {
  const client = getClient();
  const sessionRow = (await client.execute({ sql: 'SELECT * FROM memory_sessions WHERE id = ?', args: [sessionId] })).rows[0];
  if (!sessionRow) throw new Error(`Memory session not found: ${sessionId}`);
  const events = eventsForSession((await client.execute({ sql: 'SELECT * FROM memory_session_events WHERE session_id = ? ORDER BY observed_at', args: [sessionId] })).rows);
  const candidates: MemoryCandidate[] = [];
  for (const event of events.filter(event => event.type === 'decision')) {
    const text = typeof event.payload.text === 'string' ? event.payload.text.slice(0, 2_000) : '';
    if (text) candidates.push({ candidateType: 'decision', sessionId, category: 'decision', title: `Session decision: ${text.slice(0, 80)}`, content: text, confidence: 0.9, evidence: eventEvidence(sessionId, event) });
  }
  const stop = events.find(event => event.type === 'stop');
  const summary = typeof stop?.payload.summary === 'string' ? stop.payload.summary.slice(0, 2_000) : '';
  if (summary) candidates.push({ candidateType: 'outcome', sessionId, category: 'state', title: `Session outcome: ${String(sessionRow.title)}`, content: summary, confidence: 0.75, evidence: eventEvidence(sessionId, stop!) });
  const seen = new Set<string>();
  return candidates.filter(candidate => { const key = `${candidate.title}\n${candidate.content}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 5);
}
