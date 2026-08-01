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
    const later = events.slice(index + 1);

    // Recurrence: the whole remainder. An error that comes back was never fixed,
    // even if something unrelated happened in between.
    const recurred = later.some((event) =>
      event.type === 'error'
      && errorSignature(typeof event.payload.message === 'string' ? event.payload.message : '') === signature);

    // Edits: only up to the next error of any kind. Checkpoints after a different
    // error belong to that error, not this one.
    const windowEnd = later.findIndex((event) => event.type === 'error');
    const window = windowEnd === -1 ? later : later.slice(0, windowEnd);

    const changedPaths: string[] = [];
    const fixEvents: MemorySessionEvent[] = [];
    for (const event of window) {
      if (event.type !== 'checkpoint') continue;
      const paths = Array.isArray(event.payload.changedPaths) ? event.payload.changedPaths : [];
      if (paths.length === 0) continue;
      fixEvents.push(event);
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
