// Self-contained HTML for the read-only Knowl memory-graph viewer.
// No external requests, no build step: one document served at '/'.
// NOTE: this is a single template literal — the client code below intentionally
// avoids backtick template literals and the "$" + "{" sequence so nothing inside
// terminates or interpolates this string.
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Knowl · memory graph</title>
<style>
  :root {
    --bg: #080b11;
    --stage: #0a0e15;
    --panel: rgba(16, 22, 33, 0.82);
    --panel-solid: #10151f;
    --line: rgba(255, 255, 255, 0.09);
    --line-strong: rgba(255, 255, 255, 0.16);
    --ink: #e8eef7;
    --muted: #8493a8;
    --faint: #5a6678;
    --c-decision: #3987e5;
    --c-architecture: #d95926;
    --c-goal: #d55181;
    --c-constraint: #eda100;
    --c-fact: #199e70;
    --c-state: #9085e9;
    --c-skill: #e66767;
    --mono: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
  #app { display: grid; grid-template-columns: 288px 1fr; height: 100vh; }

  .eyebrow {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--faint);
  }

  /* ---- left rail ---- */
  .rail {
    border-right: 1px solid var(--line);
    background: linear-gradient(180deg, #0b1017, #090c12);
    padding: 20px 18px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    overflow-y: auto;
    z-index: 3;
  }
  .brand { display: flex; align-items: center; gap: 11px; }
  .brand .mark {
    width: 30px; height: 30px; border-radius: 8px;
    background: radial-gradient(circle at 34% 30%, #4d9bff, #1c4f9c 70%);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.14), 0 0 22px rgba(57,135,229,0.5);
    position: relative;
  }
  .brand .mark::after {
    content: ""; position: absolute; inset: 10px; border-radius: 50%;
    background: #dcecff; box-shadow: 0 0 10px #bcd8ff;
  }
  .brand h1 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
  .brand p { margin: 1px 0 0; font-size: 11px; color: var(--muted); }

  .search {
    position: relative;
  }
  .search input {
    width: 100%;
    background: #0c1119;
    border: 1px solid var(--line);
    border-radius: 9px;
    color: var(--ink);
    font: 13px var(--sans);
    padding: 9px 11px 9px 30px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search input:focus { border-color: #2f5f9e; box-shadow: 0 0 0 3px rgba(57,135,229,0.16); }
  .search input::placeholder { color: var(--faint); }
  .search svg { position: absolute; left: 9px; top: 9px; width: 14px; height: 14px; stroke: var(--faint); fill: none; }

  .section > .eyebrow { margin-bottom: 10px; display: block; }

  .legend { display: flex; flex-direction: column; gap: 3px; }
  .legend button {
    display: flex; align-items: center; gap: 9px;
    background: none; border: 0; cursor: pointer;
    padding: 6px 7px; border-radius: 7px; width: 100%;
    color: var(--ink); font: 12.5px var(--sans); text-align: left;
    transition: background 0.12s, opacity 0.12s;
  }
  .legend button:hover { background: rgba(255,255,255,0.04); }
  .legend button.off { opacity: 0.38; }
  .legend .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }
  .legend .label { flex: 1; text-transform: capitalize; }
  .legend .count { font-family: var(--mono); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .toggles { display: flex; flex-direction: column; gap: 8px; }
  .toggle { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--ink); }
  .switch { position: relative; width: 34px; height: 19px; flex: none; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track { position: absolute; inset: 0; background: #1a2330; border-radius: 999px; transition: background 0.15s; }
  .switch .thumb { position: absolute; top: 2.5px; left: 2.5px; width: 14px; height: 14px; border-radius: 50%; background: #6b7a90; transition: transform 0.15s, background 0.15s; }
  .switch input:checked + .track { background: #1f4d84; }
  .switch input:checked + .track + .thumb { transform: translateX(15px); background: #6cb0ff; }

  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: auto; }
  .stat { background: #0c1119; border: 1px solid var(--line); border-radius: 9px; padding: 10px 11px; }
  .stat .n { font-family: var(--mono); font-size: 19px; font-variant-numeric: tabular-nums; }
  .stat .k { display: block; margin-top: 2px; }

  /* ---- stage ---- */
  .stage { position: relative; overflow: hidden; background:
    radial-gradient(1200px 700px at 62% 42%, #0e1420 0%, var(--stage) 60%, #06080d 100%); }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas.grabbing { cursor: grabbing; }
  .hint {
    position: absolute; left: 16px; bottom: 14px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.06em;
    color: var(--faint); pointer-events: none; user-select: none;
  }
  .stagehead { position: absolute; left: 18px; top: 16px; pointer-events: none; }
  .stagehead .t { font-size: 12.5px; color: var(--muted); }
  .empty {
    position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
    color: var(--muted); gap: 8px; padding: 24px;
  }
  .empty h2 { font-size: 16px; color: var(--ink); margin: 0; }
  .empty code { font-family: var(--mono); font-size: 12px; color: #6cb0ff; background: #0c1119; padding: 2px 6px; border-radius: 5px; }

  /* ---- tooltip ---- */
  .tooltip {
    position: fixed; z-index: 20; pointer-events: none;
    background: var(--panel-solid); border: 1px solid var(--line-strong);
    border-radius: 8px; padding: 7px 10px; max-width: 260px;
    font-size: 12px; color: var(--ink);
    box-shadow: 0 12px 30px rgba(0,0,0,0.5); transform: translate(-50%, calc(-100% - 12px));
  }
  .tooltip .cat { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; }

  /* ---- inspector ---- */
  .inspector {
    position: absolute; top: 0; right: 0; height: 100%; width: 372px;
    background: var(--panel); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border-left: 1px solid var(--line-strong);
    transform: translateX(100%); transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    display: flex; flex-direction: column; z-index: 10;
  }
  .inspector.open { transform: translateX(0); }
  .inspector .top { padding: 18px 20px 14px; border-bottom: 1px solid var(--line); }
  .inspector .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line-strong);
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 8px currentColor; }
  .close { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
  .close:hover { background: rgba(255,255,255,0.06); color: var(--ink); }
  .inspector h2 { font-size: 17px; line-height: 1.3; margin: 13px 0 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .meta .m { font-family: var(--mono); font-size: 10.5px; color: var(--muted); background: #0c1119; border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px; }
  .meta .m b { color: var(--ink); font-weight: 600; }
  .meta .m.warn b { color: var(--c-constraint); }
  .body { padding: 16px 20px; overflow-y: auto; flex: 1; }
  .body .eyebrow { display: block; margin: 0 0 7px; }
  .body .content { font-size: 13.5px; line-height: 1.6; color: #cdd7e5; white-space: pre-wrap; margin: 0 0 20px; }
  .body .reason { font-size: 13px; line-height: 1.55; color: var(--muted); border-left: 2px solid #2b3646; padding-left: 12px; margin: 0 0 20px; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px; }
  .tags span { font-family: var(--mono); font-size: 11px; color: #9fb0c6; background: #0c1119; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; }
  .ev { display: flex; flex-direction: column; gap: 7px; margin: 0 0 20px; }
  .ev .item { font-size: 12px; color: #cdd7e5; background: #0c1119; border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; }
  .ev .item .k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); margin-bottom: 3px; }
  .ev .item.stale { border-color: #6a4a1e; }
  .ev .item.stale .k { color: var(--c-constraint); }
  .timeline { display: flex; flex-direction: column; gap: 0; }
  .timeline .t { position: relative; padding: 0 0 14px 18px; border-left: 1px solid #2b3646; }
  .timeline .t:last-child { border-left-color: transparent; }
  .timeline .t::before { content: ""; position: absolute; left: -4px; top: 3px; width: 7px; height: 7px; border-radius: 50%; background: #4d9bff; box-shadow: 0 0 8px #4d9bff; }
  .timeline .t .when { font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .timeline .t .what { font-size: 12.5px; color: #cdd7e5; margin-top: 2px; }
  .muted-note { color: var(--faint); font-size: 12px; font-style: italic; }

  @media (max-width: 820px) {
    #app { grid-template-columns: 1fr; }
    .rail { position: absolute; width: 260px; height: 100%; transform: translateX(-100%); transition: transform 0.2s; }
    .rail.show { transform: translateX(0); }
    .inspector { width: 100%; }
  }
</style>
</head>
<body>
<div id="app">
  <aside class="rail">
    <div class="brand">
      <div class="mark"></div>
      <div><h1>Knowl</h1><p>local memory graph</p></div>
    </div>

    <div class="search">
      <svg viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
      <input id="search" type="search" placeholder="Search atoms and tags" autocomplete="off" spellcheck="false" />
    </div>

    <div class="section">
      <span class="eyebrow">Categories</span>
      <div class="legend" id="legend"></div>
    </div>

    <div class="section">
      <span class="eyebrow">Signals</span>
      <div class="toggles">
        <label class="toggle">Show all labels
          <span class="switch"><input type="checkbox" id="tg-labels" /><span class="track"></span><span class="thumb"></span></span>
        </label>
        <label class="toggle">Dim stale atoms
          <span class="switch"><input type="checkbox" id="tg-stale" checked /><span class="track"></span><span class="thumb"></span></span>
        </label>
      </div>
    </div>

    <div class="stats" id="stats"></div>
  </aside>

  <main class="stage">
    <div class="stagehead"><span class="eyebrow">Project brain</span></div>
    <canvas id="graph"></canvas>
    <div class="hint">drag node to pull · drag canvas to pan · scroll to zoom · click to inspect</div>
    <div class="empty" id="empty" hidden>
      <span class="eyebrow">Empty brain</span>
      <h2>No atoms stored yet</h2>
      <div>Record one with <code>knowl decide</code> or let an agent store memory, then refresh.</div>
    </div>
  </main>

  <aside class="inspector" id="inspector" aria-hidden="true"></aside>
</div>
<div class="tooltip" id="tooltip" hidden></div>

<script>
(function () {
  "use strict";
  var CAT = {
    decision: "#3987e5", architecture: "#d95926", goal: "#d55181",
    constraint: "#eda100", fact: "#199e70", state: "#9085e9", skill: "#e66767"
  };
  var CAT_ORDER = ["decision", "architecture", "fact", "constraint", "goal", "state", "skill"];
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.getElementById("graph");
  var ctx = canvas.getContext("2d");
  var tooltip = document.getElementById("tooltip");
  var inspector = document.getElementById("inspector");

  var nodes = [], links = [], byId = {}, adj = {};
  var hiddenCat = {};
  var selected = null, hovered = null, query = "";
  var showAllLabels = false, dimStale = true;
  var view = { scale: 1, x: 0, y: 0 };
  var dragNode = null, panning = false, moved = false, last = { x: 0, y: 0 };
  var W = 0, H = 0, dpr = 1, alpha = 1, t = 0;

  function esc(s) {
    return String(s == null ? "" : s)
      .split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
  }
  function short(id) { return String(id).slice(0, 8); }
  function radius(n) { return 4.5 + Math.sqrt(n.degree || 0) * 2.3; }
  function isVisible(n) { return !hiddenCat[n.category]; }
  function matchesQuery(n) {
    if (!query) return true;
    var q = query.toLowerCase();
    if (n.title && n.title.toLowerCase().indexOf(q) >= 0) return true;
    for (var i = 0; i < n.tags.length; i++) if (n.tags[i].toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fit() {
    if (!nodes.length) return;
    // Frame the dense core: centre on the centroid and scale to the 90th-percentile
    // radius so a few far-flung outliers don't shrink everything into a speck.
    var cx = 0, cy = 0;
    for (var i = 0; i < nodes.length; i++) { cx += nodes[i].x; cy += nodes[i].y; }
    cx /= nodes.length; cy /= nodes.length;
    var dists = [];
    for (var j = 0; j < nodes.length; j++) {
      var dx = nodes[j].x - cx, dy = nodes[j].y - cy;
      dists.push(Math.sqrt(dx * dx + dy * dy));
    }
    dists.sort(function (a, b) { return a - b; });
    var r = dists[Math.floor(dists.length * 0.9)] || 200;
    var s = (Math.min(W, H) / 2) * 0.82 / Math.max(60, r);
    view.scale = Math.max(0.2, Math.min(2.2, s));
    view.x = -cx * view.scale;
    view.y = -cy * view.scale;
  }

  function sx(n) { return W / 2 + view.x + n.x * view.scale; }
  function sy(n) { return H / 2 + view.y + n.y * view.scale; }

  function step() {
    // Cool to a calm rest, then freeze — only the glow keeps breathing in draw().
    // Forces are scaled by alpha and speed is clamped so nodes settle instead of flying.
    if (alpha < 0.004 && !dragNode) return;
    var n = nodes.length;
    var repel = 3400, spring = 0.045, gravity = 0.03, maxV = 10;
    for (var i = 0; i < n; i++) {
      var a = nodes[i];
      if (a === dragNode) continue;
      for (var j = i + 1; j < n; j++) {
        var b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy + 0.01;
        var d = Math.sqrt(d2);
        var f = (repel / d2) * alpha;
        var fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        if (b !== dragNode) { b.vx -= fx; b.vy -= fy; }
      }
    }
    for (var k = 0; k < links.length; k++) {
      var l = links[k];
      var s = byId[l.source], tg = byId[l.target];
      if (!s || !tg) continue;
      var dx2 = tg.x - s.x, dy2 = tg.y - s.y;
      var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.01;
      var ideal = 70 + 26 / (l.weight || 1);
      var force = (dist - ideal) * spring * alpha;
      var ux = (dx2 / dist) * force, uy = (dy2 / dist) * force;
      if (s !== dragNode) { s.vx += ux; s.vy += uy; }
      if (tg !== dragNode) { tg.vx -= ux; tg.vy -= uy; }
    }
    for (var m = 0; m < n; m++) {
      var p = nodes[m];
      if (p === dragNode) continue;
      p.vx -= p.x * gravity * alpha; p.vy -= p.y * gravity * alpha;
      p.vx *= 0.8; p.vy *= 0.8;
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > maxV) { p.vx = p.vx / sp * maxV; p.vy = p.vy / sp * maxV; }
      p.x += p.vx; p.y += p.vy;
    }
    alpha *= 0.985;
  }
  function reheat(v) { alpha = Math.max(alpha, v); }

  function neighborhood(n) {
    var set = {}; set[n.id] = true;
    var list = adj[n.id] || [];
    for (var i = 0; i < list.length; i++) set[list[i]] = true;
    return set;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    var focusNode = hovered || selected;
    var focusSet = focusNode ? neighborhood(focusNode) : null;
    var searching = !!query;

    // links
    ctx.lineWidth = 1;
    for (var k = 0; k < links.length; k++) {
      var l = links[k];
      var s = byId[l.source], tg = byId[l.target];
      if (!s || !tg || !isVisible(s) || !isVisible(tg)) continue;
      var lit = focusSet && (focusSet[s.id] && focusSet[tg.id]);
      var op = lit ? 0.5 : (focusNode ? 0.05 : (searching ? 0.05 : 0.14));
      if (op <= 0.001) continue;
      ctx.beginPath();
      ctx.moveTo(sx(s), sy(s));
      ctx.lineTo(sx(tg), sy(tg));
      ctx.strokeStyle = lit ? "rgba(120,170,255," + op + ")" : "rgba(150,170,200," + op + ")";
      ctx.lineWidth = lit ? 1.4 : 1;
      ctx.stroke();
    }

    // nodes
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var color = CAT[n.category] || "#8493a8";
      var r = radius(n);
      var dim = 1;
      if (focusSet && !focusSet[n.id]) dim = 0.16;
      else if (searching && !matchesQuery(n)) dim = 0.12;
      var stale = n.freshness && n.freshness !== "fresh";
      if (dimStale && stale && dim === 1) dim = 0.5;

      var x = sx(n), y = sy(n);
      var pulse = reduce ? 0 : Math.sin(t / 34 + i) * 0.5 + 0.5;
      var glow = (n === selected ? 20 : (focusSet && focusSet[n.id] ? 15 : 8)) + pulse * 3;

      ctx.globalAlpha = dim;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = glow * (dim);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (stale) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(237,161,0,0.7)";
        ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      }
      if (n === selected) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.globalAlpha = 1;

      var showLabel = showAllLabels || n === selected || n === hovered ||
        (focusSet && focusSet[n.id]) || (searching && matchesQuery(n));
      if (showLabel && dim > 0.3) {
        var label = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
        ctx.font = "11px system-ui, sans-serif";
        ctx.globalAlpha = Math.min(1, dim + 0.2);
        ctx.fillStyle = "#c7d2e0";
        ctx.textAlign = "center";
        ctx.fillText(label, x, y + r + 12);
        ctx.globalAlpha = 1;
      }
    }
  }

  function frame() {
    t++;
    step();
    draw();
    requestAnimationFrame(frame);
  }

  function nodeAt(px, py) {
    var best = null, bestD = Infinity;
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var dx = px - sx(n), dy = py - sy(n);
      var d = dx * dx + dy * dy;
      var rr = radius(n) + 6;
      if (d <= rr * rr && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // ---- rail rendering ----
  function counts() {
    var c = {};
    for (var i = 0; i < nodes.length; i++) c[nodes[i].category] = (c[nodes[i].category] || 0) + 1;
    return c;
  }
  function renderLegend() {
    var c = counts();
    var host = document.getElementById("legend");
    var html = [];
    for (var i = 0; i < CAT_ORDER.length; i++) {
      var cat = CAT_ORDER[i];
      if (!c[cat]) continue;
      html.push(
        '<button data-cat="' + cat + '" class="' + (hiddenCat[cat] ? "off" : "") + '">' +
        '<span class="dot" style="background:' + CAT[cat] + ';color:' + CAT[cat] + '"></span>' +
        '<span class="label">' + cat + '</span>' +
        '<span class="count">' + c[cat] + '</span></button>'
      );
    }
    host.innerHTML = html.join("");
    var btns = host.querySelectorAll("button");
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener("click", function () {
        var cat = this.getAttribute("data-cat");
        hiddenCat[cat] = !hiddenCat[cat];
        this.className = hiddenCat[cat] ? "off" : "";
      });
    }
  }
  function renderStats() {
    var stale = 0;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].freshness && nodes[i].freshness !== "fresh") stale++;
    var rows = [
      ["Atoms", nodes.length],
      ["Links", links.length],
      ["Stale", stale],
      ["Categories", Object.keys(counts()).length]
    ];
    var html = [];
    for (var r = 0; r < rows.length; r++) {
      html.push('<div class="stat"><span class="n">' + rows[r][1] + '</span><span class="k eyebrow">' + rows[r][0] + '</span></div>');
    }
    document.getElementById("stats").innerHTML = html.join("");
  }

  // ---- inspector ----
  function openInspector(n) {
    selected = n;
    var color = CAT[n.category] || "#8493a8";
    var stale = n.freshness && n.freshness !== "fresh";
    var meta = [];
    meta.push('<span class="m">status <b>' + esc(n.status) + '</b></span>');
    meta.push('<span class="m' + (stale ? " warn" : "") + '">freshness <b>' + esc(n.freshness) + '</b></span>');
    if (n.confidence != null) meta.push('<span class="m">confidence <b>' + Math.round(n.confidence * 100) + '%</b></span>');
    meta.push('<span class="m">degree <b>' + n.degree + '</b></span>');
    if (n.updatedAt) meta.push('<span class="m">updated <b>' + esc(String(n.updatedAt).slice(0, 10)) + '</b></span>');

    var tagHtml = n.tags.length
      ? '<span class="eyebrow">Tags</span><div class="tags">' + n.tags.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join("") + '</div>'
      : "";
    var reasonHtml = n.reasoning ? '<span class="eyebrow">Reasoning</span><p class="reason">' + esc(n.reasoning) + '</p>' : "";

    inspector.innerHTML =
      '<div class="top">' +
        '<div class="row">' +
          '<span class="chip" style="color:' + color + '"><span class="dot" style="background:' + color + '"></span>' + esc(n.category) + '</span>' +
          '<button class="close" id="ins-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<h2>' + esc(n.title) + '</h2>' +
        '<div class="meta">' + meta.join("") + '</div>' +
      '</div>' +
      '<div class="body">' +
        '<span class="eyebrow">Content</span>' +
        '<p class="content">' + esc(n.content) + '</p>' +
        reasonHtml +
        tagHtml +
        '<span class="eyebrow">Evidence</span><div class="ev" id="ins-ev"><p class="muted-note">Loading evidence.</p></div>' +
        '<span class="eyebrow">Timeline</span><div class="timeline" id="ins-tl"><p class="muted-note">Loading history.</p></div>' +
      '</div>';

    inspector.classList.add("open");
    inspector.setAttribute("aria-hidden", "false");
    document.getElementById("ins-close").addEventListener("click", closeInspector);

    fetchJSON("/api/evidence/" + encodeURIComponent(n.id)).then(function (rows) {
      var host = document.getElementById("ins-ev");
      if (!host) return;
      if (!rows || !rows.length) { host.innerHTML = '<p class="muted-note">No linked evidence.</p>'; return; }
      host.innerHTML = rows.map(function (e) {
        var stale = e.stale || e.isStale;
        var kind = e.relation || e.type || e.kind || "evidence";
        var loc = e.locator || e.uri || e.ref || e.path || "";
        return '<div class="item' + (stale ? " stale" : "") + '"><div class="k">' + esc(kind) + (stale ? " · stale" : "") + '</div>' + esc(loc) + '</div>';
      }).join("");
    }).catch(function () {
      var host = document.getElementById("ins-ev"); if (host) host.innerHTML = '<p class="muted-note">No linked evidence.</p>';
    });

    fetchJSON("/api/timeline/" + encodeURIComponent(n.id)).then(function (rows) {
      var host = document.getElementById("ins-tl");
      if (!host) return;
      if (!rows || !rows.length) { host.innerHTML = '<p class="muted-note">No recorded assertions.</p>'; return; }
      host.innerHTML = rows.map(function (a) {
        var when = a.assertedAt || a.createdAt || a.at || "";
        var what = a.content || a.summary || a.title || "assertion";
        return '<div class="t"><div class="when">' + esc(String(when).slice(0, 19).replace("T", " ")) + '</div><div class="what">' + esc(what) + '</div></div>';
      }).join("");
    }).catch(function () {
      var host = document.getElementById("ins-tl"); if (host) host.innerHTML = '<p class="muted-note">No recorded assertions.</p>';
    });
  }
  function closeInspector() {
    selected = null;
    inspector.classList.remove("open");
    inspector.setAttribute("aria-hidden", "true");
  }

  // ---- events ----
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    moved = false; last.x = e.clientX; last.y = e.clientY;
    var n = nodeAt(e.offsetX, e.offsetY);
    if (n) { dragNode = n; n.vx = 0; n.vy = 0; }
    else { panning = true; canvas.classList.add("grabbing"); }
  });
  canvas.addEventListener("pointermove", function (e) {
    var dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (dragNode) {
      dragNode.x += dx / view.scale; dragNode.y += dy / view.scale;
      dragNode.vx = 0; dragNode.vy = 0; reheat(0.28);
      last.x = e.clientX; last.y = e.clientY;
      return;
    }
    if (panning) {
      view.x += dx; view.y += dy; last.x = e.clientX; last.y = e.clientY; return;
    }
    var hit = nodeAt(e.offsetX, e.offsetY);
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hit ? "pointer" : "grab";
    }
    if (hit) {
      tooltip.hidden = false;
      tooltip.style.left = e.clientX + "px";
      tooltip.style.top = e.clientY + "px";
      tooltip.innerHTML = '<div class="cat" style="color:' + (CAT[hit.category] || "#8493a8") + '">' + esc(hit.category) + '</div>' + esc(hit.title);
    } else {
      tooltip.hidden = true;
    }
  });
  function endPointer() {
    if (dragNode && !moved) openInspector(dragNode);
    else if (panning && !moved) closeInspector();
    dragNode = null; panning = false; canvas.classList.remove("grabbing");
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointerleave", function () { tooltip.hidden = true; hovered = null; });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.1 : 0.9;
    var mx = e.offsetX - W / 2, my = e.offsetY - H / 2;
    view.x = mx - (mx - view.x) * factor;
    view.y = my - (my - view.y) * factor;
    view.scale = Math.max(0.15, Math.min(4, view.scale * factor));
  }, { passive: false });

  document.getElementById("search").addEventListener("input", function () { query = this.value.trim(); });
  document.getElementById("tg-labels").addEventListener("change", function () { showAllLabels = this.checked; });
  document.getElementById("tg-stale").addEventListener("change", function () { dimStale = this.checked; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeInspector(); });
  window.addEventListener("resize", resize);

  function fetchJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }

  // ---- boot ----
  resize();
  fetchJSON("/api/graph").then(function (data) {
    nodes = (data.nodes || []).map(function (n) {
      n.x = (Math.random() - 0.5) * 420;
      n.y = (Math.random() - 0.5) * 420;
      n.vx = 0; n.vy = 0;
      return n;
    });
    links = data.links || [];
    for (var i = 0; i < nodes.length; i++) { byId[nodes[i].id] = nodes[i]; adj[nodes[i].id] = []; }
    for (var k = 0; k < links.length; k++) {
      var l = links[k];
      if (adj[l.source]) adj[l.source].push(l.target);
      if (adj[l.target]) adj[l.target].push(l.source);
    }
    if (!nodes.length) { document.getElementById("empty").hidden = false; return; }
    renderLegend();
    renderStats();
    // settle off-screen so the graph opens calm, then frame it and let it freeze
    for (var s = 0; s < 240; s++) step();
    alpha = 0.05;
    fit();
    frame();
  });
})();
</script>
</body>
</html>`;
