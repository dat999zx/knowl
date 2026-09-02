import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `knowl fleet` against the built CLI, from a directory that is not a Knowl project.
 *
 * That is the case the command exists for: the fleet is machine-level and the terminal a user
 * asks from is often outside every repo, so a command that needed `.knowl/` there would answer
 * "not a Knowl project" exactly where it was wanted. The registry fixture carries this test
 * runner's own pid, the one pid the spawned child can be promised is alive.
 */
const ROOT = path.resolve('./.knowl-fleet-cli-test');
const HOME = path.join(ROOT, 'home');
const CONFIG_DIR = path.join(ROOT, 'claude');
const CWD = path.join(ROOT, 'not-a-project');
const PEER_REPO = 'fleet-cli-peer';
const PEER_SESSION = 'fleet-cli-peer-session';
const CLI = path.resolve('./dist/index.js');

function knowl(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: CWD,
    encoding: 'utf-8',
    env: {
      ...process.env,
      KNOWL_HOME: HOME,
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      // Pins the roster to this fixture. Without it the real home's config dirs are read too,
      // so a suite run from inside a live session sees the developer's own fleet.
      KNOWL_CLAUDE_CONFIG_DIRS: CONFIG_DIR,
      // What Claude Code sets in the shell it runs commands in; the CLI marks that session `(you)`.
      CLAUDE_CODE_SESSION_ID: PEER_SESSION,
      NO_COLOR: '1',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

// Each assertion spawns the real built CLI, which costs seconds of node startup per invocation.
describe('knowl fleet', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(CWD, { recursive: true });
    await fs.mkdir(path.join(CONFIG_DIR, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: PEER_SESSION, cwd: path.join(ROOT, PEER_REPO), startedAt: Date.now() - 120_000,
      name: 'fleet-cli-peer-cd', kind: 'interactive',
    }));
  });

  afterAll(async () => {
    // The child opened and closed the fleet database; on Windows the WAL sidecar can still be
    // held for a moment after it exits, and a stray test root is worth less than a red run.
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('lists the live sessions as JSON without a Knowl project, marking the caller', () => {
    const result = knowl('fleet', '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const report = JSON.parse(result.stdout);
    expect(Array.isArray(report.sessions)).toBe(true);
    expect(report.self).toMatchObject({ sessionId: PEER_SESSION });
    const peer = report.sessions.find((session: { sessionId: string }) => session.sessionId === PEER_SESSION);
    // Never heard from by any hook, so the store knows nothing and the folder names the repo.
    expect(peer).toMatchObject({ name: 'fleet-cli-peer-cd', repo: PEER_REPO, known: false, messageable: true });
  });

  it('narrows to one repo', () => {
    const result = knowl('fleet', '--repo', PEER_REPO);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`1 live agent session in ${PEER_REPO}`);
    expect(result.stdout).toContain('fleet-cli-peer-cd (you)');
  });
});
