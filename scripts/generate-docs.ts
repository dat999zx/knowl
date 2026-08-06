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
  edits.set(file, current.replace(pattern, `${open}\n${body}\n${close}`));
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

for (const failure of failures) console.error(`✗ ${failure}`);

if (failures.length || (check && stale)) process.exit(1);
if (check) console.log('Generated documentation regions are current, and every tool and command is documented.');
