import fs from 'node:fs';
import { startupLogPath } from '../core/startup-trace.js';

/**
 * Read the startup trace back as an answer, not as a log.
 *
 * The question this exists to settle is "why did the server drop, and did the change fix it" —
 * so it reports the two things that decide that: how long boots take now, and which phase owns
 * the time. A boot that started and never ended is the signature of a host kill, and it is
 * counted separately, because a kill leaves no summary line of its own to count.
 */

interface Record_ { event: string; [k: string]: any }

const percentile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

export function formatStartupReport(sinceHours: number): string {
  const file = startupLogPath();
  if (!fs.existsSync(file)) {
    return `No startup trace yet at ${file}\nIt is written by \`knowl serve\`; start a session and re-run.`;
  }

  const cutoff = Date.now() - sinceHours * 3600_000;
  const records: Record_[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.at && Date.parse(r.at) >= cutoff) records.push(r);
    } catch { /* a torn final line from a killed process is expected */ }
  }
  if (!records.length) return `No serve startups recorded in the last ${sinceHours}h (${file})`;

  const starts = records.filter(r => r.event === 'boot-start');
  const ends = records.filter(r => r.event === 'boot-end');
  const stalls = records.filter(r => r.event === 'stall');
  const models = records.filter(r => r.event === 'model-load');
  const crashes = records.filter(r => r.event === 'crash' || r.event === 'signal' || r.event === 'exit-before-ready');

  const endedIds = new Set(ends.map(r => r.bootId));
  const neverReady = starts.filter(r => !endedIds.has(r.bootId));

  const out: string[] = [];
  out.push(`KNOWL SERVE STARTUP — last ${sinceHours}h`);
  out.push(`  source: ${file}`);
  out.push('');
  out.push(`  boots started            ${starts.length}`);
  out.push(`  boots that became ready  ${ends.length}`);
  out.push(`  never became ready       ${neverReady.length}${neverReady.length ? '   <-- killed or crashed before initialization finished' : ''}`);
  out.push(`  watchdog stalls (>5s)    ${stalls.length}`);

  const totals = ends.map(r => r.totalMs as number).sort((a, b) => a - b);
  if (totals.length) {
    out.push('');
    out.push(`  time to ready   p50 ${percentile(totals, 50)}ms   p95 ${percentile(totals, 95)}ms   max ${totals[totals.length - 1]}ms`);
  }

  // Which phase owns the time. This is the whole point: "startup was slow" was already known.
  const perPhase = new Map<string, number[]>();
  for (const end of ends) {
    for (const phase of end.phases ?? []) {
      if (!perPhase.has(phase.name)) perPhase.set(phase.name, []);
      perPhase.get(phase.name)!.push(phase.ms);
    }
  }
  if (perPhase.size) {
    out.push('');
    out.push('  PHASE            p50      p95      max     n');
    for (const [name, list] of perPhase) {
      const s = [...list].sort((a, b) => a - b);
      out.push(
        `  ${name.padEnd(16)}${String(percentile(s, 50) + 'ms').padEnd(9)}` +
        `${String(percentile(s, 95) + 'ms').padEnd(9)}${String(s[s.length - 1] + 'ms').padEnd(8)}${s.length}`
      );
    }
  }

  if (models.length) {
    const cold = models.filter(m => !m.cached);
    const warm = models.filter(m => m.cached);
    out.push('');
    out.push('  EMBEDDING MODEL LOADS');
    for (const [label, list] of [['cold (weights absent)', cold], ['warm (weights on disk)', warm]] as const) {
      if (!list.length) continue;
      const ms = list.map(m => m.ms as number).sort((a, b) => a - b);
      out.push(`    ${label.padEnd(24)} n=${String(list.length).padEnd(4)} p50 ${percentile(ms, 50)}ms  max ${ms[ms.length - 1]}ms  (${list[0].model})`);
    }
    // `bootId` is what distinguishes a serve boot from an ordinary CLI run. Every CLI
    // invocation loads a model with no startup trace running, so `afterReady` is false for
    // reasons that have nothing to do with a handshake -- counting those reported a startup
    // problem that did not exist.
    const onDeadline = models.filter(m => m.bootId && m.afterReady === false);
    out.push(`    loads on a serve startup path: ${onDeadline.length}` +
      (onDeadline.length ? '   <-- these DO sit on the connect deadline' : '   (none — a model load never delays a handshake)'));
  }

  if (stalls.length) {
    out.push('');
    out.push('  STALLS (phase running when the watchdog fired)');
    const byPhase = new Map<string, number>();
    for (const s of stalls) byPhase.set(s.phase ?? 'unknown', (byPhase.get(s.phase ?? 'unknown') ?? 0) + 1);
    for (const [phase, n] of [...byPhase.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`    ${String(phase).padEnd(18)} ${n}`);
    }
    const worst = stalls.slice().sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))[0];
    out.push(`    worst: ${worst.elapsedMs}ms in "${worst.phase}" (pid ${worst.pid}, ${worst.at})`);
  }

  if (crashes.length) {
    out.push('');
    out.push('  ABNORMAL EXITS');
    for (const c of crashes.slice(-8)) {
      out.push(`    ${c.at}  ${c.event}${c.kind ? '/' + c.kind : ''}${c.signal ? '/' + c.signal : ''}  phase=${c.phase ?? 'n/a'}  ${String(c.message ?? '').slice(0, 90)}`);
    }
  }

  // Concurrent boots are the contention hypothesis stated as a number: if stalls cluster where
  // boots overlap, the cause is the neighbours, not the repo.
  const buckets = new Map<string, number>();
  for (const s of starts) buckets.set(String(s.at).slice(0, 16), (buckets.get(String(s.at).slice(0, 16)) ?? 0) + 1);
  const bursts = [...buckets.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  if (bursts.length) {
    out.push('');
    out.push('  CONCURRENT BOOT BURSTS (>=3 servers starting in the same minute)');
    for (const [minute, n] of bursts.slice(0, 8)) out.push(`    ${minute}   ${n} servers`);
  }

  return out.join('\n');
}
