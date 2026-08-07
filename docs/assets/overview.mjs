import fs from 'node:fs';

// Source for docs/assets/overview.gif, the animation at the top of the README.
//
// Regenerate:
//
//   node docs/assets/overview.mjs                       # writes frames/*.svg here
//   docker build -f docs/assets/demo.Dockerfile -t knowl-vhs docs/assets
//   docker run --rm -v "$PWD/docs/assets:/w" -w /w --entrypoint sh knowl-vhs -c '
//     apt-get update && apt-get install -y librsvg2-bin
//     mkdir -p png && for f in frames/a*.svg; do rsvg-convert -w 1200 -h 675 "$f" -o "png/$(basename "$f" .svg).png"; done
//     ffmpeg -y -framerate 20 -i png/a%04d.png -vf "fps=14,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 overview.gif'
//
// A frame sequence rather than a few stills with crossfades: text types character by
// character, a spinner runs while the write lands, the strikethrough draws across the
// retired title, cards slide in, and the figures count up. Crossfading stills reads as a
// slideshow, which is exactly what a scrolling reader ignores.
//
// Every number here is published elsewhere in the README and must move with it: 98/47 from
// the MemoryAgentBench conflict-resolution ablation, and 27 MCP tools from the generated
// tool-count marker.
const FPS = 20, DUR = 12.0, N = Math.round(FPS * DUR);
const W = 1200, H = 675;
const BG = '#0d1117', CARD = '#161b22', LINE = '#2c313a';
const WHITE = '#ffffff', MUTED = '#8b949e', DIM = '#6e7681';
const GREEN = '#3fb950', GREEN_D = '#199e70', BLUE = '#58a6ff', AMBER = '#eda100';
const VIOLET = '#a371f7', PINK = '#f778ba', CYAN = '#56d4dd';
const F = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace";

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** 0 before `from`, 1 after `to`, eased in between. */
const ramp = (t, from, to) => {
  const p = clamp((t - from) / Math.max(1e-6, to - from));
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
};
const between = (t, a, b) => t >= a && t < b;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fade plus a short upward drift — the motion that makes an element feel placed, not pasted. */
function enter(t, from, dy = 18, dur = 0.42) {
  const p = ramp(t, from, from + dur);
  return { o: p, y: (1 - p) * dy };
}

function card({ y, o = 1, dy = 0, title, body, pill, pillFill, pillText, stroke, dashed, faded, strike = 0 }) {
  const titleW = title.length * 19;
  return `<g opacity="${o.toFixed(3)}" transform="translate(0 ${dy.toFixed(1)})">
  <rect x="80" y="${y}" width="1040" height="124" rx="14" fill="${CARD}" stroke="${stroke}" stroke-width="${dashed ? 2 : 3}"${dashed ? ' stroke-dasharray="9 6"' : ''}/>
  <rect x="110" y="${y + 20}" width="${pill.length * 13 + 30}" height="33" rx="16" fill="${pillFill}"/>
  <text x="125" y="${y + 43}" font-size="19" font-weight="700" fill="${pillText}">${pill}</text>
  <text x="110" y="${y + 88}" font-size="34" font-weight="700" fill="${faded ? DIM : WHITE}">${title}</text>
  <text x="110" y="${y + 114}" font-size="23" fill="${faded ? DIM : MUTED}">${esc(body)}</text>
  ${strike > 0 ? `<line x1="110" y1="${y + 79}" x2="${110 + titleW * strike}" y2="${y + 79}" stroke="${DIM}" stroke-width="3"/>` : ''}
</g>`;
}

function feat(x, y, o, dy, colour, name, body) {
  return `<g opacity="${o.toFixed(3)}" transform="translate(${dy.toFixed(1)} 0)">
  <rect x="${x}" y="${y}" width="9" height="52" rx="4.5" fill="${colour}"/>
  <text x="${x + 28}" y="${y + 24}" font-size="29" font-weight="700" fill="${WHITE}">${name}</text>
  <text x="${x + 28}" y="${y + 50}" font-size="21" fill="${MUTED}">${esc(body)}</text>
</g>`;
}

/** Eight-tick spinner, one step per ~80ms. */
function spinner(cx, cy, t) {
  const step = Math.floor(t / 0.08) % 8;
  let out = '';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const dist = ((i - step) + 8) % 8;
    out += `<circle cx="${(cx + Math.cos(a) * 13).toFixed(1)}" cy="${(cy + Math.sin(a) * 13).toFixed(1)}" r="2.8" fill="${BLUE}" opacity="${(1 - dist / 8).toFixed(2)}"/>`;
  }
  return out;
}

const CMD = '$ knowl decide "Database choice" "SQLite. Lives beside the code."';

function frame(t) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${F}">
  <rect width="${W}" height="${H}" fill="${BG}"/>`;

  // ---------------- Scene A : 0.0 - 5.4 ----------------
  if (t < 5.6) {
    const a = Math.min(1, ramp(t, 5.2, 5.6) === 0 ? 1 : 1 - ramp(t, 5.2, 5.6));
    s += `<g opacity="${a.toFixed(3)}">`;

    const h1 = enter(t, 0.05), h2 = enter(t, 0.22), sub = enter(t, 0.45);
    s += `<text x="80" y="${96 - h1.y}" font-size="48" font-weight="800" fill="${WHITE}" opacity="${h1.o.toFixed(3)}">Your coding agent is</text>`;
    s += `<text x="590" y="${96 - h2.y}" font-size="48" font-weight="800" fill="${AMBER}" opacity="${h2.o.toFixed(3)}">confidently wrong.</text>`;
    s += `<text x="80" y="${146 - sub.y}" font-size="28" fill="${MUTED}" opacity="${sub.o.toFixed(3)}">It still quotes the database you dropped last year.</text>`;

    // The held belief. It is active until the write lands at 3.55, then becomes history.
    const retired = t >= 3.55;
    const c1 = enter(t, 0.8, 22);
    s += card({
      y: 186, o: c1.o, dy: -c1.y,
      title: 'Database choice', body: 'PostgreSQL. Managed, familiar.',
      pill: retired ? 'superseded' : 'active',
      pillFill: retired ? '#2a1f18' : '#0f2e1f',
      pillText: retired ? AMBER : GREEN,
      stroke: retired ? '#30363d' : GREEN_D,
      dashed: retired, faded: retired,
      strike: ramp(t, 3.6, 4.05),
    });

    // The command, typed.
    if (t > 1.45) {
      const shown = Math.floor(clamp((t - 1.45) / 1.55) * CMD.length);
      const caret = t < 3.05 && Math.floor(t / 0.28) % 2 === 0;
      s += `<text x="80" y="356" font-size="26" font-family="${MONO}" fill="${BLUE}">${esc(CMD.slice(0, shown))}${caret ? '<tspan fill="#c9d1d9">▋</tspan>' : ''}</text>`;
    }

    // Working…
    if (between(t, 3.05, 3.62)) {
      s += spinner(104, 404, t);
      s += `<text x="132" y="412" font-size="24" fill="${DIM}">writing…</text>`;
    }

    // The replacement arrives.
    if (t > 3.62) {
      const c2 = enter(t, 3.62, 26, 0.38);
      s += card({
        y: 386, o: c2.o, dy: c2.y,
        title: 'Database choice', body: 'SQLite. Lives beside the code, no server.',
        pill: 'active', pillFill: '#0f2e1f', pillText: GREEN, stroke: GREEN_D,
      });
    }

    const p1 = enter(t, 4.15), p2 = enter(t, 4.4);
    s += `<text x="80" y="${570 - p1.y}" font-size="34" font-weight="700" fill="${GREEN}" opacity="${p1.o.toFixed(3)}">Knowl retires the old answer at write time.</text>`;
    s += `<text x="80" y="${614 - p2.y}" font-size="26" fill="${MUTED}" opacity="${p2.o.toFixed(3)}">A query returns one answer. The other is history, not noise.</text>`;
    s += `</g>`;
  }

  // ---------------- Scene B : 5.4 - 9.4 ----------------
  if (between(t, 5.35, 9.5)) {
    const u = t - 5.35;
    const o = Math.min(ramp(t, 5.35, 5.7), 1 - ramp(t, 9.1, 9.5));
    s += `<g opacity="${o.toFixed(3)}">`;

    // Numbers count up, then hold.
    const n1 = Math.round(98 * ramp(u, 0.10, 0.80));
    const n2 = Math.round(47 * ramp(u, 0.10, 0.80));
    s += `<text x="80" y="112" font-size="104" font-weight="800" fill="${GREEN}">${n1}%</text>`;
    s += `<text x="308" y="106" font-size="44" font-weight="700" fill="${DIM}" opacity="${ramp(u, 0.55, 0.80).toFixed(2)}">vs</text>`;
    s += `<text x="392" y="112" font-size="104" font-weight="800" fill="${DIM}">${n2}%</text>`;
    s += `<text x="80" y="146" font-size="22" fill="${MUTED}" opacity="${ramp(u, 0.65, 0.90).toFixed(2)}">with supersession</text>`;
    s += `<text x="392" y="146" font-size="22" fill="${DIM}" opacity="${ramp(u, 0.65, 0.90).toFixed(2)}">without</text>`;
    const hd = enter(u, 0.35);
    s += `<g opacity="${hd.o.toFixed(3)}">
      <text x="660" y="92" font-size="25" font-weight="700" fill="${WHITE}">Answering &#8220;which fact is current?&#8221;</text>
      <text x="660" y="124" font-size="21" fill="${DIM}">MemoryAgentBench conflict resolution</text>
      <text x="660" y="150" font-size="21" fill="${DIM}">Same corpus, same ranker.</text></g>`;

    // The rule sweeps open, then the capabilities stagger in.
    const rule = ramp(u, 0.70, 1.00);
    s += `<line x1="80" y1="188" x2="${80 + 1040 * rule}" y2="188" stroke="${LINE}" stroke-width="2"/>`;
    const th = enter(u, 0.80);
    s += `<text x="80" y="${238 - th.y}" font-size="34" font-weight="800" fill="${WHITE}" opacity="${th.o.toFixed(3)}">And everything else in the box</text>`;

    const rows = [
      [80, 278, GREEN_D, 'Corrects itself', 'Seven typed atoms, full history, time travel'],
      [620, 278, BLUE, 'Retrieval for agents', 'Vector + BM25, reranked by freshness'],
      [80, 388, VIOLET, 'Survives the session', 'Hooks, handoffs, resume keys'],
      [620, 388, AMBER, 'Workspaces', 'Many repos, one memory, promote explicitly'],
      [80, 498, PINK, 'Reusable skills', 'File-backed, read before they run'],
      [620, 498, CYAN, 'Your data, portable', 'Checksummed export, verified snapshots'],
    ];
    rows.forEach((r, i) => {
      const e = enter(u, 0.95 + i * 0.075, 0, 0.30);
      const slide = (1 - e.o) * -26;
      s += feat(r[0], r[1], e.o, slide, r[2], r[3], r[4]);
    });
    const foot = enter(u, 1.55);
    s += `<text x="80" y="622" font-size="24" fill="${DIM}" opacity="${foot.o.toFixed(3)}">Runs offline. No API key. Nothing leaves the machine.</text>`;
    s += `</g>`;
  }

  // ---------------- Scene C : 9.3 - 12.0 ----------------
  if (t >= 9.25) {
    const u = t - 9.25;
    const o = ramp(t, 9.25, 9.6);
    s += `<g opacity="${o.toFixed(3)}">`;
    const b = enter(u, 0.05);
    s += `<text x="80" y="${118 - b.y}" font-size="58" font-weight="800" fill="${WHITE}" opacity="${b.o.toFixed(3)}">knowl</text>`;
    s += `<text x="290" y="${118 - b.y}" font-size="32" fill="${MUTED}" opacity="${b.o.toFixed(3)}">Local-first memory for AI coding agents.</text>`;
    s += `<line x1="80" y1="164" x2="${80 + 1040 * ramp(u, 0.2, 0.55)}" y2="164" stroke="${LINE}" stroke-width="2"/>`;

    const stats = [[80, 27, GREEN, 'MCP tools'], [360, 0, BLUE, 'API keys'], [640, 100, AMBER, 'local, no egress'], [960, 7, VIOLET, 'atom types']];
    stats.forEach((st, i) => {
      const p = ramp(u, 0.35 + i * 0.09, 1.05 + i * 0.09);
      const val = Math.round(st[1] * p);
      s += `<text x="${st[0]}" y="268" font-size="72" font-weight="800" fill="${st[2]}">${val}${st[1] === 100 ? '%' : ''}</text>`;
      s += `<text x="${st[0]}" y="304" font-size="23" fill="${DIM}" opacity="${p.toFixed(2)}">${st[3]}</text>`;
    });

    s += `<line x1="80" y1="360" x2="${80 + 1040 * ramp(u, 1.25, 1.6)}" y2="360" stroke="${LINE}" stroke-width="2"/>`;
    const t1 = enter(u, 1.35), t2 = enter(u, 1.55), lk = enter(u, 1.85);
    s += `<text x="80" y="${440 - t1.y}" font-size="40" font-weight="700" fill="${WHITE}" opacity="${t1.o.toFixed(3)}">Memory shouldn&#8217;t just remember the past.</text>`;
    s += `<text x="80" y="${494 - t2.y}" font-size="40" font-weight="700" fill="${GREEN}" opacity="${t2.o.toFixed(3)}">It should know what&#8217;s true now.</text>`;
    s += `<text x="80" y="${600 - lk.y}" font-size="36" font-weight="700" fill="${BLUE}" opacity="${lk.o.toFixed(3)}">github.com/dat999zx/knowl</text>`;
    s += `</g>`;
  }

  return s + '</svg>\n';
}

fs.mkdirSync('frames', { recursive: true });
for (let i = 0; i < N; i++) {
  fs.writeFileSync(`frames/a${String(i).padStart(4, '0')}.svg`, frame(i / FPS), 'utf8');
}
console.log(`  wrote ${N} frames at ${FPS}fps (${DUR}s)`);
