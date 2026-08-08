/**
 * Keep the documentation that restates something the code knows from drifting away from it.
 *
 * `npm run docs:generate` rewrites the generated regions; `npm run docs:check` fails if they
 * are stale or if a tool or command exists that nothing documents.
 *
 * Two mechanisms, deliberately, because the docs are not all the same kind of thing:
 *
 * - GENERATED regions are pure data -- a count, a table of model ids and sizes. There is no
 *   craft in them, they were wrong at 2.17.0 and still wrong at 3.0.0, and a machine writes
 *   them better than a person remembers to.
 * - CHECKED lists are curated prose. `docs/reference.md` describes `knowl_query` as "Focused
 *   retrieval before files and before each new subtask or project area", which is better than
 *   the first sentence of its MCP description and much better than `knowl --help` output.
 *   Generating those would trade accurate documentation for merely current documentation. So
 *   the check asserts COVERAGE -- every tool and every command is documented somewhere -- and
 *   leaves the wording to whoever wrote it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS } from '../src/mcp/tool-definitions.js';
import { DEFAULT_PRESET_ID, VECTOR_PRESETS } from '../src/core/vector-profile.js';
import { stripManagedKnowlGuidance } from '../src/core/agents-guidance.js';
import { renderManagedKnowlGuidanceSection } from '../src/core/knowl-guidance.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');

const README = path.join(root, 'README.md');
const REFERENCE = path.join(root, 'docs', 'reference.md');

function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${tokens / 1024}k` : String(tokens);
}

/** Region id -> [file, body]. */
const regions: Record<string, [string, string]> = {
  'tool-count': [README, [
    `**${CORE_TOOL_DEFINITIONS.length} MCP tools** (plus ${TRANSCRIPT_TOOL_DEFINITIONS.length} more when transcript search is on)`,
  ].join('\n')],

  'embedding-presets': [REFERENCE, [
    '| Preset | Model | Size (q8) | Context | Languages |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(VECTOR_PRESETS).map(([id, preset]) =>
      `| \`${id}\`${id === DEFAULT_PRESET_ID ? ' *(default)*' : ''} | \`${preset.model}\` | ~${preset.sizeMb}MB | ${contextLabel(preset.contextTokens)} | ${preset.languages} |`),
    '| `custom` | whatever you name | varies | varies | varies |',
  ].join('\n')],
};

const failures: string[] = [];
const edits = new Map<string, string>();

for (const [id, [file, body]] of Object.entries(regions)) {
  const open = `<!-- generated:${id} -->`;
  const close = `<!-- /generated:${id} -->`;
  const current = edits.get(file) ?? fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`${open}[\\s\\S]*?${close}`);
  if (!pattern.test(current)) throw new Error(`${path.basename(file)} is missing the ${open} region.`);
  // Match the file's own line endings. A checkout with core.autocrlf holds CRLF, so injecting an
  // LF-joined block leaves the file mixed and makes the staleness comparison below differ on every
  // run -- reporting stale docs on Windows no matter what the content actually says.
  // The replacement is a function so a `$` in the generated body is never read as `$&` or `$1`.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const block = `${open}\n${body}\n${close}`.replaceAll('\n', eol);
  edits.set(file, current.replace(pattern, () => block));
}

/**
 * Coverage, not wording: does anything document this tool at all?
 *
 * The failure this catches is a tool shipped and never written down, which is exactly what
 * happened three times before the counts were reconciled by hand.
 */
const referenceText = fs.readFileSync(REFERENCE, 'utf8');
for (const tool of [...CORE_TOOL_DEFINITIONS, ...TRANSCRIPT_TOOL_DEFINITIONS]) {
  if (!referenceText.includes(`\`${tool.name}\``)) {
    failures.push(`docs/reference.md documents no tool named ${tool.name}`);
  }
}

/** Same rule for the CLI. Built output only -- the help text is what a user actually sees. */
const distEntry = path.join(root, 'dist', 'index.js');
if (fs.existsSync(distEntry)) {
  const help = execFileSync(process.execPath, [distEntry, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const marker = help.indexOf('Commands:');
  if (marker === -1) throw new Error('Could not find a "Commands:" section in `knowl --help`.');
  // Commander indents a command name by exactly two spaces and wraps its description far to
  // the right. Matching on `trim()` would read every wrapped word as a command -- it did, and
  // asked the reference to document "knowl the".
  const commands = help.slice(marker + 'Commands:'.length)
    .split('\n')
    .map(line => /^ {2}(\S+)/.exec(line)?.[1] ?? '')
    .map(name => name.split(/[|[<]/)[0])
    .filter(name => /^[a-z][a-z-]+$/.test(name));
  for (const command of new Set(commands)) {
    if (command === 'help') continue;
    if (!referenceText.includes(`knowl ${command}`)) {
      failures.push(`docs/reference.md documents no command named "knowl ${command}"`);
    }
  }
} else {
  console.warn('dist/index.js not built; skipped the CLI coverage check.');
}

let stale = false;
for (const [file, next] of edits) {
  const current = fs.readFileSync(file, 'utf8');
  if (current === next) continue;
  stale = true;
  if (!check) fs.writeFileSync(file, next);
}

// Reported after the write, not before it. The generated regions are mechanical and always
// safe to update; a coverage failure needs a person to write a sentence. Exiting first would
// have left the mechanical half undone for a reason unrelated to it.
if (check && stale) {
  console.error('Generated documentation regions are stale. Run: npm run docs:generate');
} else if (!check) {
  console.log(stale ? 'Generated documentation regions updated.' : 'Generated documentation regions already current.');
}

/**
 * This repository's own KNOWL.md and AGENTS.md, against the guidance they are generated from.
 *
 * Both files are written by `installKnowlProjectGuidance` from `renderManagedKnowlGuidanceSection`,
 * and nothing verified them — the region check above covers README.md and docs/reference.md only.
 * The gap is not theoretical: on 2026-08-08 it let two separate stale-guidance commits through in
 * one day. One was a `knowl` command run against a stale `dist/`, which rewrote both files from an
 * older build and silently reverted bullets that had just landed; the other was a change that
 * edited KNOWL.md and left AGENTS.md behind, with `docs:check` reporting "regions are current"
 * while the two files disagreed with each other and with the source.
 *
 * Checked from `src/`, never from `dist/`, which is the whole point: a stale build is exactly the
 * failure being caught, so trusting the build to detect it would close the loop on itself.
 *
 * `installKnowlProjectGuidance` is deliberately NOT reused here even though it composes the same
 * text. It writes LF unconditionally, which is right for a user's project and wrong for this one:
 * a checkout with `core.autocrlf` holds CRLF, so it rewrites every line of both files on every
 * run and reports drift that git cannot see. Same trap the region writer above documents, so the
 * comparison normalises and the write matches the file's own endings.
 */
const managedGuidance = renderManagedKnowlGuidanceSection();
let guidanceStale = false;
for (const name of ['KNOWL.md', 'AGENTS.md']) {
  const file = path.join(root, name);
  const current = fs.readFileSync(file, 'utf8');
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const unmanaged = stripManagedKnowlGuidance(current.replaceAll('\r\n', '\n')).trimEnd();
  const expected = (unmanaged.length > 0 ? `${unmanaged}\n\n${managedGuidance}` : managedGuidance)
    .replaceAll('\n', eol);
  if (expected === current) continue;
  guidanceStale = true;
  if (!check) fs.writeFileSync(file, expected);
}

if (check && guidanceStale) {
  failures.push(
    'KNOWL.md / AGENTS.md do not match src/core/knowl-guidance.ts. '
    + 'Run: npm run docs:generate (a knowl command run against a stale dist/ is the usual cause)',
  );
} else if (!check) {
  console.log(guidanceStale
    ? 'Project guidance rewritten from src/core/knowl-guidance.ts.'
    : 'Project guidance already matches src/core/knowl-guidance.ts.');
}

for (const failure of failures) console.error(`✗ ${failure}`);

if (failures.length || (check && stale)) process.exit(1);
if (check) console.log('Generated documentation regions are current, and every tool and command is documented.');
