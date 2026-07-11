import { createCursorProjectAdapter } from './project-adapters.js';
import { AgentEnvironment } from './types.js';
import path from 'node:path';
import { mergeCursorHookConfig, verifyCursorHookConfig } from './hook-config.js';

export function createCursorAdapter(environment: AgentEnvironment) {
  const adapter = createCursorProjectAdapter(environment);
  const configPath = (root: string) => path.join(root, '.cursor', 'hooks.json');
  return {
    ...adapter,
    async lifecycleCapability() { return 'supported' as const; },
    async configureLifecycle(root: string) {
      const pathname = configPath(root);
      const status = await mergeCursorHookConfig(pathname, environment.platform);
      return { agent: 'cursor' as const, status, scope: 'project' as const, configPath: pathname };
    },
    async verifyLifecycle(root: string) { return verifyCursorHookConfig(configPath(root), environment.platform); },
  };
}
