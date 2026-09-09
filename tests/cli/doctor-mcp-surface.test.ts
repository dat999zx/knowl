import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { installKnowlProjectGuidance } from '../../src/core/agents-guidance.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

/**
 * Doctor's three MCP-surface checks, against the surface rather than against a literal.
 *
 * All three used to test `KNOWL_MCP_TOOL_NAMES`, which is flattened from the prose routing
 * groups in `core/knowl-guidance.ts` and declared `as const`. Nothing a repository can do
 * changes it, so the checks reported `[OK] MCP tools expose knowl_query`, `[OK] ...task tools`
 * and `[OK] ...skill bridge tools` in a repository with zero integrations, printed directly
 * beside `[OK] No agent MCP integration selected` -- and would have gone on reporting OK with
 * the tool deleted from `CORE_TOOL_DEFINITIONS`, which is the array a host actually connects to.
 *
 * The stub is what makes them checks at all: `knowlToolDefinitions` is the real surface, so
 * removing a tool from what it returns is the only way to ask whether doctor is looking at it.
 * With `tools` left null the real function runs, which is the assertion that the shipped surface
 * genuinely satisfies what the other cases prove doctor is reading.
 */
const state = vi.hoisted(() => ({ tools: null as string[] | null }));

vi.mock('../../src/mcp/tools.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/mcp/tools.js')>();
  return {
    ...actual,
    knowlToolDefinitions: (config: any) => (state.tools === null
      ? actual.knowlToolDefinitions(config)
      : state.tools.map(name => ({ name, description: '', inputSchema: {} }))),
  };
});

const { runDoctor } = await import('../../src/cli/doctor-report.js');
const { knowlToolDefinitions } = await import('../../src/mcp/tools.js');

/** Every tool the shipped surface serves an unconfigured repository, as a starting point to subtract from. */
const SHIPPED = knowlToolDefinitions(null).map(tool => tool.name);

let root = '';

async function doctorChecks(): Promise<Array<{ status: string; message: string }>> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-doctor-mcp-'));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf-8');
  // Otherwise the guidance check FAILs in every test here, for reasons unrelated to tools.
  await installKnowlProjectGuidance(root);
  await initDb(root);
  await repo.createProject(root, 'doctor-mcp-surface');
  await closeDb();
  return (await runDoctor(root)).checks;
}

// Matched on a pattern rather than a substring: the OK and the failing message for each check share
// no wording, so a substring can only ever select one of the two branches -- which reads as a
// missing check rather than a wrong one.
const find = (checks: Array<{ status: string; message: string }>, pattern: RegExp) =>
  checks.find(check => pattern.test(check.message))!;

describe('the MCP surface checks in doctor', () => {
  beforeEach(() => { state.tools = null; });

  afterEach(async () => {
    state.tools = null;
    await closeDb().catch(() => {});
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    root = '';
  });

  it('reports OK against the surface this build actually serves', async () => {
    const checks = await doctorChecks();
    expect(find(checks, /knowl_query/).status).toBe('OK');
    expect(find(checks, /work-loop task tools|knowl_task_start/).status).toBe('OK');
    expect(find(checks, /skill bridge tools|knowl_skill_list/).status).toBe('OK');
  });

  it('fails when the served surface has no knowl_query', async () => {
    state.tools = SHIPPED.filter(name => name !== 'knowl_query');
    expect(find(await doctorChecks(), /knowl_query/).status).toBe('FAIL');
  });

  it('fails when the served surface brings knowl_ask back', async () => {
    state.tools = [...SHIPPED, 'knowl_ask'];
    expect(find(await doctorChecks(), /knowl_query/).status).toBe('FAIL');
  });

  it('warns when the served surface drops a work-loop tool', async () => {
    state.tools = SHIPPED.filter(name => name !== 'knowl_task_checkpoint');
    expect(find(await doctorChecks(), /work-loop task tools|knowl_task_start/).status).toBe('WARN');
  });

  it('warns when the served surface drops a skill bridge tool', async () => {
    state.tools = SHIPPED.filter(name => name !== 'knowl_skill_run');
    expect(find(await doctorChecks(), /skill bridge tools|knowl_skill_list/).status).toBe('WARN');
  });
});
