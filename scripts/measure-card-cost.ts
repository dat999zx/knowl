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
 *   npx tsx scripts/measure-card-cost.ts [--archive <dir>] [--since YYYY-MM-DD] [--all]
 *
 * `--archive` defaults to the Claude Code project archive at `~/.claude/projects`. Nothing is
 * written and no network is touched; it reads transcripts and prints a table.
 *
 * EVERY MEASURED NUMBER IS RENDERED OR COUNTED HERE, NEVER TRANSCRIBED. Card sizes come from
 * `knowl-guidance.ts` and the `tools/list` payload it is compared against comes from
 * `knowlToolDefinitions`, because the first version of this script hard-coded that comparison and
 * it was already stale by a third when someone checked.
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
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { knowlToolDefinitions } from '../src/mcp/tools.js';
import type { ProjectConfig } from '../src/core/types.js';

const CARD_CEILING = 2_000;

/**
 * When the card began being sent. Everything before this paid nothing for it, so a rate averaged
 * across it is not the rate anybody is charged -- see `--all`.
 */
const CARD_BORN_ISO = '2026-07-21';
const CARD_BORN = Date.parse(`${CARD_BORN_ISO}T00:00:00Z`);

/** Built from the real default rather than cast from a literal, so a renamed field fails to compile. */
const transcriptsEnabled: ProjectConfig = {
  ...DEFAULT_CONFIG,
  search: { ...DEFAULT_CONFIG.search, transcripts: { ...DEFAULT_CONFIG.search?.transcripts, enabled: true } },
};

/** The same 4-chars-per-token estimate the guidance tests budget against. */
const tok = (chars: number) => Math.ceil(chars / 4);

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  // Without this, `--archive --since X` silently sets the archive to the literal '--since', and a
  // trailing `--archive` falls back to the default while looking like it was honoured.
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

interface DuplicateGroup { name: string; kept: string; dropped: string[]; diverged: boolean }

/**
 * Only transcripts that sit DIRECTLY in a project directory are main sessions.
 *
 * Everything under `<sessionId>/subagents/` is a subagent, and a probe established that the MCP
 * `instructions` block never reaches one -- which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists at
 * all. Counting them would price a card they were never sent. The nested count is reported rather
 * than silently discarded, so the ratio is visible instead of being a claim in a commit message.
 *
 * Session ids are uuids, so a filename seen twice is the same session reached by two paths. That
 * happens: a drive move can leave a whole `d--*` tree copying `c--*`, and counting both silently
 * doubles every figure. The copy KEPT is the most recently modified one, not whichever directory
 * sorts first -- ASCII sort puts `C--x` before `c--x`, so sorting picked the pre-move, staler tree
 * and threw away the live one along with every call recorded in it since. Copies that differ in
 * size are reported, because "byte-identical" is an assumption about someone's disk, not a fact.
 */
function collectSessionFiles(root: string) {
  const bySession = new Map<string, Array<{ project: string; file: string; mtime: number; size: number }>>();
  let nested = 0;

  for (const dir of fs.readdirSync(root).sort()) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        nested += countNestedTranscripts(path.join(full, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const file = path.join(full, entry.name);
      const stat = fs.statSync(file);
      const group = bySession.get(entry.name) ?? [];
      group.push({ project: dir, file, mtime: stat.mtimeMs, size: stat.size });
      bySession.set(entry.name, group);
    }
  }

  const files: Array<{ project: string; file: string }> = [];
  const duplicates: DuplicateGroup[] = [];
  for (const [name, copies] of bySession) {
    copies.sort((a, b) => b.mtime - a.mtime);
    const [kept, ...rest] = copies;
    files.push({ project: kept.project, file: kept.file });
    if (rest.length) {
      duplicates.push({
        name,
        kept: kept.file,
        dropped: rest.map(c => c.file),
        diverged: rest.some(c => c.size !== kept.size),
      });
    }
  }
  return { files, duplicates, nested };
}

function countNestedTranscripts(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countNestedTranscripts(path.join(dir, entry.name));
    else if (entry.name.endsWith('.jsonl')) count++;
  }
  return count;
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

/**
 * Deliberately only the structured read tools. A file read through `Bash` (`cat`, `rg`) or reached
 * by a subagent is invisible here, so the denominator below is sessions we can SEE read a file --
 * it undercounts reads, which moves the compliance rate down, not up.
 */
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
  // Registered whenever transcript search is on, and previously matched by nothing -- which was
  // the whole problem: the transcript ROUTE LINE is the +105 characters that make the card
  // binding, so a table blind to its tools could not see the line that consumed the room.
  ['transcripts', /_(transcript_search|transcript_read|session_list)$/],
];

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

async function main() {
  const ARCHIVE = arg('--archive') ?? path.join(os.homedir(), '.claude', 'projects');
  const sinceFlag = arg('--since');
  const all = process.argv.includes('--all');

  if (sinceFlag !== undefined && !Number.isFinite(Date.parse(`${sinceFlag}T00:00:00Z`))) {
    throw new Error(`--since ${sinceFlag} is not a YYYY-MM-DD date`);
  }
  // Default to the card's own lifetime. Averaging the session rate over months that predate the
  // card prices it against days on which nobody paid for it -- the first run of this script did
  // exactly that over 143 days of which 117 were pre-card, and understated the rate severalfold.
  const since = all ? undefined : (sinceFlag ? Date.parse(`${sinceFlag}T00:00:00Z`) : CARD_BORN);

  const cards: Array<[string, string, string]> = [
    ['claude card', KNOWL_CLAUDE_OPERATIONAL_CARD, 'not currently delivered'],
    ['server card', KNOWL_MCP_SERVER_INSTRUCTIONS, 'transcripts off'],
    ['server + transcripts', mcpServerInstructions(transcriptsEnabled), 'BINDING'],
  ];
  // A wrong config shape makes `mcpServerInstructions` fall back to the shared constant, which
  // reports the binding variant as the same size as the server card and overstates headroom
  // tenfold. Fail loudly: the whole point of this script is the number it would get wrong.
  if (cards[2][1] === KNOWL_MCP_SERVER_INSTRUCTIONS) {
    throw new Error('transcript-enabled card did not render; check isTranscriptSearchEnabled config shape');
  }

  if (!fs.existsSync(ARCHIVE)) {
    throw new Error(`No transcript archive at ${ARCHIVE}. Pass --archive <dir>.`);
  }

  const { files, duplicates, nested } = collectSessionFiles(ARCHIVE);
  const sessions: Session[] = [];
  for (const { project, file } of files) sessions.push(await readSession(project, file));

  // A project counts as knowl-configured when any session in it ever reached a knowl tool. This
  // undercounts projects configured but never used, so the cost figures are conservative in that
  // direction -- and the window below is what keeps them from being inflationary in the other.
  const knowlProjects = new Set(sessions.filter(s => s.calls.some(isKnowlCall)).map(s => s.project));
  let paying = sessions.filter(s => knowlProjects.has(s.project));
  if (since !== undefined) paying = paying.filter(s => s.first !== null && s.first >= since);
  if (!paying.length) throw new Error('No sessions matched.');

  const used = paying.filter(s => s.calls.some(isKnowlCall)).length;
  const stamped = paying.filter(s => s.first !== null);
  const start = Math.min(...stamped.map(s => s.first as number));
  const end = Math.max(...stamped.map(s => s.last as number));
  const days = Math.max((end - start) / 86_400_000, 1);
  const perDay = paying.length / days;

  console.log('=== ARCHIVE ===');
  console.log(`archive                   ${ARCHIVE}`);
  console.log(`main-session transcripts  ${files.length}  (excludes ${nested} subagent transcripts, which never receive the card)`);
  for (const dup of duplicates) {
    console.log(`duplicate ${dup.name}: kept newest ${dup.kept}, dropped ${dup.dropped.length}${dup.diverged ? '  <- COPIES DIFFER IN SIZE' : ''}`);
  }
  console.log(`duplicate sessions merged ${duplicates.length}`);
  console.log(`window                    ${all ? 'ALL TIME (--all): includes days before the card existed' : `since ${new Date(since as number).toISOString().slice(0, 10)}${sinceFlag ? '' : ` (card creation; --all to widen)`}`}`);
  console.log(`sessions paying the card  ${paying.length} across ${knowlProjects.size} knowl-configured project(s)`);
  console.log(`  ...that used knowl      ${used} (${pct(used, paying.length)})`);
  console.log(`  ...that never did       ${paying.length - used} (${pct(paying.length - used, paying.length)})  <- pure overhead`);
  console.log(`span                      ${new Date(start).toISOString().slice(0, 10)} -> ${new Date(end).toISOString().slice(0, 10)} (${days.toFixed(0)} days, ${perDay.toFixed(1)}/day)`);

  console.log('\n=== WHAT THE CARD COSTS ===');
  for (const [label, card, note] of cards) {
    console.log(
      `${label.padEnd(22)}${String(card.length).padStart(6)} chars  ${String(tok(card.length)).padStart(4)} tok/session  ` +
      `${(tok(card.length) * perDay).toFixed(0).padStart(5)} tok/day  ${((tok(card.length) * perDay * 30) / 1000).toFixed(1)}k tok/month  ${note}`,
    );
  }
  const binding = cards[cards.length - 1][1].length;
  console.log(`ceiling ${CARD_CEILING}, binding variant ${binding}, headroom ${CARD_CEILING - binding} chars`);
  console.log(`each additional 100 chars costs ${(tok(100) * perDay * 30 / 1000).toFixed(2)}k tok/month at this session rate`);

  // Measured, not transcribed. This is the payload the card is sent BESIDE, in the same handshake,
  // so it is the only honest scale for "is the card expensive".
  const toolsList = JSON.stringify(knowlToolDefinitions(transcriptsEnabled));
  const toolCount = knowlToolDefinitions(transcriptsEnabled).length;
  console.log(`tools/list in the same handshake: ${toolCount} tools, ${toolsList.length} chars (~${tok(toolsList.length)} tok)`);
  console.log(`the binding card is ${pct(binding, toolsList.length)} of what we already spend beside it`);

  console.log('\n=== DOES RULE ONE LAND? (sessions that read files) ===');
  console.log(`Split on the card's creation date (${CARD_BORN_ISO}); sessions before it never saw it.`);
  console.log('Observational, not an A/B -- the card, hooks and KNOWL.md shipped together, so this');
  console.log('says the system works; it cannot attribute the gain to the 2,000 characters alone.');
  console.log('Needs --all to have a "before" column, since the default window starts at the card.');
  const before = compliance(sessions.filter(s => knowlProjects.has(s.project) && s.first !== null && s.first < CARD_BORN));
  const after = compliance(sessions.filter(s => knowlProjects.has(s.project) && s.first !== null && s.first >= CARD_BORN));
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
  let other = 0;
  const unmatched = new Map<string, number>();
  for (const s of paying) {
    for (const name of s.calls) {
      if (!isKnowlCall(name)) continue;
      total++;
      const hit = GROUPS.find(([, re]) => re.test(name));
      if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
      // Rows have to sum to the total or the table is a claim about coverage it has not earned.
      else { other++; unmatched.set(name, (unmatched.get(name) ?? 0) + 1); }
    }
  }
  const rows: Array<[string, number]> = [...counts, ['other (unrouted)', other]];
  for (const [label, count] of rows.sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(6)}  ${pct(count, total).padStart(6)}  ${label}`);
  }
  console.log(`${String(total).padStart(6)}          total knowl calls`);
  if (unmatched.size) {
    console.log(`unrouted tool names: ${[...unmatched].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}(${c})`).join(', ')}`);
  }
}

main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); });
