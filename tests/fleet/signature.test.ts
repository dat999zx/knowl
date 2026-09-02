import { describe, expect, it } from 'vitest';
import { errorHeadLine, errorSignature, normalizeErrorLine, sameErrorHead } from '../../src/fleet/signature.js';

const vitestRun = `
 RUN  v3.2.4 C:/Code/knowl-wt-peers

 ✓ tests/store/one.test.ts (3 tests) 120ms
 ❯ tests/store/session-directory.test.ts (4 tests | 1 failed) 27412ms
   × lists sessions under load
     → SQLITE_BUSY: database is locked (C:\\Code\\knowl-wt-peers\\.knowl\\knowl.db)

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 6 passed (7)
   Start at  16:41:02
   Duration  28.11s
`;

describe('normalizeErrorLine', () => {
  it('replaces the session-specific tokens with placeholders and lowercases', () => {
    expect(normalizeErrorLine('Error: ENOENT: no such file, open \'C:\\Users\\Admin\\x\\y.ts:12:5\' at 2026-09-02T16:41:02.123Z (pid 44084)'))
      .toBe('error: enoent: no such file, open \'<path>:<n>:<n>\' at <time> (pid <n>)');
  });

  it('strips ANSI colour codes', () => {
    expect(normalizeErrorLine('\u001b[31mFAIL\u001b[0m expected 3 to be 4')).toBe('fail expected <n> to be <n>');
  });
});

describe('errorHeadLine', () => {
  it('picks the line that names the failure from the tail of a test run, not the runner banner', () => {
    expect(errorHeadLine(vitestRun)).toBe('→ SQLITE_BUSY: database is locked (C:\\Code\\knowl-wt-peers\\.knowl\\knowl.db)');
  });

  it('falls back to the last non-noise line, then the last line', () => {
    expect(errorHeadLine('building…\nat foo (x.js:1:1)\nsomething odd happened')).toBe('something odd happened');
    expect(errorHeadLine('at foo (x.js:1:1)')).toBe('at foo (x.js:1:1)');
    expect(errorHeadLine('')).toBe('');
  });
});

describe('errorSignature', () => {
  it('is identical for the same failure seen from two worktrees', () => {
    const a = errorSignature(vitestRun);
    const b = errorSignature(vitestRun.replace(/knowl-wt-peers/g, 'knowl-wt-other').replace('27412ms', '31002ms'));
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    expect(a!.head).toBe('→ sqlite_busy: database is locked (<path>)');
    expect(a!.sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for a different failure', () => {
    const a = errorSignature('Error: SQLITE_BUSY: database is locked');
    const b = errorSignature('TypeError: Cannot read properties of undefined (reading "rows")');
    expect(a!.sig).not.toBe(b!.sig);
  });

  it('refuses text too short to mean anything', () => {
    expect(errorSignature('ok')).toBeUndefined();
    expect(errorSignature('   ')).toBeUndefined();
  });
});

describe('sameErrorHead', () => {
  it('joins the same failure phrased two ways and keeps different assertions apart', () => {
    expect(sameErrorHead('sqlite_busy: database is locked (<path>)', 'error: sqlite_busy: database is locked (<path>)')).toBe(true);
    expect(sameErrorHead('expected <n> to be <n>', 'expected undefined to be defined')).toBe(false);
    expect(sameErrorHead('', 'x')).toBe(false);
  });
});
