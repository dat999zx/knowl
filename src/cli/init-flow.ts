import { createAgentRegistry, detectAgents, parseAgentNames } from './agents/registry.js';
import { AgentAdapter, AgentIntegrationResult, AgentName } from './agents/types.js';

export interface InitAgentChoice {
  value: AgentName;
  name: string;
  checked?: boolean;
}

export interface InitPrompts {
  selectAgents(choices: InitAgentChoice[]): Promise<AgentName[]>;
  confirmGlobal(agent: AgentName, configPath: string): Promise<boolean>;
}

export interface InitFlowOptions {
  agentNames: string[];
  yes: boolean;
  interactive: boolean;
  registry?: Map<AgentName, AgentAdapter>;
  prompts?: InitPrompts;
}

function defaultPrompts(): InitPrompts {
  return {
    selectAgents: async choices => (await import('@inquirer/prompts')).checkbox({
      message: 'Select agents to connect',
      choices: choices.map(choice => ({ name: choice.name, value: choice.value, checked: choice.checked })),
    }),
    confirmGlobal: async (agent, configPath) => (await import('@inquirer/prompts')).confirm({
      message: `${agent} uses global MCP config at ${configPath}. Continue?`,
      default: false,
    }),
  };
}

export async function runAgentInitFlow(
  projectRoot: string,
  options: InitFlowOptions,
): Promise<{ results: AgentIntegrationResult[]; exitCode: number }> {
  const registry = options.registry ?? createAgentRegistry();
  const prompts = options.prompts ?? defaultPrompts();
  const explicitNames = parseAgentNames(options.agentNames);
  let selected: AgentName[] = explicitNames;

  if (selected.length === 0) {
    if (!options.interactive) return { results: [], exitCode: 0 };
    const detected = await detectAgents(projectRoot, registry);
    const choices = detected.map(({ adapter, detection }) => ({
      value: adapter.name,
      name: `${adapter.label}${detection.configured ? ' (configured)' : ''}${detection.scope === 'global' ? ' (global)' : ''}`,
      checked: detection.configured,
    }));
    selected = await prompts.selectAgents(choices);
  }

  const results: AgentIntegrationResult[] = [];
  for (const name of selected) {
    const adapter = registry.get(name);
    if (!adapter) throw new Error(`Unsupported agent "${name}".`);
    const detection = await adapter.detect(projectRoot);
    if (detection.scope === 'global' && !options.yes && !(await prompts.confirmGlobal(name, detection.configPath))) {
      results.push({ agent: name, status: 'skipped', scope: 'global', configPath: detection.configPath, message: 'Global configuration declined' });
      continue;
    }
    try {
      const result = await adapter.configure(projectRoot);
      if (!(await adapter.verify(projectRoot))) {
        results.push({ ...result, status: 'failed', message: 'Configuration verification failed' });
      } else {
        const lifecycle = await configureLifecycle(adapter, projectRoot);
        results.push({ ...result, lifecycle });
      }
    } catch (error: any) {
      results.push({ agent: name, status: 'failed', scope: detection.scope, configPath: detection.configPath, message: error.message });
    }
  }
  return { results, exitCode: results.some(result => result.status === 'failed' || result.lifecycle?.status === 'failed') ? 1 : 0 };
}

async function configureLifecycle(adapter: AgentAdapter, projectRoot: string): Promise<NonNullable<AgentIntegrationResult['lifecycle']>> {
  if (!adapter.lifecycleCapability || !adapter.configureLifecycle || !adapter.verifyLifecycle) {
    return { capability: 'unsupported', status: 'skipped', message: 'Lifecycle hooks are unavailable; use `knowl task run`.' };
  }

  try {
    const capability = await adapter.lifecycleCapability(projectRoot);
    const result = await adapter.configureLifecycle(projectRoot);
    if (capability === 'supported' && !(await adapter.verifyLifecycle(projectRoot))) {
      return { capability, status: 'failed', message: 'Lifecycle configuration verification failed' };
    }
    return { capability, status: result.status, message: result.message };
  } catch (error: any) {
    return { capability: 'degraded', status: 'failed', message: error.message };
  }
}

export function formatAgentInitSummary(results: AgentIntegrationResult[]) {
  if (results.length === 0) return 'MCP: no agent integrations selected.\nLifecycle: no hooks configured; `knowl task run` remains available.\nResult: ready';
  const width = Math.max(...results.map(result => result.agent.length));
  const lines = results.flatMap(result => [
    `${result.agent.padEnd(width)} MCP: ${result.status} (${result.scope})${result.message ? ` - ${result.message}` : ''}`,
    `${result.agent.padEnd(width)} lifecycle: ${result.lifecycle?.capability ?? 'unsupported'} (${result.lifecycle?.status ?? 'skipped'})${result.lifecycle?.message ? ` - ${result.lifecycle.message}` : ''}`,
  ]);
  lines.push(`Result: ${results.some(result => result.status === 'failed' || result.lifecycle?.status === 'failed') ? 'needs attention' : 'ready'}`);
  return lines.join('\n');
}
