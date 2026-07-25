import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_HOOK_EVENTS } from '../../src/cli/agents/hook-config.js';

const TEST_DIR = path.resolve('./.knowl-codex-subagent-notification-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: TEST_DIR, encoding: 'utf8', input });
}

const post = (sessionId: string, agentId: string | undefined, toolName: string, toolInput: unknown) =>
  run(['agent-hook', 'codex', 'PostToolUse', '--json'], JSON.stringify({
    session_id: sessionId,
    turn_id: 'turn-1',
    cwd: TEST_DIR,
    ...(agentId ? { agent_id: agentId, agent_type: 'reviewer' } : {}),
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { exit_code: 0 },
  }));

describe('Codex subagent change notification CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', 'codex', '--yes']);
    run(['decide', 'Codex project uses local memory', 'Knowl stores project memory locally.']);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('registers the subagent events for Codex', () => {
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStart');
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStop');
  });

  it('bootstraps a Codex subagent and notifies it of a sibling write', () => {
    run(['agent-hook', 'codex', 'SessionStart', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
    }));

    const bootstrap = run(['agent-hook', 'codex', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
      agent_id: 'codex-agent', agent_type: 'reviewer',
    }));
    expect(JSON.parse(bootstrap).hookSpecificOutput.hookEventName).toBe('SubagentStart');

    expect(post('codex-e2e', 'codex-agent', 'shell', { command: 'ls' })).toBe('');

    run(['decide', 'A sibling decided something for Codex', 'Stored by another agent.']);

    const notified = post('codex-e2e', 'codex-agent', 'read_file', { path: 'README.md' });
    const context = JSON.parse(notified).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: A sibling decided something for Codex');

    expect(post('codex-e2e', 'codex-agent', 'read_file', { path: 'LICENSE' })).toBe('');
  }, 120_000);

  it('closes the Codex subagent binding on SubagentStop', () => {
    expect(run(['agent-hook', 'codex', 'SubagentStop', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
      agent_id: 'codex-agent', agent_type: 'reviewer',
    }))).toBe('');
  }, 120_000);
});
