import { SessionEventType } from '../core/types.js';
import { appendMemorySessionEvent } from './session-repository.js';

const ALLOWED_FIELDS: Record<SessionEventType, string[]> = {
  start: ['title', 'agent'], command: ['command', 'exitCode', 'summary'], test: ['command', 'passed', 'summary'],
  error: ['code', 'message', 'summary'], git: ['commit', 'changedPaths', 'diffStat'], decision: ['text', 'summary'],
  checkpoint: ['summary', 'changedPaths'], stop: ['status', 'summary'],
};

export async function captureMemorySessionEvent(sessionId: string, type: SessionEventType, payload: Record<string, unknown>) {
  const normalized = Object.fromEntries(ALLOWED_FIELDS[type]
    .filter(key => payload[key] !== undefined)
    .map(key => [key, Array.isArray(payload[key]) ? payload[key].slice(0, 50) : typeof payload[key] === 'string' ? payload[key].slice(0, 2_000) : payload[key]]));
  return appendMemorySessionEvent(sessionId, type, normalized);
}
