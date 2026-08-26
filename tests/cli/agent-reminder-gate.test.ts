import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DIR = path.join(os.tmpdir(), 'knowl-agent-reminder-gate-test');
const CLI_PATH = path.resolve('./dist/index.js');
const SESSION = 'gate-session';

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: TEST_DIR, encoding: 'utf8', input });
}

const reminder = () => run(['agent-reminder', 'claude', '--json'], JSON.stringify({
  session_id: SESSION, cwd: TEST_DIR,
}));

/** One completed turn: a tool event binds the turn, Stop ends it and bumps `capture_outcomes.turns`. */
function completeTurn(index: number): void {
  run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
    session_id: SESSION, cwd: TEST_DIR,
    tool_name: 'Bash', tool_input: { command: `tool-${index}` }, tool_response: { exit_code: 0 },
  }));
  run(['agent-hook', 'claude', 'Stop', '--json'], JSON.stringify({ session_id: SESSION, cwd: TEST_DIR }));
}

describe('prompt reminder drift gate', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
    run(['agent-hook', 'claude', 'SessionStart', '--json'], JSON.stringify({ session_id: SESSION, cwd: TEST_DIR }));
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('speaks on the first prompt of a conversation and goes silent once turns accumulate', () => {
    // Turn 0: the conversation has never seen the card, so it always gets one.
    expect(JSON.parse(reminder()).hookSpecificOutput.additionalContext).toContain('KNOWL');

    completeTurn(1);
    completeTurn(2);

    // The card is a static restatement of KNOWL.md/AGENTS.md, which is already in the system
    // prompt. Repeating it every turn is what this gate exists to stop.
    expect(reminder()).toBe('');
  }, 120_000);
});
