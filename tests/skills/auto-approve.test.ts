import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createSkillPackage } from '../../src/skills/registry.js';
import { approveCreatedSkill, isAutoApproveCreatedSkills, readTrust } from '../../src/skills/trust.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

const CLI = path.resolve('./dist/index.js');

describe('approving a skill the person just created', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-autoapprove-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const make = (name: string, capabilities?: string[]) => createSkillPackage(root, {
    name,
    purpose: 'probe',
    entrypoints: { default: { type: 'shell', command: 'echo hi', autoRun: true } },
    requires: capabilities ? { capabilities } : undefined,
  } as any);

  it('is on when the key is unset or true, off only for the literal false', () => {
    expect(isAutoApproveCreatedSkills(undefined)).toBe(true);
    expect(isAutoApproveCreatedSkills(null)).toBe(true);
    expect(isAutoApproveCreatedSkills({ ...DEFAULT_CONFIG } as ProjectConfig)).toBe(true);
    expect(isAutoApproveCreatedSkills({ ...DEFAULT_CONFIG, trust: { autoApproveCreatedSkills: true } })).toBe(true);
    expect(isAutoApproveCreatedSkills({ ...DEFAULT_CONFIG, trust: { autoApproveCreatedSkills: false } })).toBe(false);
  });

  it('approves a plain skill and records who and how', async () => {
    const skill = await make('plain');
    expect(await approveCreatedSkill(root, skill.manifest, { ...DEFAULT_CONFIG }, 'ana')).toBe('approved');
    const record = await readTrust(root, 'plain');
    expect(record?.approvedBy).toBe('cli:create:ana');
    expect(record?.approvedHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does nothing when the toggle is off', async () => {
    const skill = await make('off');
    const config = { ...DEFAULT_CONFIG, trust: { autoApproveCreatedSkills: false } };
    expect(await approveCreatedSkill(root, skill.manifest, config, 'ana')).toBe('off');
    expect(await readTrust(root, 'off')).toBeNull();
  });

  it('leaves a skill that declares an external effect for knowl skill approve', async () => {
    const skill = await make('net', ['network']);
    expect(await approveCreatedSkill(root, skill.manifest, { ...DEFAULT_CONFIG }, 'ana')).toBe('needs-confirmation');
    expect(await readTrust(root, 'net')).toBeNull();
  });

  it('is never done for a skill an agent creates over MCP', async () => {
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await saveConfig(root, { ...DEFAULT_CONFIG });
    await initDb(root);
    await repo.createProject(root, 'autoapprove-probe');
    const server = createMcpServer('local', root, { ...DEFAULT_CONFIG });
    const transport: any = { async start() {}, async send(m: any) { transport.onSend?.(m); }, async close() { transport.onclose?.(); } };
    await server.connect(transport);
    const init = new Promise<any>(r => { transport.onSend = (m: any) => { if (m.id === 'init') r(m); }; });
    transport.onmessage({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await init;
    transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const done = new Promise<any>(r => { transport.onSend = (m: any) => { if (m.id === 'call') r(m); }; });
    transport.onmessage({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'knowl_skill_create', arguments: {
      name: 'agent-made', purpose: 'probe', markdown: '# x',
      entrypoints: { default: { type: 'shell', command: 'echo hi', autoRun: true } },
    } } });
    const result = (await done).result;
    await server.close();
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    expect(result.isError).not.toBe(true);
    expect(await readTrust(root, 'agent-made')).toBeNull();
  }, 60_000);

  describe('through the built CLI', () => {
    const run = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8' });

    it('runs a created skill with no approve, and a changed byte revokes it', async () => {
      execFileSync(process.execPath, [CLI, 'init', '--yes'], { cwd: root, encoding: 'utf-8' });
      const created = run(['skill', 'create', 'hello', '--purpose', 'say hi', '--file', "hi.js=console.log('auto-ok');\n", '--script', 'hi.js'], root);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).toContain('Approved for execution');

      const ran = run(['skill', 'run', 'hello'], root);
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout).toContain('auto-ok');

      await fs.appendFile(path.join(root, '.knowl', 'skills', 'hello', 'hi.js'), '// edited\n');
      const refused = run(['skill', 'run', 'hello'], root);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/not been approved|approv/i);
    }, 120_000);

    it('asks for knowl skill approve when the toggle is off', async () => {
      execFileSync(process.execPath, [CLI, 'init', '--yes'], { cwd: root, encoding: 'utf-8' });
      const set = run(['config', 'set', 'trust.autoApproveCreatedSkills', 'false'], root);
      expect(set.status, set.stderr).toBe(0);
      const created = run(['skill', 'create', 'hello', '--purpose', 'say hi', '--file', "hi.js=console.log('x');\n", '--script', 'hi.js'], root);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain('Approved for execution');
      const refused = run(['skill', 'run', 'hello'], root);
      expect(refused.status).not.toBe(0);
    }, 120_000);
  });
});
