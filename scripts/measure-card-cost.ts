/**
 * What the guidance card costs, and what its lines buy — measured against a real agent archive.
 *
 * The card is the one surface charged to EVERY session of every user, and until now it was the
 * only budget in this repository with no derivation. Its neighbours in `src/core/token-budget.ts`
 * each carry one inline: `MAX_ITEM_CONTENT_CHARS` has a four-row cost table over 556 real items,
 * `MAX_TITLE_CHARS` cites p50/p90/p99, `MAX_AFFECTED_PATHS` cites percentiles over 710. The
 * 2,000-character ceiling has none — `git log -S` puts it in `1a65701`, the commit that created
 * the renderers, with a bare one-line message.
 *
 * The existing accuracy harness cannot supply one. `npm run benchmark:accuracy` and the retrieval
 * suites drive `queryKnowledge()` directly, so the ranker never sees the card and a card change is
 * invisible to them. What can measure it is the same instrument `docs/evals/agent-surface.md` used
 * to refute the keyword cap: the host's own transcript archive, where the card's rules either
 * changed agent behaviour or did not.
 *
 *   npx tsx scripts/measure-card-cost.ts [--archive <dir>] [--since YYYY-MM-DD]
 *
 * `--archive` defaults to the Claude Code project archive at `~/.claude/projects`. Nothing is
 * written and no network is touched; it reads transcripts and prints a table.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  KNOWL_CLAUDE_OPERATIONAL_CARD,
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  mcpServerInstructions,
} from '../src/core/knowl-guidance.js';
import type { ProjectConfig } from '../src/core/types.js';

/** The card the model actually receives is rendered, never hard-coded, so this cannot drift. */
const CARD_CEILING = 2_000;
const CARDS: Array<[string, string]> = [
  ['claude card', KNOWL_CLAUDE_OPERATIONAL_CARD],
  ['server card', KNOWL_MCP_SERVER_INSTRUCTIONS],
  // The binding variant: it is the largest, and it is the only one no test pins exactly.
  ['server + transcripts', mcpServerInstructions({ search: { transcripts: { enabled: true } } } as unknown as ProjectConfig)],
];

// A wrong config shape makes `mcpServerInstructions` fall back to the shared constant, which
// reports the binding variant as the same size as the server card and overstates headroom
// tenfold. Fail loudly instead: the whole point of this script is the number it would get wrong.
if (CARDS[2][1] === KNOWL_MCP_SERVER_INSTRUCTIONS) {
  throw new Error('transcript-enabled card did not render; check isTranscriptSearchEnabled config shape');
}

/** The same 4-chars-per-token estimate the guidance tests budget against. */
const tok = (chars: number) => Math.ceil(chars / 4);

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const ARCHIVE = arg('--archive') ?? path.join(os.homedir(), '.claude', 'projects');
const SINCE = arg('--since') ? Date.parse(`${arg('--since')}T00:00:00Z`) : undefined;

if (!fs.existsSync(ARCHIVE)) {
  console.error(`No transcript archive at ${ARCHIVE}. Pass --archive <dir>.`);
  process.exit(1);
}

/**
 * Only transcripts that sit DIRECTLY in a project directory are main sessions.
 *
 * Everything under `<sessionId>/subagents/` is a subagent, and a probe established that the MCP
 * `instructions` block never reaches one -- which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists at
 * all. Counting them would price a card they were never sent.
 *
 * Session ids are uuids, so a filename seen twice is the same session reached by two paths. That
 * happens: a drive move can leave a whole `d--*` tree that is a byte-identical copy of `c--*`, and
 * counting both silently doubles every figure in this report.
 */
function collectSessionFiles(root: string) {
  const files: Array<{ project: string; file: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const dir of fs.readdirSync(root).sort()) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      if (seen.has(name)) { duplicates++; continue; }
      seen.add(name);
      files.push({ project: dir, file: path.join(full, name) });
    }
  }
  return { files, duplicates };
}

interface Session { project: string; calls: string[]; first: number | null; last: number | null }

async function readSession(project: string, file: string): Promise<Session> {
  const calls: string[] = [];
  let first: number | null = null;
  let last: number | null = null;
  const stream = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') calls.push(block.name);
    }
  }
  return { project, calls, first, last };
}

const isKnowlCall = (name: string) => /^mcp__[a-z_]*knowl__/.test(name);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/**
 * Rule one of the card -- query before repository files -- is the only rule whose compliance is
 * legible from a tool-call sequence alone. Sessions that never opened a file are excluded: they
 * cannot violate it, and leaving them in inflates the pass rate.
 */
function compliance(pool: Session[]) {
  let queryFirst = 0, filesFirst = 0, neverQueried = 0;
  for (const s of pool) {
    const firstRead = s.calls.findIndex(name => READ_TOOLS.has(name));
    if (firstRead === -1) continue;
    const firstQuery = s.calls.findIndex(name => isKnowlCall(name) && name.includes('query'));
    if (firstQuery === -1) neverQueried++;
    else if (firstQuery < firstRead) queryFirst++;
    else filesFirst++;
  }
  return { queryFirst, filesFirst, neverQueried, total: queryFirst + filesFirst + neverQueried };
}

const GROUPS: Array<[string, RegExp]> = [
  ['retrieval', /_(query|recent|state|context)$/],
  ['durable writes', /_(store|ingest_atoms|decide|update)$/],
  ['work loop', /_task_/],
  ['audit', /_(timeline|evidence_list|conflicts|feedback)$/],
  ['skills', /_skill_/],
  ['special', /_(ingest|synthesize|session_finish|gc_preview|gc_apply)$/],
  ['leaving work', /_(handoff|park|resume)$/],
];

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

async function main() {
  const { files, duplicates } = collectSessionFiles(ARCHIVE);
  const sessions: Session[] = [];
  for (const { project, file } of files) sessions.push(await readSession(project, file));

  // A project counts as knowl-configured when any session in it ever reached a knowl tool. This
  // undercounts projects configured but never used, so every cost figure below is conservative.
  const knowlProjects = new Set(sessions.filter(s => s.calls.some(isKnowlCall)).map(s => s.project));
  let paying = sessions.filter(s => knowlProjects.has(s.project));
  if (SINCE !== undefined) paying = paying.filter(s => s.first !== null && s.first >= SINCE);
  if (!paying.length) { console.error('No sessions matched.'); process.exit(1); }

  const used = paying.filter(s => s.calls.some(isKnowlCall)).length;
  const stamped = paying.filter(s => s.first !== null);
  const start = Math.min(...stamped.map(s => s.first as number));
  const end = Math.max(...stamped.map(s => s.last as number));
  const days = Math.max((end - start) / 86_400_000, 1);
  const perDay = paying.length / days;

  console.log('=== ARCHIVE ===');
  console.log(`archive                   ${ARCHIVE}`);
  console.log(`duplicate copies dropped  ${duplicates}`);
  console.log(`main-session transcripts  ${files.length}`);
  console.log(`sessions paying the card  ${paying.length} across ${knowlProjects.size} knowl-configured project(s)`);
  console.log(`  ...that used knowl      ${used} (${pct(used, paying.length)})`);
  console.log(`  ...that never did       ${paying.length - used} (${pct(paying.length - used, paying.length)})  <- pure overhead`);
  console.log(`span                      ${new Date(start).toISOString().slice(0, 10)} -> ${new Date(end).toISOString().slice(0, 10)} (${days.toFixed(0)} days, ${perDay.toFixed(1)}/day)`);

  console.log('\n=== WHAT THE CARD COSTS ===');
  for (const [label, card] of CARDS) {
    console.log(
      `${label.padEnd(22)}${String(card.length).padStart(6)} chars  ${String(tok(card.length)).padStart(4)} tok/session  ` +
      `${(tok(card.length) * perDay).toFixed(0).padStart(5)} tok/day  ${((tok(card.length) * perDay * 30) / 1000).toFixed(1)}k tok/month`,
    );
  }
  const binding = CARDS[CARDS.length - 1][1].length;
  console.log(`ceiling ${CARD_CEILING}, binding variant ${binding}, headroom ${CARD_CEILING - binding} chars`);
  console.log(`each additional 100 chars costs ${(tok(100) * perDay * 30 / 1000).toFixed(2)}k tok/month at this session rate`);

  console.log('\n=== DOES RULE ONE LAND? (sessions that read files) ===');
  console.log('Split on the card\'s creation date; sessions before it never saw it. Observational,');
  console.log('not an A/B -- the card, hooks and KNOWL.md shipped together, so this is the system.');
  const born = Date.parse('2026-07-21T00:00:00Z');
  const before = compliance(paying.filter(s => s.first !== null && s.first < born));
  const after = compliance(paying.filter(s => s.first !== null && s.first >= born));
  console.log('                                  before        after');
  for (const [label, key] of [['queried before first read', 'queryFirst'], ['read files first', 'filesFirst'], ['never queried', 'neverQueried']] as const) {
    const b = before.total ? `${before[key]} (${pct(before[key], before.total)})` : '-';
    const a = after.total ? `${after[key]} (${pct(after[key], after.total)})` : '-';
    console.log(`${label.padEnd(30)}${b.padStart(12)} ${a.padStart(12)}`);
  }
  console.log(`${'n'.padEnd(30)}${String(before.total).padStart(12)} ${String(after.total).padStart(12)}`);

  console.log('\n=== WHAT EACH ROUTED GROUP BUYS ===');
  console.log('Share of observed knowl calls. Low usage is not low value -- a skill read once can');
  console.log('be decisive, and the work loop reads zero exactly when its own rule is obeyed.');
  const counts = new Map(GROUPS.map(([label]) => [label, 0]));
  let total = 0;
  for (const s of paying) {
    for (const name of s.calls) {
      if (!isKnowlCall(name)) continue;
      total++;
      const hit = GROUPS.find(([, re]) => re.test(name));
      if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
    }
  }
  for (const [label, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(6)}  ${pct(count, total).padStart(6)}  ${label}`);
  }
  console.log(`${String(total).padStart(6)}          total knowl calls`);
}

main().catch(error => { console.error(error); process.exit(1); });
