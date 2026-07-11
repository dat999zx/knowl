import { checkbox, confirm } from '@inquirer/prompts';
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
    selectAgents: choices => checkbox({
      message: 'Select agents to connect',
      choices: choices.map(choice => ({ name: choice.name, value: choice.value, checked: choice.checked })),
    }),
    confirmGlobal: (agent, configPath) => confirm({
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
        results.push(result);
      }
    } catch (error: any) {
      results.push({ agent: name, status: 'failed', scope: detection.scope, configPath: detection.configPath, message: error.message });
    }
  }
  return { results, exitCode: results.some(result => result.status === 'failed') ? 1 : 0 };
}

export function formatAgentInitSummary(results: AgentIntegrationResult[]) {
  if (results.length === 0) return 'No agent integrations selected.';
  const width = Math.max(...results.map(result => result.agent.length));
  const lines = results.map(result => `${result.agent.padEnd(width)}: ${result.status} (${result.scope})${result.message ? ` - ${result.message}` : ''}`);
  lines.push(`Result: ${results.some(result => result.status === 'failed') ? 'needs attention' : 'ready'}`);
  return lines.join('\n');
}
