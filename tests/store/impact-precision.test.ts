import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { indexFile, listCodeSymbols } from '../../src/code/symbol-index.js';
import { detectCertainImpact } from '../../src/session/impact.js';

/**
 * The measurement, not another feature test: what fraction of certain-tier findings are ones a
 * reader would actually have had to act on.
 *
 * Plan §9 makes ≥95% precision over ≥40 adjudicated findings the bar for this tier being allowed
 * to interrupt anyone, and records that **no published system in this space reports such a
 * number** -- STORM rejects 19–33% of writes and never evaluates whether the rejections were
 * correct; CoAgent asserts that read-set overlaps are mostly benign without measuring it. A bar
 * nobody has computed is a bar nobody can be held to, so this file computes it.
 *
 * **Adjudication is the scenario label, decided before the run.** Each case below states what a
 * reader saw, what another session then did, and whether that reader's belief was genuinely
 * invalidated -- `shouldFire`. The detector never sees the label. Precision and recall are then
 * arithmetic over the labels rather than a judgement made after looking at the output, which is
 * the failure mode that makes most self-reported precision numbers worthless.
 *
 * **Reported per locator kind, deliberately.** A symbol read compares `signature_hash`, so it is
 * blind to body edits by construction; a file read compares the content hash and therefore fires
 * on any byte. Those are different instruments and averaging them would hide the one number a
 * reader of this plan needs -- which tier is safe to let interrupt an agent. They are asserted
 * separately below and the blended figure is deliberately not the headline.
 *
 * A real git repository per case, because `indexFile` shells out to `git check-ignore`.
 */

type Scenario = {
  name: string;
  /** What the reader looked at. */
  locator: (source: string) => string;
  before: string;
  after: string;
  /** Ground truth, fixed before the run: was the reader's belief actually invalidated? */
  shouldFire: boolean;
  /** Why, in the reader's terms. Printed on failure so a wrong label is arguable, not opaque. */
  because: string;
  /**
   * A known limitation of the symbol extractor, diagnosed and quoted, NOT a relabel.
   *
   * The ground truth stays `shouldFire: true` and the case still counts as a recall miss in the
   * arithmetic below -- the number must not improve because something was hard. What this field
   * suppresses is only the per-case assertion, so a documented gap in a layer this suite does not
   * own cannot red the build. Remove the field when the extractor learns the construct.
   */
  extractorGap?: string;
};

const SOURCE = 'src/session.ts';
const symbolAt = (name: string) => (source: string) => `symbol://${source}#${name}`;
const fileAt = () => (source: string) => `file://${source}`;

const BASE = `export function createSession(user: User): Session {
  return { user };
}

export function destroySession(id: string): void {
  drop(id);
}
`;

/**
 * Cases where the reader's belief genuinely moved. Each changes something a caller of the symbol
 * they read would have to change their own code for.
 */
const INVALIDATING: Scenario[] = [
  {
    name: 'parameter added',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('createSession(user: User)', 'createSession(user: User, org: Organization)'),
    shouldFire: true,
    because: 'every existing call site is now wrong',
  },
  {
    name: 'parameter type narrowed',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('user: User', 'user: AuthenticatedUser'),
    shouldFire: true,
    because: 'a caller passing User no longer typechecks',
  },
  {
    name: 'return type changed',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('): Session {', '): Promise<Session> {'),
    shouldFire: true,
    because: 'the caller must now await it',
  },
  {
    name: 'made async',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('export function createSession', 'export async function createSession'),
    shouldFire: true,
    because: 'the caller must now await it',
  },
  {
    name: 'parameter made optional',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('user: User', 'user?: User'),
    shouldFire: true,
    because: 'the contract the reader relied on has widened',
  },
  {
    name: 'symbol deleted',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.split('export function destroySession')[1]
      ? `export function destroySession(id: string): void {\n  drop(id);\n}\n`
      : BASE,
    shouldFire: true,
    because: 'the thing the reader was building against is gone',
  },
  {
    name: 'symbol renamed',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('createSession', 'openSession'),
    shouldFire: true,
    because: 'the name the reader recorded no longer resolves',
  },
  {
    name: 'file read, and the file changed',
    locator: fileAt(),
    before: BASE,
    after: BASE.replace('user: User', 'user: User, org: Organization'),
    shouldFire: true,
    because: 'the reader holds the whole file and the contract in it moved',
  },
  {
    name: 'parameter removed',
    locator: symbolAt('destroySession'),
    before: BASE,
    after: BASE.replace('destroySession(id: string)', 'destroySession()'),
    shouldFire: true,
    because: 'callers passing an argument break',
  },
  {
    name: 'parameters reordered',
    locator: symbolAt('pair'),
    before: `export function pair(a: string, b: number): void {}\n`,
    after: `export function pair(b: number, a: string): void {}\n`,
    shouldFire: true,
    because: 'positional callers silently pass the wrong values',
  },
  {
    name: 'generic type parameter added',
    locator: symbolAt('wrap'),
    before: `export function wrap(value: string): Box {\n  return new Box(value);\n}\n`,
    after: `export function wrap<T>(value: T): Box<T> {\n  return new Box(value);\n}\n`,
    shouldFire: true,
    because: 'the type contract changed',
  },
  {
    name: 'return type widened to a union',
    locator: symbolAt('lookup'),
    before: `export function lookup(id: string): Session {\n  return get(id);\n}\n`,
    after: `export function lookup(id: string): Session | undefined {\n  return get(id);\n}\n`,
    shouldFire: true,
    because: 'the caller must now handle undefined',
  },
  {
    name: 'a class method signature changed',
    locator: symbolAt('Store.put'),
    before: `export class Store {\n  put(key: string): void {}\n  get(key: string): string {\n    return key;\n  }\n}\n`,
    after: `export class Store {\n  put(key: string, ttl: number): void {}\n  get(key: string): string {\n    return key;\n  }\n}\n`,
    shouldFire: true,
    because: 'every call site of the method is now wrong',
  },
  {
    name: 'an interface member signature changed',
    locator: symbolAt('Repo'),
    before: `export interface Repo {\n  find(id: string): Session;\n}\n`,
    after: `export interface Repo {\n  find(id: string, opts: Options): Session;\n}\n`,
    shouldFire: true,
    because: 'every implementer breaks',
  },
  {
    name: 'exported const changed type',
    locator: symbolAt('LIMIT'),
    before: `export const LIMIT: number = 10;\n`,
    after: `export const LIMIT: string = 'ten';\n`,
    shouldFire: true,
    because: 'consumers of the value break',
  },
  {
    name: 'function converted to a generator',
    locator: symbolAt('items'),
    before: `export function items(): Session[] {\n  return [];\n}\n`,
    after: `export function* items(): Generator<Session> {\n  yield* [];\n}\n`,
    shouldFire: true,
    because: 'the call protocol changed entirely',
    extractorGap: 'the extractor yields no symbol at all for `function*`, so the file registers as '
      + 'unparsed and the deletion guard correctly stays silent rather than reporting every symbol '
      + 'in it as gone. Measured directly: `items` resolves before the edit and returns null after.',
  },
  {
    name: 'export removed, symbol made module-private',
    locator: symbolAt('helper'),
    before: `export function helper(x: number): number {\n  return x;\n}\n`,
    after: `function helper(x: number): number {\n  return x;\n}\n`,
    shouldFire: true,
    because: 'importers can no longer reach it',
    extractorGap: 'the extractor strips `export` from the signature, so both versions hash '
      + 'identically. Measured directly: signature is `function helper(x: number): number` and '
      + 'hash fa96b62a before and after. Export-ness is not part of the signature it builds.',
  },
  {
    name: 'a type alias the reader read changed shape',
    locator: symbolAt('SessionId'),
    before: `export type SessionId = string;\n`,
    after: `export type SessionId = { value: string };\n`,
    shouldFire: true,
    because: 'every use of the alias must change',
  },
  {
    name: 'whole file deleted under a file reader',
    locator: fileAt(),
    before: BASE,
    after: '',
    shouldFire: true,
    because: 'the file the reader holds is empty now',
  },
  {
    name: 'second parameter type changed',
    locator: symbolAt('link'),
    before: `export function link(a: string, b: string): void {}\n`,
    after: `export function link(a: string, b: number): void {}\n`,
    shouldFire: true,
    because: 'callers passing a string in the second slot break',
  },
  {
    name: 'rest parameter introduced',
    locator: symbolAt('sum'),
    before: `export function sum(a: number, b: number): number {\n  return a + b;\n}\n`,
    after: `export function sum(...values: number[]): number {\n  return 0;\n}\n`,
    shouldFire: true,
    because: 'the arity contract changed',
  },
  {
    name: 'return type removed entirely',
    locator: symbolAt('tally'),
    before: `export function tally(x: number): number {\n  return x;\n}\n`,
    after: `export function tally(x: number) {\n  return x;\n}\n`,
    shouldFire: true,
    because: 'the declared contract the reader recorded is no longer declared',
  },
  {
    name: 'parameter renamed with type intact',
    locator: symbolAt('greet'),
    before: `export function greet(name: string): string {\n  return name;\n}\n`,
    after: `export function greet(who: string): string {\n  return who;\n}\n`,
    shouldFire: true,
    because: 'named-argument callers and the documented contract both move',
  },
  {
    name: 'a second parameter appended',
    locator: symbolAt('open'),
    before: `export function open(path: string): Handle {\n  return h(path);\n}\n`,
    after: `export function open(path: string, mode: string): Handle {\n  return h(path);\n}\n`,
    shouldFire: true,
    because: 'existing calls are now under-supplied',
  },
];

/**
 * Cases where nothing the reader relied on moved. A finding here is a false positive, and the
 * expensive kind: it spends tool-side context measured at ~20.8% mean accuracy cost, and under
 * the write gate it takes away someone's ability to save a file.
 */
const BENIGN: Scenario[] = [
  {
    name: 'a different symbol in the same file changed',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('destroySession(id: string)', 'destroySession(id: string, force: boolean)'),
    shouldFire: false,
    because: "STORM's own stated false positive: two agents in one file, different functions",
  },
  {
    name: 'comment added inside the body',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  return { user };', '  // build the session\n  return { user };'),
    shouldFire: false,
    because: 'nothing a caller depends on changed',
  },
  {
    name: 'body reformatted, signature identical',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  return { user };', '  return {\n    user,\n  };'),
    shouldFire: false,
    because: 'whitespace is not a contract change',
  },
  {
    name: 'a local variable renamed inside the body',
    locator: symbolAt('destroySession'),
    before: BASE,
    after: BASE.replace('  drop(id);', '  const target = id;\n  drop(target);'),
    shouldFire: false,
    because: 'invisible from outside the function',
  },
  {
    name: 'an unrelated symbol appended to the file',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `${BASE}\nexport function listSessions(): Session[] {\n  return [];\n}\n`,
    shouldFire: false,
    because: 'additive, and the read symbol is untouched',
  },
  {
    name: 'trailing newline added',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `${BASE}\n`,
    shouldFire: false,
    because: 'a byte changed and no meaning did',
  },
  {
    name: 'the two functions swapped order',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `export function destroySession(id: string): void {\n  drop(id);\n}\n\nexport function createSession(user: User): Session {\n  return { user };\n}\n`,
    shouldFire: false,
    because: 'adversarial: if line position leaked into the signature hash, moving code would fire',
  },
  {
    name: 'an import added at the top of the file',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `import { User } from './user.js';\n\n${BASE}`,
    shouldFire: false,
    because: 'adversarial: shifts every line below it without changing any contract',
  },
  {
    name: 'a JSDoc block added above the read symbol',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `/** Creates a session. */\n${BASE}`,
    shouldFire: false,
    because: 'documentation is not the contract',
  },
  {
    name: 'a string literal inside the body changed',
    locator: symbolAt('destroySession'),
    before: BASE.replace('  drop(id);', '  log("dropping"); drop(id);'),
    after: BASE.replace('  drop(id);', '  log("removing"); drop(id);'),
    shouldFire: false,
    because: 'internal detail',
  },
  {
    name: 'a blank line inserted between the two functions',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('}\n\nexport function destroySession', '}\n\n\nexport function destroySession'),
    shouldFire: false,
    because: 'whitespace between symbols',
  },
  {
    name: 'another symbol deleted, the read one untouched',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `export function createSession(user: User): Session {\n  return { user };\n}\n`,
    shouldFire: false,
    because: 'deletion is only invalidating for the reader of the deleted thing',
  },
  {
    name: 'a new parameter added to a sibling, read symbol untouched',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('destroySession(id: string)', 'destroySession(id: string, hard: boolean)'),
    shouldFire: false,
    because: 'the STORM false positive again, with a different edit shape',
  },
  {
    name: 'a class method body changed, its signature and the read method untouched',
    locator: symbolAt('Store.get'),
    before: `export class Store {\n  put(key: string): void {}\n  get(key: string): string {\n    return key;\n  }\n}\n`,
    after: `export class Store {\n  put(key: string): void {\n    record(key);\n  }\n  get(key: string): string {\n    return key;\n  }\n}\n`,
    shouldFire: false,
    because: 'a sibling method changed internally',
  },
  {
    name: 'a decorator-style comment added inside the body',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  return { user };', '  /* istanbul ignore next */\n  return { user };'),
    shouldFire: false,
    because: 'tooling noise, not a contract change',
  },
  {
    name: 'indentation changed throughout the body',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  return { user };', '    return { user };'),
    shouldFire: false,
    because: 'formatter output',
  },
  {
    name: 'a trailing comma added inside the returned object',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('return { user };', 'return { user, };'),
    shouldFire: false,
    because: 'style, invisible to callers',
  },
  {
    name: 'an unrelated interface added to the file',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `${BASE}\nexport interface Unrelated {\n  x: number;\n}\n`,
    shouldFire: false,
    because: 'purely additive',
  },
  {
    name: 'the reader read one class method, a different method was added',
    locator: symbolAt('Store.get'),
    before: `export class Store {\n  get(key: string): string {\n    return key;\n  }\n}\n`,
    after: `export class Store {\n  get(key: string): string {\n    return key;\n  }\n  has(key: string): boolean {\n    return true;\n  }\n}\n`,
    shouldFire: false,
    because: 'additive within a class',
  },
  {
    name: 'a sibling function body rewritten completely',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  drop(id);', '  const t = find(id);\n  if (!t) return;\n  purge(t);\n  audit(id);'),
    shouldFire: false,
    because: 'a large edit that still touches nothing the reader recorded',
  },
  {
    name: 'a return value reformatted across lines',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('  return { user };', '  return {\n    user\n  };'),
    shouldFire: false,
    because: 'the signature line is untouched',
  },
  {
    name: 'a trailing comment appended to the file',
    locator: symbolAt('createSession'),
    before: BASE,
    after: `${BASE}\n// end of file\n`,
    shouldFire: false,
    because: 'outside every symbol',
  },
  {
    name: 'semicolons removed from the body',
    locator: symbolAt('destroySession'),
    before: BASE,
    after: BASE.replace('  drop(id);', '  drop(id)'),
    shouldFire: false,
    because: 'style change inside the body',
  },
  {
    name: 'a sibling renamed, the read symbol untouched',
    locator: symbolAt('createSession'),
    before: BASE,
    after: BASE.replace('destroySession', 'closeSession'),
    shouldFire: false,
    because: 'a deletion the reader never read is not the reader’s problem',
  },
  {
    name: 'the file gained a licence header',
    locator: symbolAt('destroySession'),
    before: BASE,
    after: `// Copyright 2026\n// SPDX-License-Identifier: MIT\n\n${BASE}`,
    shouldFire: false,
    because: 'adversarial: shifts every symbol down two lines',
  },
];

let testRoot = '';
let testIndex = 0;

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
}

async function write(relativePath: string, contents: string): Promise<void> {
  const full = path.join(testRoot, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
}

async function observedHashFor(locator: string, relativePath: string): Promise<string | null> {
  if (locator.startsWith('file://')) {
    return crypto.createHash('sha256').update(await fs.readFile(path.join(testRoot, relativePath))).digest('hex');
  }
  const name = locator.slice(locator.indexOf('#') + 1);
  const symbols = await listCodeSymbols(relativePath);
  return symbols.find(symbol => symbol.qualifiedName === name)?.signatureHash ?? null;
}

/**
 * One scenario, end to end: the reader reads, another session writes, the detector runs.
 *
 * `causeSession` is a different session id throughout -- self-exclusion is correct behaviour and
 * is tested elsewhere, so mixing it in here would suppress findings for a reason that has nothing
 * to do with whether the change mattered, and inflate precision by removing the hard cases.
 */
async function runScenario(scenario: Scenario): Promise<{ fired: boolean; skipped: boolean }> {
  await write(SOURCE, scenario.before);
  git(testRoot, 'add', '-A');
  git(testRoot, 'commit', '-qm', 'before');
  await indexFile(testRoot, SOURCE);

  const locator = scenario.locator(SOURCE);
  const observedHash = await observedHashFor(locator, SOURCE);
  // A symbol the indexer does not resolve is not a detector result either way. Counting it as a
  // miss would blame the tier for the language support underneath it.
  if (!observedHash) return { fired: false, skipped: true };

  await getClient().execute({
    sql: `INSERT INTO work_read_sets (id, session_id, agent_id, locator, observed_hash, tool_name, read_at, released_at)
          VALUES (?, 'reader-session', NULL, ?, ?, 'Read', ?, NULL)`,
    args: [`read-${testIndex}`, locator, observedHash, new Date().toISOString()],
  });

  await write(SOURCE, scenario.after);
  const findings = await detectCertainImpact(testRoot, [SOURCE], 'writer-session');
  return { fired: findings.length > 0, skipped: false };
}

beforeEach(async () => {
  testRoot = path.join(os.tmpdir(), `knowl-impact-precision-${testIndex++}`);
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(testRoot, '.knowl'), { recursive: true });
  git(testRoot, 'init', '-q', '.');
  git(testRoot, 'config', 'user.email', 'precision@example.test');
  git(testRoot, 'config', 'user.name', 'precision');
  await write('.gitignore', '.knowl/\n');
  await initDb(testRoot);
});

afterEach(async () => {
  await closeDb();
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
});

describe('certain-tier precision, measured', () => {
  const results: { scenario: Scenario; fired: boolean; skipped: boolean }[] = [];

  for (const scenario of [...INVALIDATING, ...BENIGN]) {
    it(`${scenario.shouldFire ? 'fires' : 'stays silent'}: ${scenario.name}`, async () => {
      const outcome = await runScenario(scenario);
      results.push({ scenario, ...outcome });

      if (outcome.skipped) return;
      if (scenario.extractorGap) {
        // Asserted the other way round on purpose: if the extractor learns the construct, this
        // fails and sends someone here to delete the field and take the recall back. A documented
        // gap that silently heals is a comment nobody ever removes.
        expect(outcome.fired, `${scenario.name} now fires -- remove extractorGap`).toBe(false);
        return;
      }
      expect(
        outcome.fired,
        `${scenario.name}\n  expected ${scenario.shouldFire ? 'a finding' : 'silence'}\n  because: ${scenario.because}`,
      ).toBe(scenario.shouldFire);
    });
  }

  it('reports the numbers plan §9 asks for, split by locator kind', () => {
    const scored = results.filter(entry => !entry.skipped);
    const of = (kind: 'symbol' | 'file') =>
      scored.filter(entry => entry.scenario.locator(SOURCE).startsWith(`${kind}://`));

    const stats = (set: typeof scored) => {
      const tp = set.filter(e => e.scenario.shouldFire && e.fired).length;
      const fp = set.filter(e => !e.scenario.shouldFire && e.fired).length;
      const fn = set.filter(e => e.scenario.shouldFire && !e.fired).length;
      return {
        tp, fp, fn,
        precision: tp + fp === 0 ? 1 : tp / (tp + fp),
        recall: tp + fn === 0 ? 1 : tp / (tp + fn),
      };
    };

    const symbol = stats(of('symbol'));
    const file = stats(of('file'));
    const all = stats(scored);
    const gaps = scored.filter(e => e.scenario.extractorGap);

    // Printed rather than only asserted: this is the number the plan says nobody publishes, and a
    // number that only exists inside a passing assertion is one nobody can quote.
    console.log(
      `\n  certain-tier measurement over ${scored.length} adjudicated scenarios` +
      `\n    symbol locators: precision ${(symbol.precision * 100).toFixed(1)}%  recall ${(symbol.recall * 100).toFixed(1)}%  (tp ${symbol.tp} fp ${symbol.fp} fn ${symbol.fn})` +
      `\n    file locators:   precision ${(file.precision * 100).toFixed(1)}%  recall ${(file.recall * 100).toFixed(1)}%  (tp ${file.tp} fp ${file.fp} fn ${file.fn})` +
      `\n    blended:         precision ${(all.precision * 100).toFixed(1)}%  recall ${(all.recall * 100).toFixed(1)}%` +
      `\n    recall misses attributable to the symbol extractor, not the detector: ${gaps.length}` +
      gaps.map(e => `\n      - ${e.scenario.name}: ${e.scenario.extractorGap}`).join('') + '\n',
    );

    // The bar plan §9 states is "≥40 adjudicated findings". Asserted so the number cannot quietly
    // be quoted off a sample too small to support it.
    expect(scored.length).toBeGreaterThanOrEqual(40);

    // The gate's own bar. Symbol locators are the tier allowed to refuse a write, so this is the
    // assertion that would have to be argued with before the gate ships on by default.
    expect(symbol.precision).toBeGreaterThanOrEqual(0.95);
    // Recall is deliberately NOT held to a bar: the tier is allowed to be incomplete, and the
    // asymmetry is the whole design -- a missed detection costs one advisory notice, a false one
    // costs a refused write.
    expect(symbol.recall).toBeGreaterThan(0);
  });
});
