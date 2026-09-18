import { describe, expect, it } from 'vitest';
import { normalizeConflictKey } from '../../src/store/conflicts.js';
import { errorHeadLine } from '../../src/fleet/signature.js';
import { coversAffectedPath } from '../../integrations/openclaw/src/index.js';
import { validateKnowledgeWrite } from '../../src/core/knowledge-validation.js';

/**
 * Four patterns lost an unbounded quantifier to close `js/polynomial-redos`. Each rewrite is
 * supposed to be behaviour-preserving on the input that actually occurs, and "supposed to be" is
 * exactly the claim a bound is easiest to get wrong about -- `\.+` to `\.` strips one character
 * where it used to strip a run, and `\s*` to `\s{0,8}` stops matching at the ninth space.
 *
 * So each case here is one the old pattern handled, pinned so a future tightening cannot quietly
 * narrow it further. The timing assertion at the end is the other half: it fails on the input the
 * unbounded versions choked on.
 */
describe('regex bounds introduced for polynomial-redos', () => {
  it('still collapses and trims a run of separators into one dot', () => {
    // The `+` removed from `^\.+|\.+$` was unreachable: the greedy `[^a-z0-9]+` before it has
    // already turned any run into a single dot. These are the inputs that would prove otherwise.
    expect(normalizeConflictKey('!!!Database Production!!!')).toBe('database.production');
    expect(normalizeConflictKey('   ...engine...   ')).toBe('engine');
    expect(normalizeConflictKey('---')).toBe('');
    expect(normalizeConflictKey('Database Production Engine')).toBe('database.production.engine');
  });

  it('still rejects runner noise and summary lines when picking the error', () => {
    const output = [
      'PASS tests/a.test.ts',
      '    at Object.<anonymous> (tests/b.test.ts:3:1)',
      'TypeError: cannot read properties of undefined',
      'Test Files  1 failed | 2 passed',
      'Tests  3 failed | 40 passed',
    ].join('\n');
    expect(errorHeadLine(output)).toBe('TypeError: cannot read properties of undefined');
  });

  it('still treats a directory entry with trailing slashes as covering what is under it', () => {
    expect(coversAffectedPath(['src/store/'], 'src/store/repository.ts')).toBe(true);
    expect(coversAffectedPath(['src/store///'], 'src/store/repository.ts')).toBe(true);
    expect(coversAffectedPath(['src/store'], 'src/cloud/api-client.ts')).toBe(false);
  });

  it('still refuses a named secret written with spaces around the separator', () => {
    for (const spacing of ['api_key=', 'api_key = ', 'api_key   :   ', 'Bearer ']) {
      expect(() => validateKnowledgeWrite({ content: `The deploy step uses ${spacing}A1b2C3d4E5f6G7h8i9` }), spacing)
        .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_SECRET_TOKEN' }));
    }
  });

  it('scans a 49 KB run of whitespace in the raw output without backtracking', () => {
    // The one bound with a measured cost behind it. `NAMED_SECRET` had `\s*` on both sides of an
    // optional separator, which is quadratic in the length of the whitespace run: 5.1 s on this
    // input before the change, under a millisecond after. Every write runs this predicate, and
    // `rawOutput` -- raw agent output, the least trusted field there is -- may carry 50 KB.
    //
    // The other three rewrites in this file are bounded for the same reason but do not measurably
    // backtrack on V8, so they are pinned by behaviour above rather than by a timing number that
    // would pass either way.
    const started = performance.now();
    validateKnowledgeWrite({ content: 'api_key', rawOutput: ' '.repeat(49_000) });
    validateKnowledgeWrite({ content: `api_key${' '.repeat(19_000)}` });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
