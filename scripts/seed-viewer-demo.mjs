#!/usr/bin/env node
/**
 * Build a throwaway store that photographs well, for `docs/assets/viewer-*.png`.
 *
 * WHY THIS EXISTS. A memory store's whole purpose is to accumulate what a team learned and
 * would not otherwise publish: incident causes, code paths, competitive numbers, unshipped
 * plans. `docs/assets/viewer-inspect.png` was once captured against the real store and came
 * one push away from putting all four on npmjs.com, where the README renders and git history
 * keeps it. So the rule is absolute: a public viewer asset is shot against a store seeded for
 * the purpose, never a real one and never a copy of one. Everything below is invented.
 *
 * Usage:
 *   node scripts/seed-viewer-demo.mjs [targetDir] [--force]
 *   cd <targetDir> && knowl view
 *
 * Then shoot the two assets and copy them into docs/assets/.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'dist', 'index.js');
if (!existsSync(cli)) {
  console.error('dist/index.js is missing. Run `npm run build` first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const dirArg = args.find((a) => !a.startsWith('--'));
const target = dirArg ? path.resolve(dirArg) : mkdtempSync(path.join(tmpdir(), 'knowl-viewer-demo-'));
if (dirArg && existsSync(path.join(target, '.knowl')) && !force) {
  // Refuse to seed on top of an existing store unless told twice. Getting this wrong is how a
  // real store ends up in a marketing shot, which is the one failure this script prevents --
  // so re-seeding a demo directory is a deliberate act, not the default.
  console.error('Refusing to seed: ' + target + ' already holds a .knowl store. Pass --force to replace it.');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [cli, ...args], { cwd: target, stdio: 'pipe', ...opts });

execFileSync('git', ['init', '-q', target], { stdio: 'pipe' });
run(['init']);

// ---- the hand-written half -------------------------------------------------------------
// Invented findings for an invented product: Ferryman, a parcel-routing service. They read
// like real memory because the list screenshot is only believable if the titles are, and
// they are about nothing that exists.
const CAT = ['fact', 'decision', 'constraint', 'architecture', 'state', 'skill', 'goal'];
const written = [
  ['fact', 'Depot handover times are logged in local time, so every cross-border leg is off by an hour',
    'The `handover_at` column is written by the depot terminals, which stamp local wall-clock with no offset. Measured across 14 days of Calais traffic: every leg crossing a zone boundary reports a duration one hour out, and twice a year the DST transition makes it two. The fix is a column, not a cast -- there is no way to recover the offset after the fact.'],
  ['decision', 'Route recalculation runs on write, not on read',
    'A read-time recalculation was simpler but put a 40-90ms planner call in front of every tracking page. Writes are 300x rarer than reads here. The planner now runs in the write path and stores the result; the tracking page reads a row.'],
  ['constraint', 'Never retry a dispatch call without the idempotency key -- the carrier bills per accepted booking',
    'The carrier API accepts a duplicate booking silently and invoices for both. Two incidents, EUR 3,100 combined, both from a retry that dropped the key on a socket timeout. The key is now required by the client wrapper and a request without one fails before it leaves the process.'],
  ['architecture', 'The planner is a pure function of a snapshot, which is what makes it testable',
    'Given a `NetworkSnapshot` the planner returns a route with no I/O. Fetching, caching and staleness live in the caller. Every planner test is a table of snapshots, and a failing production route can be replayed by exporting the snapshot from the audit log.'],
  ['fact', 'The overnight sort volume curve peaks at 02:40, not at midnight',
    'Nine weeks of counts. Volume ramps from 22:00, plateaus around 01:00 and peaks at 02:40 with roughly 4.2x the daytime rate. Autoscaling was tuned to a midnight peak that does not exist, so the fleet was already shrinking when load was still climbing.'],
  ['constraint', 'Address normalisation is not reversible -- keep the raw string',
    'Normalisation lowercases, strips punctuation and expands abbreviations. Several of those steps lose information a courier needs (unit numbers behind a slash, care-of lines). The raw string is stored alongside the normalised form and is what prints on the label.'],
  ['decision', 'Parcels carry a ULID, not a sequential number',
    'Sequential ids leaked daily volume to anyone who booked two parcels, which a competitor was doing. ULIDs keep lexical sortability for the index while making the count unguessable.'],
  ['skill', 'A stuck consignment is almost always a scan that arrived before its predecessor',
    'When a parcel sits in `in_transit` with no movement, check `scan_seq` before anything else: an out-of-order arrival leaves the state machine waiting for an event already consumed. `ferryman scans replay <id>` re-runs them in stamp order and clears it. Nine of the last eleven cases.'],
  ['state', 'The Rotterdam depot is still on the v1 scan feed and blocks the v2 cutover',
    'Every other depot moved in March. Rotterdam runs a terminal firmware that cannot emit the v2 envelope, and the replacement units are on a lead time into next quarter. The v1 reader stays until then; do not delete it.'],
  ['architecture', 'Tracking events are append-only and the parcel state is a fold over them',
    'No row is ever mutated. The current state is computed by folding the event log, which is what lets a corrected scan be inserted late and produce the right answer without a repair job.'],
  ['fact', 'Weekend deliveries fail at 3.1x the weekday rate, and it is access, not staffing',
    'Failure reasons broken out: 71% of weekend failures are `no_access` on commercial addresses that are simply closed. Staffing was the assumed cause for two quarters and adding drivers did not move it.'],
  ['decision', 'Label rendering moved out of the request path and behind a queue',
    'PDF rendering was 800ms at p95 and held a worker for all of it. It is now queued, with the label URL returned as pending. Booking p95 fell from 1.2s to 190ms.'],
  ['constraint', 'The carrier sandbox does not simulate customs holds, so that path is untested by definition',
    'Sandbox always returns cleared. Every customs-hold branch is exercised against recorded fixtures instead, and the fixtures came from production audit logs with identifiers scrubbed. Do not trust a green sandbox run as coverage of that path.'],
  ['goal', 'Cut the cross-border quote to under 400ms so it can be shown inline at checkout',
    'Currently 1.4s at p95, which is why the quote is behind a button. The planner call and the customs lookup are the two terms; the customs table is small enough to hold in memory.'],
  ['fact', 'Two thirds of address corrections happen within 90 seconds of booking',
    'Customers fix their own typos almost immediately. A 2-minute hold before the label is committed removes most correction traffic downstream, which was 8% of support volume.'],
  ['skill', 'Reproduce a planner disagreement by exporting the snapshot, not by replaying the request',
    'Replaying the request re-fetches the network and gets a different snapshot, so the bug vanishes. `ferryman snapshot export <routeId>` writes the exact input; feed it to the planner directly. This is the difference between a five-minute repro and an afternoon.'],
  ['architecture', 'One database holds one region, and cross-region parcels are two consignments joined by a handover',
    'There is no cross-region transaction anywhere. A parcel leaving the region is closed out locally and re-opened by the receiving region against a shared handover id.'],
  ['decision', 'Scan ingestion accepts anything and validates asynchronously',
    'A depot terminal that cannot hand off a scan drops it, and a dropped scan is unrecoverable. Ingestion now accepts and acknowledges immediately, then validates; invalid scans land in a quarantine table an operator works through.'],
  ['constraint', 'Courier location is retained for 30 days and is never joined to a customer record',
    'Both halves are contractual, not a preference. The retention job is tested, and the schema keeps the two in separate databases so an accidental join fails at the connection rather than in review.'],
  ['fact', 'The customs tariff table changes about four times a year, always with under a week of notice',
    'Tracked since the service launched. Notice periods observed: 6, 3, 5 and 4 days. Anything requiring a deploy to absorb a tariff change will eventually miss one, so the table is data and loads without a release.'],
  ['state', 'The v2 scan envelope is written by every depot but read by nothing yet',
    'Dual-write has been on for six weeks with no divergence recorded. The reader switch is one flag, held until Rotterdam moves so the two paths are not live at once.'],
  ['skill', 'When quote and invoice disagree, compare the snapshot ids before comparing the numbers',
    'They are almost never computed from the same network snapshot -- the quote is at booking, the invoice at dispatch, and the network moved in between. If the snapshot ids match, it is a real bug; if not, it is expected drift and the reconciliation window covers it.'],
  ['goal', 'Make a depot outage a routing input rather than an incident',
    'Today a depot going dark pages someone who manually reroutes. The planner already accepts capacity per node; wiring the health signal into the snapshot turns the same event into a recalculation.'],
  ['decision', 'Hold the label for 120 seconds after booking',
    'Follows from the correction curve: two thirds of address fixes arrive inside 90 seconds. A short hold absorbs them before the label is committed and a physical relabel becomes necessary.'],
  ['fact', 'Terminal clocks drift up to 40 seconds a week and nothing corrects them',
    'Sampled across 60 terminals. The scan ordering depends on these stamps, which is why out-of-order arrivals are the most common stuck-consignment cause rather than a rare one.'],
  ['constraint', 'A quote is only honoured against the snapshot it was computed from',
    'Quotes carry their snapshot id and a 30-minute validity. Honouring a stale quote against a moved network is how the margin went negative on the Lyon corridor for a fortnight.'],
  ['architecture', 'The audit log is the only writer of the reporting store',
    'Reporting reads never touch operational tables. This is what allows the reporting store to be rebuilt from scratch, which has been done twice after schema changes.'],
  ['state', 'Customs lookups are cached in-process, which is fine at one instance and wrong at twelve',
    'The cache was written when the service was a single process. At current fleet size each instance holds its own copy and a tariff change takes up to an hour to be uniformly visible. Shared cache is scoped, not started.'],
  ['skill', 'A depot reporting zero volume is usually a feed problem, not a quiet night',
    'Check the last accepted scan timestamp before escalating operationally. Genuine zero-volume nights show a decaying tail; a broken feed stops flat. Four of the last five zero-volume alerts were the feed.'],
  ['goal', 'Give support a single view that answers "where is my parcel" without three tabs',
    'Support currently joins the tracking page, the scan quarantine and the carrier portal by hand. Every field needed already exists in the audit log.'],
];

// ---- the generated half ----------------------------------------------------------------
// Body for the graph. Tags are the only link source and `COMMON_TAG = 5` in
// src/viewer/server.ts prunes any tag more than five atoms share, so tags come in threes.
// Getting this wrong is not subtle: 180 atoms on ~18-member tags produced 8 links, and the
// same 180 on 3-member tags produced 188.
const SUBJECTS = [
  'depot handover', 'scan ordering', 'customs tariff', 'label rendering', 'route planner',
  'carrier billing', 'address normalisation', 'courier tracking', 'capacity signal',
  'quarantine queue', 'audit log', 'reporting store', 'snapshot export', 'tracking page',
  'quote validity', 'parcel state machine', 'depot firmware', 'retention job', 'handover id',
  'network snapshot', 'dispatch client', 'idempotency key', 'sort volume', 'access failure',
  'checkout quote', 'terminal clock', 'scan envelope', 'region boundary', 'margin report',
  'support view',
];
const SHAPES = [
  ['fact', 'NOUN latency is dominated by the second call, not the first', 'Measured over a week of production traffic. The first call is served from cache in single-digit milliseconds; the second misses and carries the whole cost. Optimising the wrong one was worth nothing.'],
  ['decision', 'NOUN keeps its own table rather than a column on the parcel', 'A column would have been smaller but makes every historical question a migration. A table costs one join and keeps the history.'],
  ['constraint', 'NOUN must survive a restart mid-batch', 'Batches are large enough that a restart lands inside one often. Progress is checkpointed per item, not per batch, and re-running a checkpointed item is a no-op by construction.'],
  ['architecture', 'NOUN reads through one adapter so the second carrier is a config change', 'Everything carrier-specific is behind a single interface. Adding the second carrier touched configuration and one factory, and nothing else.'],
  ['state', 'NOUN is shipped and on by default, with the old path still present', 'Enabled for all traffic since the start of the month with no reported regressions. The previous implementation stays until the next release cuts it.'],
  ['skill', 'When NOUN looks wrong, check the clock before checking the code', 'Terminal stamps drift and most apparent ordering bugs here are stamp problems. Confirm against the ingestion timestamp first; it costs a minute and resolves most of them.'],
  ['fact', 'NOUN fails closed, which hid a misconfiguration for three weeks', 'The failure mode returned an empty result rather than an error, so callers saw a legitimate-looking nothing. It now raises, and the misconfiguration surfaced in an hour.'],
  ['decision', 'NOUN is computed at write time and stored', 'Read volume is three orders of magnitude higher than write volume here, so any per-read computation is paid a thousand times for each time it changes.'],
  ['goal', 'Bring NOUN under a second at p95', 'Currently sits between 1.5 and 2.5 seconds depending on region. The dominant term is a single sequential fetch that has no ordering requirement.'],
  ['architecture', 'NOUN is append-only, and the current value is a fold', 'Nothing is mutated in place, so a late correction produces the right answer without a repair job.'],
];

// Tag triples that mesh into ONE graph rather than into scattered triangles.
//
// Two things had to be got right, both measured rather than reasoned:
//  1. A single partition into threes gives every atom degree 2 and the graph comes out as N
//     disconnected triangles -- 330 atoms, 130 links, max degree 2.
//  2. Interleaving the orphans with the connected atoms fragments the chains, because every
//     removed atom cuts the run it sat in -- 210 links but still triangle soup on screen.
// So orphans are decided FIRST and the connected atoms are then numbered consecutively, and
// each carries one LOCAL triple plus one LONG-RANGE triple. Local triples give the clustering
// a real graph has; the long-range ones stitch the whole thing together. Every group stays at
// three because COMMON_TAG = 5 in src/viewer/server.ts prunes any tag more than five share.
const shaped = [];
for (const [category, title, content] of written) shaped.push({ category, title, content, orphan: false });
let g = 0;
for (const subject of SUBJECTS) {
  for (const [category, titleShape, body] of SHAPES) {
    shaped.push({
      category,
      title: titleShape.replace('NOUN', subject[0].toUpperCase() + subject.slice(1)),
      content: body.replace(/NOUN/g, subject),
      // Roughly a third stand alone. A store where everything links is not what a real one
      // looks like, and the rim is half of what this screenshot exists to show.
      orphan: g % 3 === 2,
    });
    g++;
  }
}

const span = Math.ceil(shaped.filter((a) => !a.orphan).length / 3);
let solo = 0, c = 0;
const atoms = shaped.map((a) => {
  if (a.orphan) return { ...a, tags: ['solo-' + solo++] };
  const i = c++;
  const tags = ['near-' + Math.floor(i / 3), 'far-' + (i % span)];
  // Every sixth connected atom joins a third triple, which is where the hubs come from.
  if (i % 6 === 0) tags.push('hub-' + Math.floor(i / 18));
  return { ...a, tags };
});

// WRITE ORDER, which is display order: the list sorts newest first.
//
// Tags are already assigned above, so reordering here changes what the list looks like and
// nothing about the graph. Two problems it fixes, both visible in the screenshot before it:
// the generated atoms are ten template shapes applied to thirty subjects, so in generation
// order the list showed the same ten sentences repeated down the page with one noun swapped --
// unmistakably synthetic. And the hand-written atoms went in first, which put them at the
// BOTTOM, so the believable ones were the ones you could not see.
//
// So: generated atoms shuffled by a fixed-seed LCG (fixed, because a screenshot that cannot
// be reproduced is worse than one that can), hand-written ones appended last to sit on top.
const shuffled = atoms.filter((a) => a.orphan !== undefined && !written.some((w) => w[1] === a.title));
let seed = 20260820;
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const j = seed % (i + 1);
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const order = shuffled.concat(atoms.filter((a) => written.some((w) => w[1] === a.title)));

console.log('seeding ' + order.length + ' atoms into ' + target);
let done = 0;
for (const atom of order) {
  const args = ['store', atom.content, '--title', atom.title, '--category', atom.category, '--confidence', '0.9'];
  for (const tag of atom.tags) args.push('--tag', tag);
  try {
    run(args);
  } catch (error) {
    console.error('failed on: ' + atom.title + ' -- ' + String(error.stderr ?? error).slice(0, 200));
  }
  if (++done % 25 === 0) console.log('  ' + done + '/' + order.length);
}

// Retrieval history. This has to go through the RUNNING VIEWER's /api/retrieval, not through
// `knowl query` -- the unread lens counts viewer-surface reads, and a store seeded without
// them truthfully reports that every atom has never been read, which makes the list look
// abandoned in the one screenshot meant to show it in use.
const QUERIES = [
  'depot handover local time', 'route recalculation write path', 'idempotency key carrier billing',
  'planner snapshot pure function', 'overnight sort volume peak', 'address normalisation raw string',
  'stuck consignment scan order', 'rotterdam v1 scan feed', 'tracking events append only',
  'weekend delivery access failure', 'label rendering queue', 'customs hold sandbox',
  'cross-border quote latency', 'address correction window', 'terminal clock drift',
  'quote snapshot validity', 'audit log reporting store', 'customs cache instances',
  'depot zero volume feed', 'support single view', 'parcel ulid sequential', 'planner adapter carrier',
];

console.log('registering retrieval history through the viewer');
const port = 7899;
const viewer = spawn(process.execPath, [cli, 'view', '--port', String(port)], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'] });
const announced = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('viewer did not announce a URL')), 30000);
  viewer.stdout.on('data', (chunk) => {
    const found = /http:[^\s]+/.exec(String(chunk));
    if (found) { clearTimeout(timer); resolve(found[0]); }
  });
});
const origin = 'http://127.0.0.1:' + port;
const token = new URL(announced).searchParams.get('token');
for (const q of QUERIES) {
  const res = await fetch(origin + '/api/retrieval?q=' + encodeURIComponent(q) + '&token=' + token, {
    headers: { Origin: origin },
  });
  if (!res.ok) console.error('  retrieval failed for "' + q + '": ' + res.status);
  else await res.json();
}
viewer.kill();

console.log('\ndone. shoot it with:\n  cd ' + target + '\n  knowl view');
console.log('CAT === ' + CAT.join(',') + ' (all seven kinds are represented)');
