import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEWER_HTML } from '../../src/viewer/ui.js';

const SOURCE = path.resolve('src/viewer/ui.ts');

/**
 * `src/viewer/ui.ts` is one template literal holding a whole page of client JS, so a stray
 * backtick ends the string and a stray dollar-brace interpolates at BUILD time. It has broken
 * four times.
 *
 * `tsc --noEmit` only half-covers it, which is why this file exists. Measured:
 *
 *   var x = 'a`b';          -> caught (TS1005/TS1002/TS1161)
 *   var re = /a${b}/;       -> caught (TS2304, no such name)
 *   var t = "${n.title}";   -> caught (TS2304, no such name)
 *   var s = "cost: ${1}";   -> NOT CAUGHT. Compiles, lints, passes every other test, and
 *                              silently ships "cost: 1" to the browser.
 *
 * Any self-contained expression, or any name that happens to exist at module scope, slips
 * through the compiler. Counting the delimiters is the only sufficient check.
 */
describe('viewer template literal integrity', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');

  it('contains exactly two backticks: the delimiters of VIEWER_HTML itself', () => {
    const count = (source.match(/`/g) ?? []).length;
    expect(count, 'a backtick inside the client code ends the template early').toBe(2);
  });

  it('contains no dollar-brace anywhere, which would interpolate at build time', () => {
    // Built from parts so this assertion cannot itself trip the rule it enforces.
    const needle = '$' + '{';
    expect(source.includes(needle), 'use string concatenation in the client code').toBe(false);
  });

  it('serves a document that still opens and closes', () => {
    expect(VIEWER_HTML.startsWith('<!doctype html>')).toBe(true);
    expect(VIEWER_HTML.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('leaves no unsubstituted placeholder in the served page', () => {
    // If a dollar-brace ever did survive to the output, it means the build interpolated
    // something; if it appears literally, the page is shipping template syntax as text.
    expect(VIEWER_HTML).not.toContain('$' + '{');
  });

  /**
   * The one check that runs the client code through a parser. Everything above proves the
   * template is well-formed; none of it proves the ~2,000 lines of JS inside it are. A syntax
   * error there ships a page whose script never executes -- a blank canvas and an empty rail --
   * while `tsc`, eslint and every other test in this suite stay green, because to all of them
   * that JS is the inside of a string.
   *
   * `new Function` parses without executing, which is the whole point: there is no DOM here.
   * Parsed from VIEWER_HTML rather than from the source file, because unicode escapes are
   * resolved by the template literal on the way out, and the raw source is not the program the
   * browser receives.
   */
  it('ships client JS that actually parses', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(VIEWER_HTML)?.[1];
    expect(script, 'the served page has no inline script at all').toBeTruthy();
    expect(() => new Function(script as string)).not.toThrow();
  });
});
