import { MemoryCandidate, MemorySessionEvent } from '../core/types.js';
import { getClient } from './database.js';
import { rankCandidatesByImportance, MAX_PROMOTED_CANDIDATES } from './candidate-promotion.js';
import { parseCommitSubjects } from './extractors/commit-subject.js';
import { findFailureFixPairs } from './extractors/failure-fix.js';

/** Commit types that record process rather than knowledge. */
const SKIPPED_COMMIT_TYPES = new Set(['docs', 'test', 'chore']);

const MAX_CONTENT_CHARS = 2_000;

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
    const text = typeof event.payload.text === 'string' ? event.payload.text.slice(0, MAX_CONTENT_CHARS) : '';
    if (text) candidates.push({ candidateType: 'decision', sessionId, category: 'decision', title: `Session decision: ${text.slice(0, 80)}`, content: text, confidence: 0.9, evidence: eventEvidence(sessionId, event) });
  }

  // Commit subjects: the largest measured source of durable knowledge (52%). They
  // survive in the payload because the whole command string is captured.
  for (const event of events.filter(event => event.type === 'command')) {
    const command = typeof event.payload.command === 'string' ? event.payload.command : '';
    if (!command) continue;
    for (const commit of parseCommitSubjects(command)) {
      if (commit.type && SKIPPED_COMMIT_TYPES.has(commit.type)) continue;
      if (/^merge\b/i.test(commit.subject)) continue;
      const content = (commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject).slice(0, MAX_CONTENT_CHARS);
      candidates.push({
        candidateType: 'commit',
        sessionId,
        category: commit.type === 'fix' ? 'fact' : 'architecture',
        title: commit.subject.slice(0, 120),
        content,
        confidence: 0.8,
        evidence: eventEvidence(sessionId, event),
      });
    }
  }

  // Failure that was fixed: 45% of measured value, and the only source that records
  // why something broke rather than what changed.
  for (const pair of findFailureFixPairs(events)) {
    const content = [
      `Failed with:\n${pair.message.trim()}`,
      `Resolved after changing: ${pair.changedPaths.join(', ')}`,
    ].join('\n\n').slice(0, MAX_CONTENT_CHARS);
    candidates.push({
      candidateType: 'error',
      sessionId,
      category: 'fact',
      title: `Resolved failure: ${pair.message.trim().split('\n')[0].slice(0, 100)}`,
      content,
      confidence: 0.75,
      evidence: [pair.errorEvent, ...pair.fixEvents.slice(0, 2)].flatMap(event => eventEvidence(sessionId, event)),
    });
  }

  const seen = new Set<string>();
  const deduped = candidates.filter(candidate => { const key = `${candidate.title}\n${candidate.content}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  return rankCandidatesByImportance(deduped).slice(0, MAX_PROMOTED_CANDIDATES);
}
