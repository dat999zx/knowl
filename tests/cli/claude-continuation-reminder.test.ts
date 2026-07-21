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
  }, 15_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('emits PostToolUse context on the eighth success and resets after Stop', () => {
    const outputs = [];
    for (let index = 1; index <= 8; index++) {
      outputs.push(run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
        session_id: 'cli-long-session',
        cwd: TEST_DIR,
        tool_name: 'Bash',
        tool_input: { command: `tool-${index}` },
        tool_response: { exit_code: 0 },
      })));
    }

    expect(outputs.slice(0, 7).every(output => output === '')).toBe(true);
    expect(JSON.parse(outputs[7])).toEqual({
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
  }, 30_000);
});
