import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The cloud group must fail by setting `process.exitCode`, never by calling `process.exit`.
 *
 * A cloud verb can have loaded the embedder before it fails, and exiting there tears the process
 * down while the runtime's async handle is mid-close. libuv aborts (`UV_HANDLE_CLOSING`) and the
 * abort wins the race, so the shell sees 127 instead of 1 — a code that conventionally means
 * "command not found", sending whoever debugs it to their PATH rather than to the refusal they
 * were actually given.
 *
 * Source assertions rather than behavioural ones. Reproducing this needs a real embedder, a real
 * server and a mismatched workspace, and it only manifests on Windows; a suite that could catch
 * it is a suite that cannot run in CI. What is checkable everywhere is the shape of the code.
 */
const SOURCE = readFileSync(new URL('../../src/cli/program.ts', import.meta.url), 'utf8');
const LINES = SOURCE.split('\n');

const START = LINES.findIndex(line => line.startsWith('const cloudCommand = program.command'));
const END = LINES.findIndex(line => line.startsWith('const workspaceCommand = program.command'));
const CLOUD = LINES.slice(START, END);

describe('the cloud command group never calls process.exit', () => {
  it('finds the group at all, so a rename cannot make this suite vacuous', () => {
    // Without this the slice above could silently become empty and every assertion below would
    // pass by describing nothing.
    expect(START).toBeGreaterThan(-1);
    expect(END).toBeGreaterThan(START);
    expect(CLOUD.length).toBeGreaterThan(200);
  });

  it('has no process.exit call left in it', () => {
    const offenders = CLOUD
      .map((line, index) => ({ line, at: START + index + 1 }))
      .filter(entry => /^\s*process\.exit\(/.test(entry.line));

    expect(
      offenders.map(entry => `${entry.at}: ${entry.line.trim()}`),
      'A cloud path calls process.exit again. On a path that has loaded the embedder that aborts '
      + 'with UV_HANDLE_CLOSING and reports 127 instead of 1. Set process.exitCode and return.',
    ).toEqual([]);
  });

  /**
   * The half that is easy to lose. `process.exit` stopped the command as a side effect and
   * `exitCode` does not, so every one of these guards has live code after it. A conversion that
   * forgets the return carries on past a refusal — connecting after saying it would not, pushing
   * after saying it could not — which is a worse bug than the exit code it set out to fix.
   */
  it('follows every exitCode assignment with a return', () => {
    const unguarded: string[] = [];
    CLOUD.forEach((line, index) => {
      if (!/^\s*process\.exitCode = 1;\s*$/.test(line)) return;
      const next = CLOUD[index + 1] ?? '';
      if (!/^\s*return;\s*$/.test(next)) {
        unguarded.push(`${START + index + 1}: ${line.trim()} -> ${next.trim() || '(end)'}`);
      }
    });

    expect(
      unguarded,
      'process.exitCode was set without returning. Unlike process.exit it does not stop the '
      + 'command, so execution continues past the refusal.',
    ).toEqual([]);
  });

  it('still actually reports failure somewhere, rather than having dropped the code entirely', () => {
    // The lazy way to make the two assertions above pass is to delete the failure handling. This
    // is the counterweight: the group refuses in many places and each one must still say so.
    const assignments = CLOUD.filter(line => /process\.exitCode = 1;/.test(line));
    expect(assignments.length).toBeGreaterThan(20);
  });
});
