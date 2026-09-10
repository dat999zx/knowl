import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The correction classifier, over the real stdin path, on the hosts that actually run it.
 *
 * `detectCorrectionSignal` and `recordCorrectionLesson` were both covered — one as a pure
 * function, the other called directly — and neither test would have gone red for the thing that
 * was true in production: nothing invoked the classifier at all. claude, codex, copilot and
 * openhands register `agent-reminder <host>` under their prompt event, and that command never
 * called it (#289).
 *
 * So these spawn the built CLI and read the row, which is the only shape that can fail for the
 * right reason.
 */

const TEST_DIR = path.join(os.tmpdir(), 'knowl-correction-routing-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: TEST_DIR, encoding: 'utf8', input });
}

async function pendingLessons(): Promise<Array<{ kind: string; conversation: string }>> {
  const client = createClient({ url: `file:${path.join(TEST_DIR, '.knowl', 'knowl.db')}` });
  try {
    const rows = await client.execute('SELECT kind, conversation FROM pending_lessons');
    return rows.rows.map(row => ({ kind: String(row.kind), conversation: String(row.conversation) }));
  } finally {
    client.close();
  }
}

// The four hosts whose prompt event runs `agent-reminder` rather than `agent-hook`.
const HOSTS = ['claude', 'codex', 'copilot', 'openhands'] as const;
const PROMPT_EVENT: Record<string, string> = {
  claude: 'UserPromptSubmit', codex: 'UserPromptSubmit', copilot: 'UserPromptSubmit', openhands: 'UserPromptSubmit',
};

describe('correction capture on the hosts whose prompt event is agent-reminder', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
    // The classifier is armed by config and nothing else; `off` is the shipped default.
    run(['config', 'set', 'capture.events', 'enforce']);
  }, 120_000);

  afterAll(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {}); });

  for (const host of HOSTS) {
    it(`${host}: a correction prompt writes a pending lesson`, async () => {
      const sessionId = `corr-${host}`;
      const before = (await pendingLessons()).length;

      const output = run(['agent-reminder', host], JSON.stringify({
        session_id: sessionId,
        cwd: TEST_DIR,
        prompt: 'no, I already told you not to use that approach',
      }));

      const after = await pendingLessons();
      expect(after.length, `${host} wrote no lesson`).toBe(before + 1);
      expect(after.some(row => row.kind === 'correction')).toBe(true);
      // enforce speaks; the nudge rides the envelope this event was already sending.
      expect(output).toContain('LESSON');
    }, 120_000);
  }

  it('an ordinary prompt writes nothing', async () => {
    const before = (await pendingLessons()).length;
    run(['agent-reminder', 'claude'], JSON.stringify({
      session_id: 'corr-benign', cwd: TEST_DIR, prompt: 'please add a test for the parser',
    }));
    expect((await pendingLessons()).length).toBe(before);
  }, 120_000);
});
