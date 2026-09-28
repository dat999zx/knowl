import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runDoctor } from '../../src/cli/doctor-report.js';
import { applyDoctorRemedies } from '../../src/cli/doctor-fix.js';
import { installKnowlProjectGuidance } from '../../src/core/agents-guidance.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { mergeHookConfig } from '../../src/cli/agents/hook-config.js';
import { HOOK_TOOL_NAME } from '../../src/core/hooks-transport.js';

/**
 * Doctor's view of the hooks transport: a hooks file that calls `knowl_hook` is only as good as
 * the `knowl` server the host has registered, and a hooks file written for one transport while
 * the config names the other is stale.
 */
let root = '';
let home = '';
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

const hooksPath = () => path.join(root, '.claude', 'settings.local.json');
const mcpPath = () => path.join(root, '.mcp.json');
const knowlEntry = { command: process.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'claude'] };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-doctor-transport-'));
  // A home of its own, so a knowl server registered for the real user does not answer for this repo.
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-doctor-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf-8');
  await installKnowlProjectGuidance(root);
  await initDb(root);
  await repo.createProject(root, 'doctor-transport');
  await closeDb();
});

afterEach(async () => {
  await closeDb();
  process.env.HOME = savedHome.HOME;
  process.env.USERPROFILE = savedHome.USERPROFILE;
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('doctor and the hooks transport', () => {
  it('warns when hooks call knowl_hook but no knowl server is registered, and --fix registers it', async () => {
    await mergeHookConfig(hooksPath(), process.platform, 'claude', { transport: 'mcp' });
    await fs.writeFile(mcpPath(), JSON.stringify({ mcpServers: {} }));

    const result = await runDoctor(root);
    const check = result.checks.find(c => /knowl MCP server is not registered/.test(c.message));
    expect(check?.status).toBe('WARN');
    expect(check?.remedy).toEqual({ kind: 'host-init', host: 'claude' });

    await applyDoctorRemedies(root, result.checks, {});
    await closeDb();
    const mcp = JSON.parse(await fs.readFile(mcpPath(), 'utf8'));
    expect(mcp.mcpServers.knowl).toBeDefined();
    expect(await fs.readFile(hooksPath(), 'utf8')).toContain(HOOK_TOOL_NAME);
    const after = await runDoctor(root);
    expect(after.checks.some(c => /knowl MCP server is not registered/.test(c.message))).toBe(false);
  });

  it('warns when the hooks file was written for a transport the config does not name', async () => {
    await mergeHookConfig(hooksPath(), process.platform, 'claude', { transport: 'command' });
    await fs.writeFile(mcpPath(), JSON.stringify({ mcpServers: { knowl: knowlEntry } }));

    const result = await runDoctor(root);
    const check = result.checks.find(c => /claude lifecycle hooks/.test(c.message));
    expect(check?.status).toBe('WARN');
    expect(check?.remedy).toEqual({ kind: 'host-init', host: 'claude' });

    await applyDoctorRemedies(root, result.checks, {});
    await closeDb();
    expect(await fs.readFile(hooksPath(), 'utf8')).toContain(HOOK_TOOL_NAME);
  });
});
