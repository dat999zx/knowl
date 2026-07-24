import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KNOWL_CLAUDE_CONTINUATION_REMINDER } from '../../src/core/knowl-guidance.js';

const TEST_DIR = path.resolve('./.knowl-claude-continuation-reminder-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf8',
    input,
  });
}

describe('Claude continuation reminder CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('emits PostToolUse context after 12 non-Knowl successes and resets after Stop', () => {
    const outputs = [];
    for (let index = 1; index <= 12; index++) {
      outputs.push(run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
        session_id: 'cli-long-session',
        cwd: TEST_DIR,
        tool_name: 'Bash',
        tool_input: { command: `tool-${index}` },
        tool_response: { exit_code: 0 },
      })));
    }

    expect(outputs.slice(0, 11).every(output => output === '')).toBe(true);
    expect(JSON.parse(outputs[11])).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
      },
    });

    expect(run(['agent-hook', 'claude', 'Stop', '--json'], JSON.stringify({
      session_id: 'cli-long-session',
      cwd: TEST_DIR,
    }))).toBe('');
    expect(run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
      session_id: 'cli-long-session',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'next-turn-tool' },
      tool_response: { exit_code: 0 },
    }))).toBe('');
  }, 120_000);

  it('a Knowl tool call resets the drift counter so no reminder fires', () => {
    const post = (toolName: string, command: string) => run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
      session_id: 'cli-reset-session',
      cwd: TEST_DIR,
      tool_name: toolName,
      tool_input: { command },
      tool_response: { exit_code: 0 },
    }));

    // Drift to 11 — one short of the reminder threshold.
    for (let index = 1; index <= 11; index++) post('Bash', `tool-${index}`);
    // A Knowl call resets the streak, so the call that *would* have been the
    // 12th stays quiet. (Full reset semantics are covered in host-lifecycle.test.ts.)
    expect(post('mcp__knowl__knowl_query', 'query')).toBe('');
    expect(post('Bash', 'would-have-been-twelfth')).toBe('');
  }, 120_000);
});
