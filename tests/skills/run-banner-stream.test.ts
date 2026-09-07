import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';
import { approveSkill } from '../../src/skills/trust.js';

const TEST_ROOT = path.resolve('./.knowl-banner-stream-test');

/**
 * The run banner goes to stderr, and this is the test that keeps it there.
 *
 * `runSkillPackage` has two callers, and they disagree about what stdout is. On the CLI it is the
 * operator's terminal. Under `knowl serve` it is the MCP transport: `knowl_skill_run`
 * (`src/mcp/tools.ts`) calls the same function inside a process whose stdout carries JSON-RPC
 * frames and nothing else. A banner written there is interleaved into the protocol stream, so the
 * client fails to parse the response to a call whose skill actually ran -- the worst shape of
 * failure, an action taken and reported as a transport error.
 *
 * Nothing is lost by moving it: every host surfaces a CLI subprocess's stderr, and `knowl serve`
 * already writes its own startup banner to stderr for exactly this reason.
 *
 * Asserting on the STREAM rather than on the string is the point. `tests/skills/global-layer.test.ts`
 * already covers what the banner says by calling `formatRunBanner` directly, and that test stayed
 * green through the whole period the banner was corrupting stdio -- a banner's content and its
 * destination are separate claims and only one of them was ever checked.
 */
describe('where the skill run banner is written', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await createSkillPackage(TEST_ROOT, {
      name: 'banner-probe',
      purpose: 'probe',
      files: [{ path: 'note.md', content: 'probe' }],
      entrypoints: {
        default: { type: 'shell', command: 'echo ran', autoRun: true },
      },
    });
    await approveSkill(TEST_ROOT, 'banner-probe', { approvedBy: 'test' });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the banner to stderr and puts nothing on stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      err.push(String(chunk));
      return true;
    });
    // console.log routes through process.stdout.write, so the spy above catches a regression
    // whichever of the two a future edit reaches for.
    await runSkillPackage(TEST_ROOT, 'banner-probe');

    expect(err.join('')).toContain('knowl skill run banner-probe');
    expect(out.join('')).not.toContain('knowl skill run banner-probe');
  });

  it('reaches for no stdout writer at all, console.log included', async () => {
    // This assertion exists because the obvious version of it does NOT work. Spying only on
    // `process.stdout.write` looks like it covers console.log, since that is what console.log
    // calls in a plain Node process -- but under vitest the console is intercepted before it
    // gets there, so a `console.log(banner)` regression sails past a stdout-write spy and the
    // test passes while the bug is live. Verified by mutation: with the banner restored to
    // console.log, a stdout-write-only assertion still went green. Both writers are watched
    // here so the check can actually fail.
    const out: string[] = [];
    const logged: unknown[][] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runSkillPackage(TEST_ROOT, 'banner-probe');

    expect(logged).toEqual([]);
    expect(out.join('')).toBe('');
  });
});
