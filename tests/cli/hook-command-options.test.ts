import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMINDER_HOSTS } from '../../src/cli/agents/hook-failure.js';

/**
 * The two hook commands' arguments and their failure channel.
 *
 * These are the only two commands `src/index.ts` dispatches past commander, for the startup cost
 * reason that module states. The consequence nobody had drawn: commander therefore never enforces
 * their `<host>` argument, never parses their `--json` flag and never runs their action's own
 * try/catch. So `knowl agent-reminder` with no host died on `hostLabel(undefined)` with
 * `TypeError: Cannot read properties of undefined (reading 'charAt')` and a stack trace through
 * the bundle -- inside a host's prompt hook, which is somebody's editor session -- and `--json`,
 * which `hook-config.ts` writes into every generated config, reached no code at all.
 *
 * Driven through the built CLI, because the argument handling under test IS the entry's argv
 * parsing. Reading the child's real streams also sidesteps the trap that a `process.stdout.write`
 * spy does not see `console.log` under vitest, so a stream assertion made that way passes against
 * its own mutant.
 */

const CLI = path.resolve('./dist/index.js');
let cwd = '';

type Run = { stdout: string; stderr: string; code: number };

// `input` is passed on every call, always: these commands read a lifecycle payload from stdin, so
// a child left with an open stdin waits for a hook that is never coming and the test times out
// instead of failing.
const run = (args: string[], input = ''): Run => {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input });
    return { stdout, stderr: '', code: 0 };
  } catch (error: any) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.status ?? 1 };
  }
};

beforeAll(async () => { cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-hook-options-')); });
afterAll(async () => { await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); });

describe('agent-reminder without a usable host', () => {
  it('says what is wrong instead of throwing a stack trace', () => {
    const { stderr, code } = run(['agent-reminder']);

    expect(code).toBe(1);
    // The defect's exact signature, asserted as an absence: an uncaught TypeError also exits 1,
    // so the exit code alone cannot tell the two apart.
    expect(stderr).not.toContain('TypeError');
    expect(stderr).not.toContain('charAt');
    expect(stderr).toContain('agent-reminder requires a host argument');
  });

  it('names the hosts that can actually receive a card', () => {
    const { stderr } = run(['agent-reminder', 'cursor']);

    // cursor is a real hook host with no prompt event, which is the mistake worth explaining.
    expect(stderr).toContain('"cursor" does not declare a prompt event');
    // Including the two the command's own help text omitted while they emitted real cards.
    for (const host of ['hermes', 'openclaw']) expect(stderr).toContain(host);
    expect(REMINDER_HOSTS).toEqual(expect.arrayContaining(['hermes', 'openclaw']));
  });

  it('writes a parseable envelope to stdout under --json, and nothing without it', () => {
    // A hook configured with --json parses stdout. Failure used to leave it empty, so the host
    // got `JSON.parse('')` on top of whatever went wrong.
    const plain = run(['agent-reminder']);
    expect(plain.stdout).toBe('');

    const json = run(['agent-reminder', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { message: expect.stringContaining('host argument') } });
  });
});

describe('the hook commands parse their own argv', () => {
  it('does not mistake a leading flag for the host', () => {
    // `hook-config.ts` writes `agent-reminder <host> --json`, so positional argv[3] happened to
    // be the host. Written the other way round it was "--json".
    const { stdout, code } = run(['agent-reminder', '--json', 'claude']);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  });

  it('reports an agent-hook failure as JSON too', () => {
    // An unsupported host, which is a genuine fault. A missing payload and an unresolvable
    // project are the two conditions `runAgentHook` deliberately swallows, so neither would
    // exercise the failure channel.
    const { stdout, stderr } = run(
      ['agent-hook', 'notahost', 'SessionStart', '--json'],
      JSON.stringify({ session_id: 'x', cwd }),
    );

    expect(stderr).toContain('Unsupported hook host');
    expect(JSON.parse(stdout)).toMatchObject({ error: { message: expect.stringContaining('Unsupported hook host') } });
  });
});

describe('numeric options that bound real work', () => {
  it('refuses a --budget that is not a number', () => {
    // NaN minutes becomes `Date.now() + NaN`, and `Date.now() >= NaN` is false forever -- on
    // `transcripts extract` that is the flag bounding a paid model, so it ran unbounded.
    for (const args of [['transcripts', 'extract'], ['reindex', '--transcripts']]) {
      const { stderr, code } = run([...args, '--budget', 'abc']);
      expect(code).not.toBe(0);
      expect(stderr).toContain('--budget must be a number greater than 0');
    }
  });

  it('still accepts a fractional budget, which is what minutes are', () => {
    const { stderr } = run(['reindex', '--transcripts', '--budget', '0.5']);

    // It fails later for its own reason -- transcript search is off in a fresh directory -- but
    // it gets past the coercion, which is what this asserts.
    expect(stderr).not.toContain('--budget');
  });

  it('refuses an --expires-in that is not a number', () => {
    run(['init', '--yes']);
    // A real item, so selection succeeds and the coercion is the next thing the command reaches.
    run(['store', 'The deploy runs from the release branch', '--title', 'Deploy branch', '--category', 'fact']);
    const { stderr } = run(['cloud', 'send', '--query', 'deploy release branch', '--expires-in', 'abc', '--yes']);

    expect(stderr).toContain('--expires-in must be a number >= 1');
  });
});
