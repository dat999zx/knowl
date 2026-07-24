import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KNOWL_CLAUDE_PROMPT_REMINDER } from '../../src/core/knowl-guidance.js';

const CLI_PATH = path.resolve('./dist/index.js');
let outsideRoot: string;

const run = (input?: string) => execFileSync(
  process.execPath,
  [CLI_PATH, 'agent-reminder', 'claude', '--json'],
  { cwd: outsideRoot, encoding: 'utf8', input },
);

describe('Claude prompt reminder', () => {
  beforeAll(async () => {
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-agent-reminder-'));
  });
  afterAll(() => fs.rm(outsideRoot, { recursive: true, force: true }));

  it('emits the exact non-blocking Claude hook response outside a Knowl project', async () => {
    expect(JSON.parse(run())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: KNOWL_CLAUDE_PROMPT_REMINDER,
      },
    });
    expect(await fs.readdir(outsideRoot)).toEqual([]);
  });

  it('does not consume malformed or secret-looking stdin', () => {
    const baseline = run();
    expect(run('{')).toBe(baseline);
    expect(run('sk-test-abcdefghijklmnopqrstuvwxyz123456')).toBe(baseline);
  });
});
