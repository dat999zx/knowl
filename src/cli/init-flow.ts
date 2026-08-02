import { createAgentRegistry, detectAgents, parseAgentNames } from './agents/registry.js';
import { AgentAdapter, AgentIntegrationResult, AgentName, IntegrationDetail } from './agents/types.js';

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
    selectAgents: async choices => {
      const clack = await import('@clack/prompts');
      const picked = await clack.multiselect({
        message: 'Select agents to connect',
        options: choices.map(choice => ({ value: choice.value, label: choice.name })),
        initialValues: choices.filter(choice => choice.checked).map(choice => choice.value),
        required: false,
      });
      // Cancelling selects nothing rather than throwing, so `knowl init` can report that
      // it connected no agents instead of dying with a stack trace. The values come
      // straight back out of `choices`, so they are agent names by construction.
      return clack.isCancel(picked) ? [] : (picked as InitAgentChoice['value'][]);
    },
    confirmGlobal: async (agent, configPath) => {
      const clack = await import('@clack/prompts');
      const ok = await clack.confirm({
        message: `${agent} uses global MCP config at ${configPath}. Continue?`,
        initialValue: false,
      });
      return !clack.isCancel(ok) && ok === true;
    },
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
        const instructions = await configureInstructions(adapter, projectRoot);
        const lifecycle = await configureLifecycle(adapter, projectRoot);
        results.push({ ...result, instructions, lifecycle });
      }
    } catch (error: any) {
      results.push({ agent: name, status: 'failed', scope: detection.scope, configPath: detection.configPath, message: error.message });
    }
  }
  return { results, exitCode: results.some(result => result.status === 'failed' || result.instructions?.status === 'failed' || result.lifecycle?.status === 'failed') ? 1 : 0 };
}

async function configureInstructions(adapter: AgentAdapter, projectRoot: string): Promise<IntegrationDetail | undefined> {
  if (!adapter.configureInstructions || !adapter.verifyInstructions) return undefined;
  try {
    const result = await adapter.configureInstructions(projectRoot);
    return await adapter.verifyInstructions(projectRoot)
      ? result
      : { ...result, status: 'failed', message: 'Instruction configuration verification failed' };
  } catch (error: any) {
    return { status: 'failed', configPath: projectRoot, message: error.message };
  }
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
  const lines = results.flatMap(result => {
    const rows = [
      `${result.agent.padEnd(width)} MCP: ${result.status} (${result.scope})${result.message ? ` - ${result.message}` : ''}`,
    ];
    if (result.instructions) {
      rows.push(`${result.agent.padEnd(width)} instructions: ${result.instructions.status} (${result.instructions.configPath})${result.instructions.message ? ` - ${result.instructions.message}` : ''}`);
    }
    rows.push(`${result.agent.padEnd(width)} lifecycle: ${result.lifecycle?.capability ?? 'unsupported'} (${result.lifecycle?.status ?? 'skipped'})${result.lifecycle?.message ? ` - ${result.lifecycle.message}` : ''}`);
    return rows;
  });
  lines.push(`Result: ${results.some(result => result.status === 'failed' || result.instructions?.status === 'failed' || result.lifecycle?.status === 'failed') ? 'needs attention' : 'ready'}`);
  return lines.join('\n');
}
