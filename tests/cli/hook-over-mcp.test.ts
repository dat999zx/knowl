import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { hookPayloadFromArguments, runHookOverMcp } from '../../src/cli/hook-over-mcp.js';
import { mcpHookInput } from '../../src/cli/agents/hook-config.js';

/**
 * The lifecycle hook arriving as a tool call (#224). The first block pins what the host may
 * hand us -- three arrival shapes for one payload -- and the second runs real events through
 * the real handler on a real store, the way `agent-lifecycle.test.ts` does for the process path.
 */
describe('rebuilding the stdin payload from tool arguments', () => {
  const base = { host: 'claude', event: 'PostToolUse', session_id: 's-1', cwd: '/repo', tool_name: 'Bash' };

  it('takes the whole object when the host kept its JSON type (Codex)', () => {
    const payload = hookPayloadFromArguments({
      ...base,
      tool_input: { command: 'npm test', unsafe: 'kept here, dropped by the allowlist later' },
      tool_response: { exit_code: 1, stdout: 'failing' },
      tool_input__command: '${tool_input.command}',
    });
    expect(payload).toEqual({
      session_id: 's-1', cwd: '/repo', tool_name: 'Bash',
      tool_input: { command: 'npm test', unsafe: 'kept here, dropped by the allowlist later' },
      tool_response: { exit_code: 1, stdout: 'failing' },
    });
  });

  it('parses the object when it arrived as its JSON text', () => {
    const payload = hookPayloadFromArguments({
      ...base, tool_input: JSON.stringify({ file_path: '/repo/src/a.ts' }),
    });
    expect(payload.tool_input).toEqual({ file_path: '/repo/src/a.ts' });
  });

  it('rebuilds the object from its leaves when the whole-object template did not resolve', () => {
    for (const whole of ['${tool_input}', '[object Object]', '', undefined]) {
      const payload = hookPayloadFromArguments({
        ...base,
        tool_input: whole,
        tool_input__file_path: '/repo/src/a.ts',
        tool_input__command: '${tool_input.command}',
        tool_response: '${tool_response}',
        tool_response__exit_code: '2',
        tool_response__stderr: '${tool_response.stderr}',
        agent_id: '${agent_id}',
      });
      expect(payload, String(whole)).toEqual({
        session_id: 's-1', cwd: '/repo', tool_name: 'Bash',
        tool_input: { file_path: '/repo/src/a.ts' },
        // Digits through a template are a number again, or every command exits 0.
        tool_response: { exit_code: 2 },
      });
    }
  });

  it('never carries host, event or a leaf key through as a root field', () => {
    const payload = hookPayloadFromArguments({ ...base, tool_input__file_path: '/repo/x' });
    expect(payload).not.toHaveProperty('host');
    expect(payload).not.toHaveProperty('event');
    expect(payload).not.toHaveProperty('tool_input__file_path');
  });

  it('the template the hooks file writes resolves to exactly the keys this reads', () => {
    // Every key the writer emits is either a root field, `host`/`event`, or a `parent__leaf`
    // of one of the two objects. A key outside that set would be forwarded and then dropped
    // by the allowlist, which is a cost with no reader.
    for (const key of Object.keys(mcpHookInput('claude', 'PostToolUse'))) {
      if (key === 'host' || key === 'event') continue;
      if (key.includes('__')) expect(key.startsWith('tool_input__') || key.startsWith('tool_response__'), key).toBe(true);
    }
  });
});

const ROOT = path.join(os.tmpdir(), 'knowl-hook-over-mcp-test');
const OTHER = path.join(os.tmpdir(), 'knowl-hook-over-mcp-other');

describe('running a hook over MCP', () => {
  let projectId = '';

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, OTHER]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
      // The root marker `findProjectRoot` walks for (see `isProjectRoot`), with change impact
      // on so the read-set capture below has a reason to run.
      await fs.writeFile(path.join(dir, '.knowl', 'config.json'), JSON.stringify({
        version: 1, security: { rejectSecrets: true, secretPatterns: [] }, impact: { enabled: true },
      }));
    }
    await fs.writeFile(path.join(ROOT, 'notes.md'), '# notes\n');
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'hook over mcp')).id;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, OTHER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const context = () => ({ projectId, projectRoot: ROOT });

  const sessionEvents = async (): Promise<number> => Number((await getClient().execute(
    'SELECT COUNT(*) AS n FROM memory_session_events',
  )).rows[0].n);

  it('records a tool event the way the process path would, and answers with empty content', async () => {
    const before = await sessionEvents();
    const result = await runHookOverMcp({
      host: 'claude', event: 'PostToolUse', session_id: 'mcp-sess-1', cwd: ROOT,
      tool_name: 'Bash', tool_input: '${tool_input}', tool_input__command: 'npm test',
      tool_response: '${tool_response}', tool_response__exit_code: '0',
    }, context());

    expect(result.isError).toBeUndefined();
    expect(await sessionEvents()).toBeGreaterThan(before);
    // Text, if any, is JSON the host parses as a hook verdict; never prose.
    for (const block of result.content) {
      expect(block.type).toBe('text');
      expect(() => JSON.parse((block as { text: string }).text)).not.toThrow();
    }
  });

  it('records a read into the read-set at the file granularity a Read tool implies', async () => {
    await runHookOverMcp({
      host: 'claude', event: 'PostToolUse', session_id: 'mcp-sess-2', cwd: ROOT,
      tool_name: 'Read', tool_input__file_path: path.join(ROOT, 'notes.md'),
    }, context());

    const rows = (await getClient().execute({
      sql: 'SELECT locator FROM work_read_sets WHERE locator = ? AND released_at IS NULL',
      args: ['file://notes.md'],
    })).rows;
    expect(rows).toHaveLength(1);
  });

  it('is silent for a directory that is not this project', async () => {
    const before = await sessionEvents();
    const result = await runHookOverMcp({
      host: 'claude', event: 'PostToolUse', session_id: 'mcp-sess-3', cwd: OTHER,
      tool_name: 'Bash', tool_input__command: 'ls',
    }, context());
    expect(result).toEqual({ content: [] });
    expect(await sessionEvents()).toBe(before);
  });

  it('is silent for its own tool call, an incomplete payload, and an unknown host', async () => {
    const before = await sessionEvents();
    expect(await runHookOverMcp({
      host: 'claude', event: 'PostToolUse', session_id: 's', cwd: ROOT, tool_name: 'mcp__knowl__knowl_hook',
    }, context())).toEqual({ content: [] });
    expect(await runHookOverMcp({ host: 'claude', event: 'PostToolUse', session_id: 's' }, context())).toEqual({ content: [] });
    expect(await runHookOverMcp({ host: 'nothost', event: 'PostToolUse', cwd: ROOT }, context())).toEqual({ content: [] });
    expect(await runHookOverMcp({ host: 'claude', event: 'PostToolUse', cwd: ROOT }, { projectId: null, projectRoot: null })).toEqual({ content: [] });
    expect(await sessionEvents()).toBe(before);
  });

  it('answers a pre-tool question with the host envelope or with nothing, never with an error', async () => {
    const result = await runHookOverMcp({
      host: 'claude', event: 'PreToolUse', session_id: 'mcp-sess-4', cwd: ROOT,
      tool_name: 'Edit', tool_input__file_path: path.join(ROOT, 'notes.md'),
    }, context());
    expect(result.isError).toBeUndefined();
    for (const block of result.content) {
      const parsed = JSON.parse((block as { text: string }).text);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    }
  });
});
