import type { MemorySessionEvent } from '../../core/types.js';
import { errorSignature } from './error-signature.js';

export interface FailureFix {
  errorEvent: MemorySessionEvent;
  message: string;
  changedPaths: string[];
  /** The checkpoint events that carried the edits, for evidence. */
  fixEvents: MemorySessionEvent[];
}

export function findFailureFixPairs(events: MemorySessionEvent[]): FailureFix[] {
  const pairs: FailureFix[] = [];

  for (let index = 0; index < events.length; index++) {
    const errorEvent = events[index];
    if (errorEvent.type !== 'error') continue;
    const message = typeof errorEvent.payload.message === 'string' ? errorEvent.payload.message : '';
    if (!message.trim()) continue;

    const signature = errorSignature(message);
    const changedPaths: string[] = [];
    const fixEvents: MemorySessionEvent[] = [];
    let recurred = false;

    for (const later of events.slice(index + 1)) {
      if (later.type === 'error') {
        const laterMessage = typeof later.payload.message === 'string' ? later.payload.message : '';
        // Same failure again: whatever was changed in between did not fix it.
        if (errorSignature(laterMessage) === signature) { recurred = true; break; }
        continue;
      }
      if (later.type !== 'checkpoint') continue;
      const paths = Array.isArray(later.payload.changedPaths) ? later.payload.changedPaths : [];
      if (paths.length === 0) continue;
      fixEvents.push(later);
      for (const path of paths) {
        if (typeof path === 'string' && !changedPaths.includes(path)) changedPaths.push(path);
      }
    }

    if (!recurred && changedPaths.length > 0) {
      pairs.push({ errorEvent, message, changedPaths, fixEvents });
    }
  }

  return pairs;
}
