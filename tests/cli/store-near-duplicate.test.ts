import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `knowl store` printed what it retired and never what it left active beside the write. The
 * result always carried `nearDuplicate`; the CLI dropped it, so a write whose `--supersedes` target
 * outranked a same-subject match said "Retired X" and nothing about the match still standing.
 * Driven through the built CLI because the line under test is the command's own output.
 */
const CLI = path.resolve('./dist/index.js');
let cwd = '';
const run = (args: string[]): string =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input: '' });

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-store-near-'));
  run(['init', '--yes']);
});
afterAll(async () => { await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); });

describe('knowl store', () => {
  it('names the overlapping item it left active', () => {
    const first = run(['store', 'The API throttles clients with a token bucket of 100 requests per minute.',
      '--title', 'Rate limiter buckets', '--category', 'fact']);
    const firstId = /Stored fact (\S+):/.exec(first)![1];

    const second = run(['store', 'The API throttles clients and returns Retry-After on a token bucket rejection.',
      '--title', 'Throttling headers returned to clients', '--category', 'fact']);

    expect(second).toContain('Left active beside');
    expect(second).toContain(firstId);
  }, 120_000);
});
