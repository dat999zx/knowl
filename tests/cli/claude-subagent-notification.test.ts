import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../../src/cli/agents/hook-config.js';

const TEST_DIR = path.resolve('./.knowl-claude-subagent-notification-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf8',
    input,
  });
}

const post = (sessionId: string, agentId: string | undefined, toolName: string, toolInput: unknown) =>
  run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
    session_id: sessionId,
    cwd: TEST_DIR,
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { exit_code: 0 },
  }));

describe('Claude subagent change notification CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    // The `claude` agent positional is what writes .claude/settings.json hooks.
    run(['init', 'claude', '--yes']);
    // Seed one item so bootstrap context is non-empty: an empty project has nothing
    // to say at SubagentStart, and hostContextOutput correctly emits nothing then.
    run(['decide', 'Project uses local memory', 'Knowl stores project memory locally.']);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('registers SubagentStart and SubagentStop handlers', async () => {
    expect(CLAUDE_HOOK_EVENTS).toContain('SubagentStart');
    expect(CLAUDE_HOOK_EVENTS).toContain('SubagentStop');

    // `knowl init claude` writes project-local hooks to settings.local.json.
    const settings = JSON.parse(await fs.readFile(path.join(TEST_DIR, '.claude', 'settings.local.json'), 'utf8'));
    for (const event of ['SubagentStart', 'SubagentStop']) {
      const handlers = settings.hooks[event].flatMap((entry: any) => entry.hooks);
      expect(handlers.some((hook: any) => hook.command.includes(`agent-hook claude ${event} `))).toBe(true);
    }
  }, 120_000);

  it('bootstraps a subagent and then notifies it of a sibling write', async () => {
    run(['agent-hook', 'claude', 'SessionStart', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
    }));

    const bootstrap = run(['agent-hook', 'claude', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
      agent_id: 'e2e-agent',
      agent_type: 'Explore',
      prompt_id: 'prompt-1',
    }));
    expect(JSON.parse(bootstrap).hookSpecificOutput.hookEventName).toBe('SubagentStart');

    // The subagent's first tool call adopts head silently.
    expect(post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'x' })).toBe('');

    // A sibling stores something the subagent has never seen. `knowl decide <title>
    // <content>` is non-interactive when both positionals are given, and creates
    // exactly one commit through recordDecisionDirect.
    run(['decide', 'Sibling wrote this decision', 'Stored by another agent.']);

    const notified = post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'y' });
    const context = JSON.parse(notified).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: Sibling wrote this decision');

    // Delivered once only.
    expect(post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'z' })).toBe('');
  }, 120_000);

  it('does not notify the agent that made the write', async () => {
    run(['agent-hook', 'claude', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'e2e-writer-session',
      cwd: TEST_DIR,
      agent_id: 'writer-agent',
      agent_type: 'general-purpose',
      prompt_id: 'prompt-2',
    }));
    expect(post('e2e-writer-session', 'writer-agent', 'Grep', { pattern: 'warmup' })).toBe('');

    run(['decide', 'The writer agent own decision', 'Written by the same agent.']);

    // The PostToolUse that follows the agent's own write carries the same title in
    // tool_input, so content attribution recognises the commit as its own.
    const output = post('e2e-writer-session', 'writer-agent', 'mcp__knowl__knowl_decide', {
      title: 'The writer agent own decision',
      content: 'Written by the same agent.',
    });
    expect(output).toBe('');
  }, 120_000);

  it('closes the subagent binding on SubagentStop without emitting output', () => {
    expect(run(['agent-hook', 'claude', 'SubagentStop', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
      agent_id: 'e2e-agent',
      agent_type: 'Explore',
      stop_hook_active: false,
      last_assistant_message: 'done',
    }))).toBe('');
  }, 120_000);
});
