import { AgentIntegrationResult, AgentName, IntegrationScope } from './types.js';

export const LIFECYCLE_FALLBACK_MESSAGE = 'Lifecycle hooks are unsupported for this host; use `knowl task run` as the fallback.';

export function unsupportedLifecycleResult(
  agent: AgentName,
  scope: IntegrationScope,
  configPath: string,
): AgentIntegrationResult {
  return { agent, status: 'skipped', scope, configPath, message: LIFECYCLE_FALLBACK_MESSAGE };
}
