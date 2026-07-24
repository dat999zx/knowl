import { MemoryCandidate, MemorySessionEvent } from '../core/types.js';
import { getClient } from './database.js';
import { rankCandidatesByImportance, MAX_PROMOTED_CANDIDATES } from './candidate-promotion.js';

// A command must succeed at least this many times in one session before it is
// suggested as a reusable skill — one-off successful commands stay noise.
const PROCEDURAL_SKILL_MIN_REPEATS = 3;

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
  // Procedural learning: a command that succeeds repeatedly in a session is a
  // workflow worth remembering as a skill, not one-off noise. A single run is
  // still ignored; only genuinely repeated commands become skill candidates.
  const commandRuns = new Map<string, { command: string; count: number; events: MemorySessionEvent[] }>();
  for (const event of events.filter(event => event.type === 'command')) {
    const command = typeof event.payload.command === 'string' ? event.payload.command.trim() : '';
    const succeeded = event.payload.exitCode === 0 || event.payload.exitCode === undefined;
    if (!command || command.length < 4 || !succeeded) continue;
    const key = command.toLowerCase();
    const entry = commandRuns.get(key) ?? { command, count: 0, events: [] };
    entry.count += 1;
    entry.events.push(event);
    commandRuns.set(key, entry);
  }
  for (const run of commandRuns.values()) {
    if (run.count < PROCEDURAL_SKILL_MIN_REPEATS) continue;
    candidates.push({
      candidateType: 'verified-command', sessionId, category: 'skill',
      title: `Repeated workflow: ${run.command.slice(0, 72)}`,
      content: `The command \`${run.command}\` ran successfully ${run.count} times this session — a candidate reusable skill.`,
      confidence: 0.7, evidence: run.events.slice(0, 3).flatMap(event => eventEvidence(sessionId, event)),
    });
  }

  const stop = events.find(event => event.type === 'stop');
  const summary = typeof stop?.payload.summary === 'string' ? stop.payload.summary.slice(0, 2_000) : '';
  if (summary) candidates.push({ candidateType: 'outcome', sessionId, category: 'state', title: `Session outcome: ${String(sessionRow.title)}`, content: summary, confidence: 0.75, evidence: eventEvidence(sessionId, stop!) });
  const seen = new Set<string>();
  const deduped = candidates.filter(candidate => { const key = `${candidate.title}\n${candidate.content}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  return rankCandidatesByImportance(deduped).slice(0, MAX_PROMOTED_CANDIDATES);
}
