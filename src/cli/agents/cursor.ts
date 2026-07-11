import { createCursorProjectAdapter } from './project-adapters.js';
import { AgentEnvironment } from './types.js';

export function createCursorAdapter(environment: AgentEnvironment) {
  return createCursorProjectAdapter(environment);
}
