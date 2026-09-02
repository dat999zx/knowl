import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { knowlToolDefinitions } from '../../src/mcp/tools.js';
import { CORE_TOOL_DEFINITIONS } from '../../src/mcp/tool-definitions.js';
import { closeFleetDb, recordFleetCard, recordFleetTurnStart, touchFleetSession } from '../../src/fleet/store.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The MCP half of fleet awareness: one tool, gated on a switch that ships ON.
 *
 * The roster is Claude Code's own session registry, so the fixture is a registry: one record
 * under a private CLAUDE_CONFIG_DIR carrying this very process's pid, the only pid a test can
 * promise is alive. Whatever real sessions the machine is running appear beside it -- the
 * roster reads every config dir under the home on purpose -- so the assertions narrow by a
 * folder name nothing else on the box is called rather than by count.
 */
const ROOT = path.resolve('./.knowl-fleet-tool-test');
const HOME = path.join(ROOT, 'home');
const CONFIG_DIR = path.join(ROOT, 'claude');
const PEER_REPO = 'fleet-tool-peer';
const PEER_CWD = path.join(ROOT, PEER_REPO);
const PEER = { host: 'claude', sessionId: 'fleet-tool-peer-session' };
const previous = { home: process.env.KNOWL_HOME, configDir: process.env.CLAUDE_CONFIG_DIR };

const baseConfig = (): ProjectConfig => ({ version: 1, security: { rejectSecrets: true, secretPatterns: [] } });
// Three configs, because the default is the interesting one: `enabled` absent must read as on.
const FLEET_ON: ProjectConfig = { ...baseConfig(), fleet: { enabled: true } };
const FLEET_OFF: ProjectConfig = { ...baseConfig(), fleet: { enabled: false } };
const FLEET_UNSET: ProjectConfig = baseConfig();

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

let projectId = '';

async function callTool(config: ProjectConfig, name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, ROOT, config);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fleet-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const textOf = (result: any): string => String(result?.content?.[0]?.text ?? '');

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(CONFIG_DIR, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: PEER.sessionId, cwd: PEER_CWD, startedAt: Date.now() - 60_000,
    name: 'fleet-tool-peer-ab', kind: 'interactive',
  }));
  process.env.KNOWL_HOME = HOME;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'fleet tool')).id;
  await touchFleetSession({ ...PEER, projectRoot: PEER_CWD, repo: PEER_REPO });
  await recordFleetTurnStart({ ...PEER, ask: 'fix the flaky roster test' });
  await recordFleetCard({ ...PEER, kind: 'same-problem', subject: 'sig-1', mode: 'shadow' });
});

afterAll(async () => {
  await closeDb();
  await closeFleetDb();
  if (previous.home === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = previous.home;
  if (previous.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.configDir;
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_fleet registration', () => {
  it('is listed when fleet.enabled is true or absent, and not when false', () => {
    const names = (config: ProjectConfig) => knowlToolDefinitions(config).map(tool => tool.name);
    expect(names(FLEET_ON)).toContain('knowl_fleet');
    expect(names(FLEET_UNSET)).toContain('knowl_fleet');
    expect(names(FLEET_OFF)).not.toContain('knowl_fleet');
  });

  it('adds exactly one tool, and none to a server with no config at all', () => {
    // The budget rule every gated set cites: a registered tool costs guidance-card space in
    // every session of every user. And `null` is the init-error server, which offers the core
    // set alone -- the reason the gate is `config && isFleetEnabled(config)` and not the reader.
    expect(knowlToolDefinitions(FLEET_UNSET)).toHaveLength(knowlToolDefinitions(FLEET_OFF).length + 1);
    expect(knowlToolDefinitions(null)).toHaveLength(CORE_TOOL_DEFINITIONS.length);
  });

  it('answers a call while gated off with a disabled error, not "unknown tool"', async () => {
    const result = await callTool(FLEET_OFF, 'knowl_fleet', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('fleet.enabled=false');
    expect(textOf(result)).not.toMatch(/Unknown tool/i);
  });

  it('validates arguments while gated off, which proves the schema is registered', async () => {
    // Dispatch validates against SCHEMA_BY_TOOL before it reaches the gate, so a refusal that
    // names the argument is only possible if the gated-off tool's schema is in that map.
    const result = await callTool(FLEET_OFF, 'knowl_fleet', { inRepo: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('inRepo');
    expect(textOf(result)).not.toContain('fleet.enabled=false');
  });

  it('does not offer the act-as rebind, so a repo name filters rather than re-targets', async () => {
    // `repo` on this surface means "run as that linked repo" and is intercepted before the
    // handler; the filter had that name first and every call naming a repo was refused with
    // "not in a workspace". The filter is `inRepo`, and `repo` is declined as the act-as it is.
    const result = await callTool(FLEET_ON, 'knowl_fleet', { repo: PEER_REPO });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not take a "repo" argument');
  });
});

describe('knowl_fleet listing', () => {
  it('lists a live session from the host registry with what the store knows about it', async () => {
    const text = textOf(await callTool(FLEET_UNSET, 'knowl_fleet', { inRepo: PEER_REPO }));
    expect(text).toContain(`1 live Claude Code session in ${PEER_REPO}`);
    expect(text).toContain('fleet-tool-peer-ab');
    expect(text).toContain('on: fix the flaky roster test');
    // The way to reach a session is the host's, and the listing has to say so or the agent
    // will look for a knowl verb that does not exist.
    expect(text).toContain('SendMessage');
  });

  it('says so when the repo filter matches nothing', async () => {
    const text = textOf(await callTool(FLEET_ON, 'knowl_fleet', { inRepo: 'no-such-repo-anywhere' }));
    expect(text).toMatch(/^No live Claude Code sessions in repo "no-such-repo-anywhere"\./);
  });

  it('appends the card ledger on request, with an unadjudicated ledger reading as unmeasured', async () => {
    const text = textOf(await callTool(FLEET_ON, 'knowl_fleet', { inRepo: PEER_REPO, cards: true }));
    expect(text).toContain('Fleet cards:');
    expect(text).toMatch(/shadowed:\s+1/);
    expect(text).toMatch(/adjudicated:\s+0 of 1/);
    // No evidence is not a perfect score; the same rule `knowl status` applies to the write gate.
    expect(text).toMatch(/precision:\s+not yet measured/);
    expect(text).not.toMatch(/100\.0%/);
  });

  it('leaves the ledger out unless asked', async () => {
    const text = textOf(await callTool(FLEET_ON, 'knowl_fleet', { inRepo: PEER_REPO }));
    expect(text).not.toContain('Fleet cards:');
  });
});
