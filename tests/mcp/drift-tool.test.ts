import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_IDENTITY_FLAGS } from '../git-identity.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * `knowl_drift` end to end, against a real repository and a real commit window.
 *
 * The tool is the agent's end of `knowl pr`, so what has to hold is the pair the CLI holds:
 * previewing changes nothing, and applying marks the matched atoms. Both are asserted through
 * the tool rather than through `checkKnowledgeDrift`, because everything between them -- the
 * git calls, the missing-ref path, the preview default -- lives in the handler and nowhere else.
 *
 * The diff removes a file rather than editing one, which is what the check actually reports on:
 * an atom whose cited path merely changed is dropped by design.
 */
const ROOT = path.resolve('./.knowl-drift-tool-test');
const git = (args: string) => execSync(`git ${GIT_IDENTITY_FLAGS} ${args}`, { cwd: ROOT, encoding: 'utf-8' });

const CONFIG: ProjectConfig = { version: 1, security: { rejectSecrets: true, secretPatterns: [] } };

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
let base = '';

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drift-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const jsonOf = (result: any) => JSON.parse(String(result?.content?.[0]?.text ?? '{}'));

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  git('init');
  await fs.writeFile(path.join(ROOT, 'src/auth.ts'), 'export const scheme = "session";\n');
  await fs.writeFile(path.join(ROOT, 'src/untouched.ts'), 'export const other = 1;\n');
  git('add -A');
  git('commit -m "base"');
  base = git('rev-parse HEAD').trim();

  // The change the drift check is asked about. It has to be a REMOVAL: an atom whose cited file
  // was merely edited is dropped on purpose (226 of 339 observations in the measured store), so a
  // fixture that only edits the file asserts nothing and would pass for the wrong reason.
  await fs.rm(path.join(ROOT, 'src/auth.ts'));
  git('add -A');
  git('commit -m "drop the session scheme"');

  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'Drift tool')).id;
  await repo.createKnowledgeItem(projectId, {
    category: 'decision', title: 'Auth uses session cookies',
    content: 'Sessions rather than tokens.', affectedPaths: ['src/auth.ts'],
  });
  await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Something else entirely',
    content: 'Unrelated to the diff.', affectedPaths: ['src/untouched.ts'],
  });
});

afterAll(async () => {
  await closeDb();
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_drift', () => {
  it('names the atom whose cited file the diff changed, and leaves the others alone', async () => {
    const report = jsonOf(await callTool('knowl_drift', { since: base }));
    expect(report.sinceCommit).toBe(base);
    expect(report.changedFiles).toBe(1);
    expect(report.candidates.map((candidate: any) => candidate.title)).toEqual(['Auth uses session cookies']);
    expect(report.candidates[0].removedPaths).toContain('src/auth.ts');
    expect(report.candidates[0].kind).toBe('removed');
  });

  it('previews by default: nothing is marked until apply is asked for', async () => {
    const preview = jsonOf(await callTool('knowl_drift', { since: base }));
    expect(preview.applied).toBe(false);
    expect(preview.markedForReview).toBe(0);
    const item = await repo.getKnowledgeItem(preview.candidates[0].id);
    expect(item?.freshness).not.toBe('needs_review');
  });

  it('marks the matches when apply is true', async () => {
    const applied = jsonOf(await callTool('knowl_drift', { since: base, apply: true }));
    expect(applied.applied).toBe(true);
    expect(applied.markedForReview).toBe(1);
    const item = await repo.getKnowledgeItem(applied.candidates[0].id);
    expect(item?.freshness).toBe('needs_review');
  });

  it('reports a ref git cannot resolve as an error naming the ref, not a crash', async () => {
    const result = await callTool('knowl_drift', { since: 'no-such-ref-anywhere' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('no-such-ref-anywhere');
  });

  it('refuses a call with no base ref rather than comparing against nothing', async () => {
    const result = await callTool('knowl_drift', {});
    expect(result.isError).toBe(true);
  });
});
