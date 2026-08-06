import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DIR = path.join(os.tmpdir(), 'knowl-session-cli-test');
const CLI_PATH = path.resolve('./dist/index.js');

describe('session CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    execSync(`node "${CLI_PATH}" init --yes`, { cwd: TEST_DIR, encoding: 'utf-8' });
  }, 120_000);
  afterAll(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {}); });

  it('starts, records, finishes, and recovers sessions with JSON output', () => {
    const started = JSON.parse(execSync(`node "${CLI_PATH}" session start "Implement search" --query "retrieval" --json`, { cwd: TEST_DIR, encoding: 'utf-8' }));
    expect(started).toMatchObject({ id: expect.any(String), status: 'active', title: 'Implement search' });

    const event = JSON.parse(execSync(`node "${CLI_PATH}" session event ${started.id} command --exit-code 1 --summary "test command failed" --json`, { cwd: TEST_DIR, encoding: 'utf-8' }));
    expect(event).toMatchObject({ sessionId: started.id, type: 'command', payload: { exitCode: 1, summary: 'test command failed' } });

    // A commit subject is what yields a promotable candidate now. Before the extractor
    // rebuild this session promoted on `stop.summary` alone; that rule measured at zero
    // value and was removed, so without an event carrying real knowledge the finish below
    // correctly reports `skipped` and this test would assert nothing about promotion.
    execSync(`node "${CLI_PATH}" session event ${started.id} command --exit-code 0 --command "git commit -q -m \\"fix(cli): record a promotable session event\\"" --json`, { cwd: TEST_DIR, encoding: 'utf-8' });

    const finished = JSON.parse(execSync(`node "${CLI_PATH}" session finish ${started.id} --status failed --summary "failure recorded" --json`, { cwd: TEST_DIR, encoding: 'utf-8' }));
    expect(finished).toMatchObject({ id: started.id, status: 'failed', promotion: { status: 'promoted', itemIds: expect.any(Array) } });

    const recovered = JSON.parse(execSync(`node "${CLI_PATH}" session recover --json`, { cwd: TEST_DIR, encoding: 'utf-8' }));
    expect(recovered).toMatchObject({ recoveredCount: expect.any(Number), purgedEventCount: expect.any(Number) });
  }, 120_000);
});
