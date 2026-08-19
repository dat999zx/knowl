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
<link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAP1BMVEUREhP39/cAAAA0zN4N7vJeXl8fXWWfoKAvuMgxwtMqm6lV//8xwtQ/v78hP0M3vuUAAAAAAAAAAAAAAAAAAAChK0qDAAAAEHRSTlP+/wD5DP/+//GZ/ANoBP8SkfQ8pQAAAw5JREFUeNq1V4mSIyEIJWnRvtL9/3+7gBcqJpmdXasmVaP9HsglwHNY7sU/7txgSQu20znafLnxaxjgB226bRnW5ujbw30iIPh9CmDdwXt/XfQD+ypbp5MP3hCQorcI3z10y++ixv10bk5Al2fp64BOHKzHKZ/ZBIeIn8ELhWuuAVp9Fg8fliihrgEKT+L36xPBRbbYFAMU/Ivx8MVihldhAI338NXymgFy9HyPjww5piD57yf4xPCqBAfbP+NDwBkOQ6gMEL3JBO7plP0evAYWxCAHypIESwQAq7L/I6/KkcCaQBggEsgFqv/xUReaGzEeOKA4c8mDdxt/Sh4DFL6917Lc5Es2xbashrkSQ8Ibpl3Zl1Q72IKmB5XomS8JDDdZYLWOfbVn/A9GFc7nDe5eLQW4fPikA/rFTBO/rDd5wpkpvHDmQ4jyucgsfVyIGdmIm0W+C0ZUEElKheIkpK82CSK6QegsnQjYCqEhUC5+8AGABEHoXe2lLkczsowlekrD490c31aFr3DEIrzukAmorO++h3OQiWVYt/FI50WXJGQ/zMRCkGMGsBKNBDkir7wvii7JhjBkDlaU3vfVkikSEgFWsah1CEkSVutoWq4rKRHUeRUg+xWP+mJQCa6Wtdq+RNwMz0UhE0SxOBBM5KMm8LoWGgQNviXjK9RcrAwNQQMJbZx4rUH2emgJND70hVGSQeVpjmVNUCAqC1XWp1AG7cCSVUh/KXhDmyk1aSEmk1nTa2qESV2WZOpqukERYAJP6TyWRDQ1MJ5MsaFV0oLcu/Ig4qTVgKdZVKMXQvHIA2f9EhVVq6wLQcSDnzPEsm49LEU0++yaMqSHxXjaWp/PGNLTZj2uXWGbMKTHlZ73wYzDk2oykALyvDOLbjD6YjxhqA0Gtzjd22k86cOWanG6JisFkhEbocOXJqtt8+IDOjothNYDZ23zft9o/l2rC/+y2f59u18Gjo9KzAaO34884k33xdBFk9/xv8Y+uYZ7P3i6t4NnHH3dfPS9P42+74fv45vhW4//hWV7M/7/AVG7HQzkICwnAAAAAElFTkSuQmCC" />
<style>
  :root {
    /* docs.knowl.cloud's own tokens (design/site/_knowl/base.css in knowl-cloud). The viewer
       used to run a palette of its own, which is how one product ended up with three. */
    --bg: #04121a;
    --stage: #04121a;
    --panel: #081f28f5;
    --panel-solid: #0a1f29;
    --raised: #0d2733f7;
    --line: #78becd29;
    --line-strong: #78becd4a;
    --ink: #faf8f5;
    --tusk: #e6faff;
    --muted: #a9c2cb;
    --faint: #7fa3b0;
    --accent: #4fd8e8;
    --accent-deep: #0a6b7a;
    --mint: #7fe3c0;
    --gold: #f2e2c4;
    /* Attention, not brand: the unread mark must not compete with the cyan the site spends on
       links and focus. */
    --mark: var(--gold);
    /* The seven knowledge kinds, from the product's own ramp -- oklch(.76 .125 H) at matched
       lightness and chroma so none shouts over the others. Colour on this page means something:
       a violet chip is an architecture atom, not decoration. */
    --c-constraint: #f69088;
    --c-decision: #cab049;
    --c-goal: #85c577;
    --c-fact: #21c9ca;
    --c-state: #70b6fd;
    --c-architecture: #b7a0f8;
    --c-skill: #e691ca;
    /* Geist and JetBrains Mono are woff2 on the site. This page is offline and its CSP forbids
       every external request, so the closest system stacks stand in rather than a webfont that
       would silently fail to load. */
    --sans: Geist, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;

    --ease: cubic-bezier(.2,.6,.2,1);
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
    background: linear-gradient(180deg, #061821, #04121a);
    padding: 20px 18px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    overflow-y: auto;
    z-index: 3;
  }
  .brand { display: flex; align-items: center; gap: 11px; }
  /* The product mark, inlined as a data URI. The CSP is default-src 'none' with img-src data:,
     so an external file could never load here; 64px at 16 colours is 942 bytes, which is what a
     three-colour mark actually costs. */
  .brand .mark {
    width: 26px; height: 26px; flex: none; display: block;
    image-rendering: -webkit-optimize-contrast;
  }
  .brand h1 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
  .brand p { margin: 1px 0 0; font-size: 11px; color: var(--muted); }

  .search {
    position: relative;
  }
  .search input {
    width: 100%;
    background: var(--stage);
    border: 1px solid var(--line);
    border-radius: 3px;
    color: var(--ink);
    font: 13px var(--sans);
    padding: 9px 11px 9px 30px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(79,216,232,0.2); }
  .search input::placeholder { color: var(--faint); }
  .search svg { position: absolute; left: 9px; top: 9px; width: 14px; height: 14px; stroke: var(--faint); fill: none; }

  .section > .eyebrow { margin-bottom: 10px; display: block; }

  .legend { display: flex; flex-direction: column; gap: 3px; }
  .legend button {
    display: flex; align-items: center; gap: 10px;
    background: none; border: 0; cursor: pointer;
    padding: 4px 6px; border-radius: 2px; width: 100%;
    color: var(--ink); font: 12.5px var(--sans); text-align: left;
    transition: background 0.12s, opacity 0.12s;
  }
  .legend button:hover { background: var(--raised); }
  .legend button.off { opacity: 0.38; }
  .legend .dot { width: 9px; height: 9px; flex: none; }
  .legend .label { flex: 1; text-transform: lowercase; letter-spacing: .01em; }
  .legend .count { font-family: var(--mono); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .toggles { display: flex; flex-direction: column; gap: 8px; }
  .toggle { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--ink); }
  .switch { position: relative; width: 34px; height: 19px; flex: none; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track { position: absolute; inset: 0; background: var(--line); border-radius: 999px; transition: background 0.15s; }
  .switch .thumb { position: absolute; top: 2.5px; left: 2.5px; width: 14px; height: 14px; border-radius: 50%; background: var(--faint); transition: transform 0.15s, background 0.15s; }
  .switch input:checked + .track { background: var(--accent-deep); }
  .switch input:checked + .track + .thumb { transform: translateX(15px); background: var(--mark); }

  .stats { margin-top: auto; border-top: 1px solid var(--line); padding-top: 12px;
    display: flex; flex-direction: column; gap: 6px; }
  .tally { display: flex; align-items: baseline; gap: 8px; }
  .tally .n { font-family: var(--mono); font-size: 15px; font-variant-numeric: tabular-nums;
    color: var(--muted); min-width: 3.2ch; text-align: right; }
  .tally .k { font-size: 12px; color: var(--faint); }
  .tally.unread .n { color: var(--mark); }
  .tally.unread .k { color: var(--muted); }

  /* ---- stage ---- */
  .stage { position: relative; overflow: hidden; background: var(--stage); }
  .stage::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(1100px 620px at 78% 8%, #0a2f3d 0%, transparent 62%);
  }
  .stage > * { position: relative; }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas.grabbing { cursor: grabbing; }
  .hint {
    position: absolute; left: 16px; bottom: 14px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.06em;
    color: var(--faint); pointer-events: none; user-select: none;
  }
  .stagehead {
    position: absolute; left: 18px; right: 18px; top: 16px; z-index: 3;
    display: flex; align-items: center; gap: 12px;
    /* The eyebrow must stay click-through so it never eats a drag on the canvas beneath it;
       the controls opt back in individually. */
    pointer-events: none;
  }
  .stagehead .t { font-size: 12.5px; color: var(--muted); }
  .stagehead .viewswitch, .stagehead #new-atom { pointer-events: auto; }
  .stagehead #new-atom { margin-left: auto; }

  .viewswitch { display: flex; gap: 2px; }
  .viewswitch button, #new-atom {
    background: var(--panel-solid); border: 1px solid var(--line); color: var(--muted);
    padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12.5px; border-radius: 6px;
  }
  .viewswitch button[aria-selected="true"] { color: var(--ink); border-color: var(--line-strong); }
  .viewswitch button:hover, #new-atom:hover { color: var(--ink); border-color: var(--line-strong); }

  .listwrap { position: absolute; inset: 52px 0 0 0; overflow: auto; padding: 8px 18px 24px; }
  .lenses { display: flex; gap: 4px; margin-bottom: 12px; }
  .lenses button {
    background: transparent; border: 1px solid var(--line); color: var(--muted);
    padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12.5px; border-radius: 6px;
  }
  .lenses button.on { color: var(--ink); border-color: var(--line-strong); }
  .lenses .n { opacity: .6; margin-left: 5px; }
  table.atoms { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.atoms th {
    text-align: left; color: var(--faint); font-weight: 500; font-size: 11px;
    letter-spacing: .04em; text-transform: uppercase;
    border-bottom: 1px solid var(--line); padding: 6px 8px;
  }
  table.atoms td { border-bottom: 1px solid var(--line); padding: 7px 8px; color: var(--muted); }
  table.atoms tbody tr:hover td { background: var(--panel-solid); cursor: pointer; }
  table.atoms td.t { color: var(--ink); max-width: 52ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table.atoms .num { text-align: right; font-variant-numeric: tabular-nums; }
  /* td.zero wins on specificity; this used a category token for a non-category meaning. */
  .empty-list { color: var(--muted); padding: 18px 8px; }
  /* Named for a screen reader, silent on screen: the gutter and freshness columns
     carry meaning but no visible heading. */
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; }

  /* ---- rendered atom body ----
     A real reading measure, because these are documents averaging ~1,900 characters and the
     complaint that started this work was that they were unreadable. Set in the site's own face
     rather than a serif: docs.knowl.cloud sets its prose in Geist, and a viewer that reads as a
     different product is the problem this retokenisation exists to fix. Code stays monospace so
     a path or an identifier is still legible as one. */
  .content, .reason {
    font-family: var(--sans); font-size: 14.5px; line-height: 1.62; color: var(--ink);
    max-width: 68ch;
  }
  .reason { color: var(--muted); font-size: 13.5px; }
  .content > :first-child, .reason > :first-child { margin-top: 0; }
  .content > :last-child, .reason > :last-child { margin-bottom: 0; }
  .content p, .reason p { margin: 0 0 0.85em; }
  .content strong { color: var(--tusk); font-weight: 650; }
  .content em { font-style: italic; color: var(--ink); }
  /* Distinct levels. These bodies routinely use ## and ### for real section structure, and
     collapsing every level into one decoration flattened exactly the hierarchy that made them
     worth reading as documents. */
  .content h3 {
    font-family: var(--sans); font-size: 14px; font-weight: 600; color: var(--ink);
    margin: 1.7em 0 .5em; padding-bottom: .35em; border-bottom: 1px solid var(--line);
  }
  .content h4 {
    font-family: var(--sans); font-size: 12.5px; font-weight: 600; color: var(--muted);
    margin: 1.4em 0 .4em;
  }
  .content h5, .content h6 {
    font-family: var(--sans); font-size: 11px; font-weight: 600; color: var(--faint);
    letter-spacing: .06em; text-transform: uppercase; margin: 1.2em 0 .35em;
  }
  .content ul, .content ol, .reason ul { margin: 0 0 .85em; padding-left: 1.25em; }
  .content li, .reason li { margin: .22em 0; }
  .content code, .reason code, .content pre {
    font-family: var(--mono); font-size: 12px; font-style: normal;
  }
  .content code, .reason code {
    background: var(--stage); border: 1px solid var(--line); border-radius: 2px;
    padding: 0.05em 0.34em; color: var(--mint); overflow-wrap: anywhere;
  }
  .content pre {
    background: var(--stage); border: 1px solid var(--line); border-left: 2px solid var(--line-strong);
    padding: 10px 12px; overflow-x: auto; margin: 0 0 .9em; line-height: 1.5;
  }
  .content pre code { background: none; border: 0; padding: 0; white-space: pre; color: var(--muted); }
  .content a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .content .tablewrap { overflow-x: auto; margin: 0 0 .9em; }
  .content table { border-collapse: collapse; margin: 0 0 .9em; font-family: var(--sans); font-size: 12.5px; }
  .content th, .content td { border: 1px solid var(--line); padding: 5px 9px; text-align: left; vertical-align: top; }
  .content th { color: var(--faint); font-weight: 600; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  .content td { color: var(--muted); }

  /* ---- the unread gutter ----
     Two hundred and thirty-four of these atoms have never been retrieved once. That is the
     product's whole argument, so it is a mark in the margin of every row rather than a number
     in a column: an ochre bar for never read, a hairline for read. Uncut pages. */
  table.atoms td.cat { color: var(--muted); white-space: nowrap; }
  table.atoms td.cat .dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; vertical-align: baseline; }
  table.atoms td.num { color: var(--faint); }
  table.atoms td.zero { color: var(--mark); }
  table.atoms td.g { width: 3px; padding: 0; }
  table.atoms td.g i { display: block; height: 18px; width: 3px; background: var(--line-strong); }
  table.atoms tr.never td.g i { background: var(--mark); }
  table.atoms tr.never td.t { color: var(--tusk); }
  .inspector .gutter { display: block; width: 100%; height: 3px; background: var(--line-strong); }
  .inspector .gutter.never { background: var(--mark); }

  .acts { display: flex; gap: 8px; margin-top: 14px; }
  .acts button {
    background: var(--panel-solid); border: 1px solid var(--line); color: var(--ink);
    padding: 6px 13px; cursor: pointer; font: inherit; font-size: 12.5px; border-radius: 6px;
  }
  .acts button:hover { border-color: var(--line-strong); }
  .acts button.danger:hover { border-color: var(--c-constraint); color: var(--c-constraint); }
  .editform label, #newform label { display: block; margin: 11px 0; color: var(--muted); font-size: 11.5px; }
  .editform input, .editform textarea, .editform select,
  #newform input, #newform textarea, #newform select {
    display: block; width: 100%; margin-top: 5px; background: var(--stage); color: var(--ink);
    border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; font: inherit;
    font-size: 12.5px; box-sizing: border-box; outline: none;
  }
  .editform input:focus, .editform textarea:focus, .editform select:focus,
  #newform input:focus, #newform textarea:focus, #newform select:focus {
    border-color: var(--mark); box-shadow: 0 0 0 2px rgba(242,226,196,0.16);
  }
  .editform textarea, #newform textarea { resize: vertical; font-family: var(--mono); font-size: 12px; }
  dialog#newdlg {
    background: var(--panel-solid); color: var(--ink); border: 1px solid var(--line);
    border-radius: 12px; max-width: 720px; width: 90vw; padding: 22px 24px;
  }
  dialog#newdlg h2 { margin: 0 0 4px; font-size: 15px; }
  dialog#newdlg::backdrop { background: rgba(2, 9, 13, 0.68); }
  .err { color: var(--c-constraint); margin-top: 10px; font-size: 12.5px; }
  .empty {
    position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
    color: var(--muted); gap: 8px; padding: 24px;
    /* It covers the whole stage and is a later sibling than .listwrap, so without this it
       swallows clicks on the lens buttons whenever the store is empty. */
    pointer-events: none;
  }
  .empty code { pointer-events: auto; }
  .empty h2 { font-size: 16px; color: var(--ink); margin: 0; }
  .empty code { font-family: var(--mono); font-size: 12px; color: var(--mark); background: var(--stage); padding: 2px 6px; border-radius: 5px; }

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
  .close:hover { background: var(--raised); color: var(--ink); }
  .inspector h2 { font-size: 17px; line-height: 1.3; margin: 13px 0 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .meta .m { font-family: var(--mono); font-size: 10.5px; color: var(--muted); background: var(--stage); border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px; }
  .meta .m b { color: var(--ink); font-weight: 600; }
  .meta .m.warn b { color: var(--c-constraint); }
  .body { padding: 16px 20px; overflow-y: auto; flex: 1; }
  .body .eyebrow { display: block; margin: 0 0 7px; }
  /* Margins only. Everything typographic lives on .content / .reason below -- this rule used to
     set size, colour and white-space too, and being one class more specific it silently beat the
     new reading styles, so none of them rendered. */
  .body .content { margin: 0 0 20px; }
  .body .reason { border-left: 2px solid var(--line); padding-left: 12px; margin: 0 0 20px; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px; }
  .tags span { font-family: var(--mono); font-size: 11px; color: var(--muted); background: var(--stage); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; }
  .ev { display: flex; flex-direction: column; gap: 7px; margin: 0 0 20px; }
  .ev .item { font-size: 12px; color: var(--muted); background: var(--stage); border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; }
  .ev .item .k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); margin-bottom: 3px; }
  .ev .item.stale { border-color: var(--accent-deep); }
  .ev .item.stale .k { color: var(--c-constraint); }
  .timeline { display: flex; flex-direction: column; gap: 0; }
  .timeline .t { position: relative; padding: 0 0 14px 18px; border-left: 1px solid var(--line); }
  .timeline .t:last-child { border-left-color: transparent; }
  .timeline .t::before { content: ""; position: absolute; left: -4px; top: 3px; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
  .timeline .t .when { font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .timeline .t .what { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
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
      <img class="mark" alt="" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAP1BMVEUREhP39/cAAAA0zN4N7vJeXl8fXWWfoKAvuMgxwtMqm6lV//8xwtQ/v78hP0M3vuUAAAAAAAAAAAAAAAAAAAChK0qDAAAAEHRSTlP+/wD5DP/+//GZ/ANoBP8SkfQ8pQAAAw5JREFUeNq1V4mSIyEIJWnRvtL9/3+7gBcqJpmdXasmVaP9HsglwHNY7sU/7txgSQu20znafLnxaxjgB226bRnW5ujbw30iIPh9CmDdwXt/XfQD+ypbp5MP3hCQorcI3z10y++ixv10bk5Al2fp64BOHKzHKZ/ZBIeIn8ELhWuuAVp9Fg8fliihrgEKT+L36xPBRbbYFAMU/Ivx8MVihldhAI338NXymgFy9HyPjww5piD57yf4xPCqBAfbP+NDwBkOQ6gMEL3JBO7plP0evAYWxCAHypIESwQAq7L/I6/KkcCaQBggEsgFqv/xUReaGzEeOKA4c8mDdxt/Sh4DFL6917Lc5Es2xbashrkSQ8Ibpl3Zl1Q72IKmB5XomS8JDDdZYLWOfbVn/A9GFc7nDe5eLQW4fPikA/rFTBO/rDd5wpkpvHDmQ4jyucgsfVyIGdmIm0W+C0ZUEElKheIkpK82CSK6QegsnQjYCqEhUC5+8AGABEHoXe2lLkczsowlekrD490c31aFr3DEIrzukAmorO++h3OQiWVYt/FI50WXJGQ/zMRCkGMGsBKNBDkir7wvii7JhjBkDlaU3vfVkikSEgFWsah1CEkSVutoWq4rKRHUeRUg+xWP+mJQCa6Wtdq+RNwMz0UhE0SxOBBM5KMm8LoWGgQNviXjK9RcrAwNQQMJbZx4rUH2emgJND70hVGSQeVpjmVNUCAqC1XWp1AG7cCSVUh/KXhDmyk1aSEmk1nTa2qESV2WZOpqukERYAJP6TyWRDQ1MJ5MsaFV0oLcu/Ig4qTVgKdZVKMXQvHIA2f9EhVVq6wLQcSDnzPEsm49LEU0++yaMqSHxXjaWp/PGNLTZj2uXWGbMKTHlZ73wYzDk2oykALyvDOLbjD6YjxhqA0Gtzjd22k86cOWanG6JisFkhEbocOXJqtt8+IDOjothNYDZ23zft9o/l2rC/+y2f59u18Gjo9KzAaO34884k33xdBFk9/xv8Y+uYZ7P3i6t4NnHH3dfPS9P42+74fv45vhW4//hWV7M/7/AVG7HQzkICwnAAAAAElFTkSuQmCC" />
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
    <div class="stagehead">
      <span class="eyebrow">Project brain</span>
      <div class="viewswitch" role="tablist">
        <button id="tab-graph" role="tab" aria-selected="true">Graph</button>
        <button id="tab-list" role="tab" aria-selected="false">List</button>
      </div>
      <button id="new-atom" class="primary">+ New memory</button>
    </div>
    <canvas id="graph"></canvas>
    <div class="listwrap" id="listwrap" hidden>
      <div class="lenses" role="tablist">
        <button data-lens="all" class="on" role="tab">All <span class="n" id="n-all"></span></button>
        <button data-lens="unread" role="tab">Unread <span class="n" id="n-unread"></span></button>
        <button data-lens="stale" role="tab">Stale <span class="n" id="n-stale"></span></button>
      </div>
      <table class="atoms"><thead><tr>
        <th><span class="vh">Retrieved</span></th><th>Title</th><th>Category</th><th><span class="vh">Freshness</span></th><th class="num">Age</th><th class="num">Reads</th>
      </tr></thead><tbody id="atomrows"></tbody></table>
      <p class="empty-list" id="listempty" hidden>Nothing matches.</p>
    </div>
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
<dialog id="newdlg"><form id="newform">
  <h2>New memory</h2>
  <label>Category<select name="category">
    <option value="fact">fact</option>
    <option value="decision">decision</option>
    <option value="goal">goal</option>
    <option value="constraint">constraint</option>
    <option value="architecture">architecture</option>
    <option value="state">state</option>
    <option value="skill">skill</option>
  </select></label>
  <label>Title<input name="title" required /></label>
  <label>Content<textarea name="content" rows="12" required></textarea></label>
  <label>Tags<input name="tags" placeholder="comma, separated" /></label>
  <div class="acts"><button type="submit">Save</button>
  <button type="button" id="newcancel">Cancel</button></div>
  <p class="err" id="newerr" hidden></p>
</form></dialog>

<script>
(function () {
  "use strict";
  // Must track the --c-* tokens in :root. These are read by the canvas, the legend, the tooltip,
  // the list rows and the inspector chip; leaving them behind split the palette in half.
  var CAT = {
    decision: "#cab049", architecture: "#b7a0f8", goal: "#85c577",
    constraint: "#f69088", fact: "#21c9ca", state: "#70b6fd", skill: "#e691ca"
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
    // Quotes are escaped too, because this is now used inside an attribute value
    // (data-id on a table row) and not only as element text. Atom fields arrive from
    // agents and from synced teammates, and the CSP here allows inline script, so a value
    // that escapes its attribute would execute.
    return String(s == null ? "" : s)
      // Control characters are stripped here, not merely escaped. md() marks code spans with a
      // NUL placeholder and its comment claimed atom content could not contain one -- it can,
      // JSON round-trips it, and the result rendered as "undefined". Removing them at the
      // escape boundary is what actually makes that placeholder unforgeable.
      .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/g, "")
      .split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;")
      .split('"').join("&quot;").split("'").join("&#39;");
  }
  /**
   * Atom bodies are markdown -- measured on a real store, 70% carry inline code and 53% carry
   * bold -- and this page used to print all of it raw, so most of the memory read as literal
   * asterisks and pipes. This renders the subset that actually occurs.
   *
   * esc() FIRST, markup second. Every branch below builds tags out of text that has already
   * been escaped, so no atom field can introduce an element or an attribute. Do not reorder.
   */
  function md(src) {
    var lines = esc(String(src == null ? "" : src)).split("\\n");
    var out = [], i = 0;

    function inline(s) {
      return s
        // The URL class excludes quotes. It used to be [^)\\s], and one line above used to turn
        // &quot; back into a quote -- so a link whose URL contained a quote closed its own href
        // and added attributes to the anchor. Under this page's CSP an injected onmouseover
        // runs. Nothing un-escapes here now: &quot; already displays as a quote in text.
        .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s"']+)\\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>')
        .replace(/(^|[^a-zA-Z0-9_])\\*\\*([^*]+)\\*\\*/g, "$1<strong>$2</strong>")
        .replace(/(^|[^a-zA-Z0-9_*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
    }

    /**
     * Code spans come out FIRST and go back in LAST, so emphasis can never reach inside one.
     * Running them the other way round mangled the common case: a span holding *args, **kwargs
     * grew an <em> that opened inside the <code> and closed outside it, italicising the rest of
     * the paragraph. 70% of atoms carry inline code, so this is the path that matters.
     */
    function fmt(s) {
      var spans = [];
      var held = s.replace(/(^|[^\\\\])\\u0060([^\\u0060\\n]+)\\u0060/g, function (all, pre, body) {
        spans.push(body);
        // NUL cannot occur in escaped text, so the placeholder is unforgeable by atom content.
        return pre + "\\u0000" + (spans.length - 1) + "\\u0000";
      });
      return inline(held).replace(/\\u0000(\\d+)\\u0000/g, function (all, k) {
        return "<code>" + spans[Number(k)] + "</code>";
      });
    }

    /** A pipe line is only a table when the NEXT line is its separator. */
    function tableAt(k) {
      return /^\\s*\\|/.test(lines[k]) && k + 1 < lines.length && /^\\s*\\|[\\s:|-]+\\|\\s*$/.test(lines[k + 1]);
    }

    while (i < lines.length) {
      var line = lines[i];
      var startedAt = i;

      if (/^\\u0060\\u0060\\u0060/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\\u0060\\u0060\\u0060/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push("<pre><code>" + buf.join("\\n") + "</code></pre>");
        continue;
      }

      var head = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (head) {
        var level = Math.min(6, head[1].length + 2);
        out.push("<h" + level + ">" + fmt(head[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      // A table needs its separator row, otherwise a line that merely contains a pipe is prose.
      if (tableAt(i)) {
        var cells = function (row) {
          return row.replace(/^\\s*\\|/, "").replace(/\\|\\s*$/, "").split("|").map(function (c) { return fmt(c.trim()); });
        };
        var head_ = cells(line);
        i += 2;
        var body = [];
        while (i < lines.length && /^\\s*\\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
        out.push('<div class="tablewrap"><table><thead><tr><th>' + head_.join("</th><th>") + "</th></tr></thead><tbody>" +
          body.map(function (r) { return "<tr><td>" + r.join("</td><td>") + "</td></tr>"; }).join("") +
          "</tbody></table></div>");
        continue;
      }

      var bullet = /^\\s*[-*]\\s+(.*)$/.exec(line);
      if (bullet) {
        var items = [];
        while (i < lines.length) {
          var b = /^\\s*[-*]\\s+(.*)$/.exec(lines[i]);
          if (!b) break;
          items.push("<li>" + fmt(b[1]) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }

      var numbered = /^\\s*\\d+\\.\\s+(.*)$/.exec(line);
      if (numbered) {
        var ordered = [];
        while (i < lines.length) {
          var o = /^\\s*\\d+\\.\\s+(.*)$/.exec(lines[i]);
          if (!o) break;
          ordered.push("<li>" + fmt(o[1]) + "</li>");
          i++;
        }
        out.push("<ol>" + ordered.join("") + "</ol>");
        continue;
      }

      if (!line.trim()) { i++; continue; }

      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\\s*[-*]\\s/.test(lines[i]) && !/^\\s*\\d+\\.\\s/.test(lines[i]) &&
             !/^#{1,6}\\s/.test(lines[i]) && !/^\\u0060\\u0060\\u0060/.test(lines[i]) && !tableAt(i)) {
        para.push(lines[i]); i++;
      }
      out.push("<p>" + fmt(para.join(" ")) + "</p>");
      // Belt and braces. Every branch above advances i, and one of them once did not: a pipe
      // line the table branch declined and the paragraph loop refused spun here forever, inside
      // a synchronous call from openInspector, freezing the tab with no way back.
      if (i === startedAt) i++;
    }
    return out.join("");
  }

  /** Markdown stripped to plain text, for the one-line title in a table row. */
  function plain(src) {
    return esc(String(src == null ? "" : src))
      .replace(/\\u0060/g, "")
      .replace(/\\*\\*/g, "")
      .replace(/^#{1,6}\\s+/, "");
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
    // Boxes of labels already painted this frame. A label that would overlap one of them is
    // dropped rather than drawn on top of it: with hundreds of nodes on screen, overlapping
    // text is not dense, it is illegible, and the reader cannot tell which dot it belongs to.
    var labelBoxes = [];

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
      ctx.strokeStyle = lit ? "rgba(79,216,232," + op + ")" : "rgba(120,190,205," + op + ")";
      ctx.lineWidth = lit ? 1.4 : 1;
      ctx.stroke();
    }

    // nodes
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var color = CAT[n.category] || "#a9c2cb";
      var r = radius(n);
      var dim = 1;
      if (focusSet && !focusSet[n.id]) dim = 0.16;
      else if (searching && !matchesQuery(n)) dim = 0.12;
      var stale = n.freshness && n.freshness !== "fresh";
      if (dimStale && stale && dim === 1) dim = 0.5;

      var x = sx(n), y = sy(n);
      var pulse = reduce ? 0 : Math.sin(t / 34 + i) * 0.5 + 0.5;
      // Glow only carries meaning on the selected atom and its neighbours. Every dot having
      // a halo is what made this read as a screensaver rather than a catalogue.
      var glow = n === selected ? 14 : (focusSet && focusSet[n.id] ? 9 : 0) + pulse * (focusSet ? 2 : 0);

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
        ctx.strokeStyle = "rgba(242,226,196,0.7)";
        ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      }
      if (n === selected) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = "#4fd8e8"; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.globalAlpha = 1;

      var showLabel = showAllLabels || n === selected || n === hovered ||
        (focusSet && focusSet[n.id]) || (searching && matchesQuery(n));
      if (showLabel && dim > 0.3) {
        var label = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
        ctx.font = "11px system-ui, sans-serif";
        var half = ctx.measureText(label).width / 2 + 3;
        var ly = y + r + 12;
        var box = [x - half, ly - 9, x + half, ly + 3];
        var clear = true;
        // Selected and hovered always win: they are what the reader asked to see.
        if (n !== selected && n !== hovered) {
          for (var lb = 0; lb < labelBoxes.length; lb++) {
            var o = labelBoxes[lb];
            if (box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]) { clear = false; break; }
          }
        }
        if (clear) {
        labelBoxes.push(box);
        ctx.globalAlpha = Math.min(1, dim + 0.2);
        ctx.fillStyle = "#faf8f5";
        ctx.textAlign = "center";
        ctx.fillText(label, x, ly);
        ctx.globalAlpha = 1;
        }
      }
    }
  }

  // Guards against a second render loop. Boot starts one, and save() starts one when the
  // store was empty at boot; two would double the physics step per frame.
  var looping = false;
  function frame() {
    looping = true;
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
        // Same reason as the search box: the canvas polls hiddenCat every frame, the table does not.
        renderList();
      });
    }
  }
  function renderStats() {
    // Four boxed numbers were three too many, and one of them was a lie by omission: "Links"
    // counts edges in a graph this page synthesises, which tells a reader nothing about their
    // memory. What is worth standing at the bottom of the rail is the state of the store --
    // how much of it is active, how much has gone stale, and how much nothing has ever read,
    // because that last number is the one that asks you to do something.
    var active = 0, stale = 0, unread = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].status !== "active") continue;
      active++;
      if (nodes[i].freshness && nodes[i].freshness !== "fresh") stale++;
      if (readCount(nodes[i]) === 0) unread++;
    }
    var html =
      '<div class="tally"><span class="n">' + active + '</span><span class="k">active</span></div>' +
      '<div class="tally"><span class="n">' + stale + '</span><span class="k">stale</span></div>' +
      '<div class="tally unread"><span class="n">' + unread + '</span><span class="k">never read</span></div>';
    document.getElementById("stats").innerHTML = html;
  }

  // ---- inspector ----
  function openInspector(n) {
    selected = n;
    var color = CAT[n.category] || "#a9c2cb";
    var stale = n.freshness && n.freshness !== "fresh";
    var meta = [];
    meta.push('<span class="m">status <b>' + esc(n.status) + '</b></span>');
    meta.push('<span class="m' + (stale ? " warn" : "") + '">freshness <b>' + esc(n.freshness) + '</b></span>');
    if (n.confidence != null) meta.push('<span class="m">confidence <b>' + Math.round(n.confidence * 100) + '%</b></span>');
    meta.push('<span class="m">degree <b>' + n.degree + '</b></span>');
    if (n.updatedAt) meta.push('<span class="m">updated <b>' + esc(String(n.updatedAt).slice(0, 10)) + '</b></span>');
    meta.push('<span class="m' + (readCount(n) === 0 ? " warn" : "") + '">retrieved <b>' +
      (readCount(n) === 0 ? "never" : readCount(n) + "×") + '</b></span>');

    var tagHtml = n.tags.length
      ? '<span class="eyebrow">Tags</span><div class="tags">' + n.tags.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join("") + '</div>'
      : "";
    var reasonHtml = n.reasoning ? '<span class="eyebrow">Reasoning</span><div class="reason">' + md(n.reasoning) + '</div>' : "";

    inspector.innerHTML =
      '<span class="gutter' + (readCount(n) === 0 ? ' never' : '') + '"></span>' +
      '<div class="top">' +
        '<div class="row">' +
          '<span class="chip" style="color:' + color + '"><span class="dot" style="background:' + color + '"></span>' + esc(n.category) + '</span>' +
          '<button class="close" id="ins-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<h2>' + plain(n.title) + '</h2>' +
        '<div class="meta">' + meta.join("") + '</div>' +
      '</div>' +
      '<div class="body">' +
        '<span class="eyebrow">Content</span>' +
        '<div class="content">' + md(n.content) + '</div>' +
        reasonHtml +
        tagHtml +
        '<span class="eyebrow">Evidence</span><div class="ev" id="ins-ev"><p class="muted-note">Loading evidence.</p></div>' +
        '<span class="eyebrow">Timeline</span><div class="timeline" id="ins-tl"><p class="muted-note">Loading history.</p></div>' +
        '<div class="acts">' +
          '<button id="ins-edit">Edit</button>' +
          (n.status === "archived"
            ? '<button id="ins-restore">Restore</button>'
            : '<button id="ins-archive" class="danger">Archive</button>') +
        '</div>' +
        '<form class="editform" id="ins-form" hidden>' +
          '<label>Title<input name="title" required /></label>' +
          '<label>Content<textarea name="content" rows="12" required></textarea></label>' +
          '<label>Reasoning<textarea name="reasoning" rows="4"></textarea></label>' +
          '<label>Tags<input name="tags" placeholder="comma, separated" /></label>' +
          '<label>Category<select name="category">' +
            CAT_ORDER.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join("") +
          '</select></label>' +
          '<label>Confidence<input name="confidence" type="number" min="0" max="1" step="0.05" /></label>' +
          '<div class="acts"><button type="submit">Save</button>' +
          '<button type="button" id="ins-cancel">Cancel</button></div>' +
          '<p class="err" id="ins-err" hidden></p>' +
        '</form>' +
      '</div>';

    inspector.classList.add("open");
    inspector.setAttribute("aria-hidden", "false");
    document.getElementById("ins-close").addEventListener("click", closeInspector);

    var editForm = document.getElementById("ins-form");
    document.getElementById("ins-edit").addEventListener("click", function () {
      editForm.title.value = n.title || "";
      editForm.content.value = n.content || "";
      editForm.reasoning.value = n.reasoning || "";
      editForm.tags.value = (n.tags || []).join(", ");
      editForm.category.value = n.category;
      editForm.confidence.value = n.confidence === null || n.confidence === undefined ? "" : n.confidence;
      editForm.hidden = false;
      editForm.title.focus();
    });
    document.getElementById("ins-cancel").addEventListener("click", function () { editForm.hidden = true; });

    editForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var patch = {
        title: editForm.title.value.trim(),
        content: editForm.content.value,
        reasoning: editForm.reasoning.value.trim() || null,
        tags: editForm.tags.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean),
        category: editForm.category.value
      };
      if (editForm.confidence.value !== "") patch.confidence = Number(editForm.confidence.value);
      save("/api/atoms/" + encodeURIComponent(n.id), "PATCH", patch, "ins-err");
    });

    var archiveButton = document.getElementById("ins-archive");
    if (archiveButton) {
      archiveButton.addEventListener("click", function () {
        // Reversible, so it asks once rather than making anybody retype the title. Restore is
        // on the same panel the moment it is archived.
        if (!window.confirm('Archive "' + n.title + '"? It stops appearing in queries, and you can restore it.')) return;
        save("/api/atoms/" + encodeURIComponent(n.id) + "/archive", "POST", undefined, "ins-err", n.id);
      });
    }
    var restoreButton = document.getElementById("ins-restore");
    if (restoreButton) {
      restoreButton.addEventListener("click", function () {
        save("/api/atoms/" + encodeURIComponent(n.id) + "/restore", "POST", undefined, "ins-err", n.id);
      });
    }

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
      tooltip.innerHTML = '<div class="cat" style="color:' + (CAT[hit.category] || "#a9c2cb") + '">' + esc(hit.category) + '</div>' + plain(hit.title);
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

  // The canvas re-reads query every frame, so it needed no redraw call. The table does.
  document.getElementById("search").addEventListener("input", function () { query = this.value.trim(); renderList(); });
  document.getElementById("tg-labels").addEventListener("change", function () { showAllLabels = this.checked; });
  document.getElementById("tg-stale").addEventListener("change", function () { dimStale = this.checked; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeInspector(); });
  window.addEventListener("resize", resize);

  function fetchJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }

  // ---- writes ----
  function showError(slotId, message) {
    var slot = document.getElementById(slotId);
    if (slot) { slot.textContent = message; slot.hidden = false; }
    else window.alert(message);
  }

  function save(path, method, body, errorSlot, keepOpenFor) {
    // Cleared on the way in, not only on success. Otherwise a retry that SUCCEEDS still sees a
    // stale error, the dialog stays open, and the obvious response is to press Save again --
    // which writes a second atom.
    var slot = document.getElementById(errorSlot);
    if (slot) { slot.hidden = true; slot.textContent = ""; }
    return fetch(path, {
      method: method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload.error || ("Request failed: " + response.status));
        });
      }
      // Re-fetch rather than splicing the row in place. The store computes contentHash,
      // freshness and updatedAt on write, so a locally patched row would disagree with the
      // database in exactly the fields the list sorts and filters on.
      return fetchJSON("/api/graph").then(function (data) {
        var fresh = data.nodes || [];
        for (var i = 0; i < fresh.length; i++) {
          var was = byId[fresh[i].id];
          // Positions carry across by id. Rebuilding them would make the graph jump on every
          // save, which reads as the edit having changed the shape of the knowledge rather
          // than one atom's text.
          if (was) {
            fresh[i].x = was.x; fresh[i].y = was.y; fresh[i].vx = was.vx; fresh[i].vy = was.vy;
          } else {
            fresh[i].x = (Math.random() - 0.5) * 420; fresh[i].y = (Math.random() - 0.5) * 420;
            fresh[i].vx = 0; fresh[i].vy = 0;
          }
        }
        nodes = fresh;
        links = data.links || [];
        // Rebuilt rather than preserved: links derive from tags and category, so editing
        // either changes them, and a stale adj asserts a relationship the store no longer holds.
        byId = {}; adj = {};
        for (var j = 0; j < nodes.length; j++) { byId[nodes[j].id] = nodes[j]; adj[nodes[j].id] = []; }
        for (var k = 0; k < links.length; k++) {
          var l = links[k];
          if (adj[l.source]) adj[l.source].push(l.target);
          if (adj[l.target]) adj[l.target].push(l.source);
        }
        renderLegend(); renderStats(); renderList();
        // Boot returns before starting the render loop when the store is empty, so the very
        // first atom would otherwise leave the graph blank and "Empty brain" on screen until a
        // reload. Start it here if it was never started.
        document.getElementById("empty").hidden = nodes.length > 0;
        if (nodes.length && !looping) { fit(); frame(); }
        // A new atom spawns at a random position, and by now alpha is below the freeze
        // threshold, so without reheating the layout it never actually gets placed.
        reheat(0.35);
        // Reopen rather than close when the atom still exists. Archiving closed the panel and
        // the row then failed the active filter, so the Restore button this promises was
        // unreachable without hunting for a dot in the graph.
        var still = byId[keepOpenFor];
        if (still) openInspector(still); else closeInspector();
      });
    }).catch(function (error) {
      // A write that fails where nobody sees it is worse than one that refuses loudly: the
      // user walks away believing the correction landed.
      showError(errorSlot, error.message);
    });
  }

  // ---- list ----
  var reads = {};
  var readsFailed = false;
  var lens = "all";

  function ageDays(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  // Absent from /api/reads means never retrieved. There is no stored zero.
  function readCount(item) { return reads[item.id] || 0; }

  function inLens(item) {
    if (lens === "unread") return readCount(item) === 0;
    if (lens === "stale") return item.freshness !== "fresh";
    return true;
  }

  // Everything except the lens. The lens tabs count within THIS set, so a badge can never
  // disagree with the table it sits above -- "All 137" over four visible rows is a badge
  // describing a store the user is not looking at.
  function passesFilters(item) {
    if (item.status !== "active") return false;
    if (hiddenCat[item.category]) return false;
    var q = query.toLowerCase();
    if (!q) return true;
    return (item.title + " " + (item.tags || []).join(" ")).toLowerCase().indexOf(q) >= 0;
  }

  function listRows() {
    return nodes.filter(function (item) {
      // nodes carries every status -- buildGraph does not filter -- so this is load-bearing.
      return passesFilters(item) && inLens(item);
    }).sort(function (a, b) {
      // Unread sorts oldest-first: the longest-ignored atom is the likeliest dead weight and
      // the one somebody scrolling would otherwise never reach.
      var l = String(a.updatedAt || ""), r = String(b.updatedAt || "");
      return lens === "unread" ? l.localeCompare(r) : r.localeCompare(l);
    });
  }

  function renderList() {
    // The table is rebuilt from scratch with a listener per row, and the search box fires on
    // every keystroke. Skip it while the graph is showing; setView re-renders on the way in.
    if (activeView !== "list") return;
    var rows = listRows();
    var body = document.getElementById("atomrows");
    if (!body) return;
    body.innerHTML = rows.map(function (item, index) {
      var age = ageDays(item.updatedAt);
      var n = readCount(item);
      // The attribute carries OUR row index, never the atom's id. Ids are not ours to trust:
      // importKnowledge writes entry.item.id verbatim from a JSONL file and knowl cloud
      // receive routes through it, so an imported dump or a teammate's send can carry an
      // arbitrary string. esc() escapes quotes as well now, but the safest attribute is one
      // that never holds foreign data at all.
      return '<tr data-i="' + index + '"' + (n === 0 ? ' class="never"' : '') + '>' +
        '<td class="g"><i></i></td>' +
        '<td class="t">' + plain(item.title) + "</td>" +
        '<td class="cat"><span class="dot" style="background:' + (CAT[item.category] || "#a9c2cb") + '"></span>' + esc(item.category) + "</td>" +
        '<td>' + (item.freshness === "fresh" ? "" : esc(item.freshness)) + "</td>" +
        '<td class="num">' + (age === null ? "&mdash;" : age + "d") + "</td>" +
        '<td class="num' + (n === 0 ? " zero" : "") + '">' + (n === 0 ? "&mdash;" : n) + "</td>" +
      "</tr>";
    }).join("");
    var emptyNote = document.getElementById("listempty");
    emptyNote.hidden = rows.length > 0;
    // Say so rather than letting the lens assert something false about the whole store.
    emptyNote.textContent = readsFailed && lens === "unread"
      ? "Read counts are unavailable, so this lens cannot be trusted."
      : "Nothing matches.";

    var visible = nodes.filter(passesFilters);
    document.getElementById("n-all").textContent = visible.length;
    document.getElementById("n-unread").textContent = visible.filter(function (i) { return readCount(i) === 0; }).length;
    document.getElementById("n-stale").textContent = visible.filter(function (i) { return i.freshness !== "fresh"; }).length;

    var trs = body.querySelectorAll("tr");
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener("click", function () {
        var item = rows[Number(this.getAttribute("data-i"))];
        if (item) openInspector(item);
      });
    }
  }

  // Deliberately NOT named view. That name is already the pan/zoom transform declared above,
  // and shadowing it made sx() and sy() return NaN, so the canvas rendered nothing at all
  // while the rail and its counts looked perfectly healthy.
  var activeView = "graph";
  function setView(next) {
    var isList = next === "list";
    activeView = next;
    document.getElementById("listwrap").hidden = !isList;
    document.getElementById("graph").hidden = isList;
    document.getElementById("tab-list").setAttribute("aria-selected", String(isList));
    document.getElementById("tab-graph").setAttribute("aria-selected", String(!isList));
    if (isList) { renderList(); return; }
    // A hidden canvas measures 0x0, so any resize while the list was showing set the backing
    // store to zero and the graph came back blank until the window was resized again.
    resize();
    reheat(0.02);
  }

  // A native dialog gives focus trapping, Esc-to-close and the backdrop without a library.
  var newDialog = document.getElementById("newdlg");
  var newForm = document.getElementById("newform");
  document.getElementById("new-atom").addEventListener("click", function () {
    document.getElementById("newerr").hidden = true;
    newDialog.showModal();
  });
  document.getElementById("newcancel").addEventListener("click", function () { newDialog.close(); });
  newForm.addEventListener("submit", function (event) {
    event.preventDefault();
    save("/api/atoms", "POST", {
      category: newForm.category.value,
      title: newForm.title.value.trim(),
      content: newForm.content.value,
      tags: newForm.tags.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean)
    }, "newerr").then(function () {
      // Only clear on success -- closing a dialog that refused the write would throw the
      // text away along with the reason it was refused.
      if (document.getElementById("newerr").hidden) { newDialog.close(); newForm.reset(); }
    });
  });

  document.getElementById("tab-graph").addEventListener("click", function () { setView("graph"); });
  document.getElementById("tab-list").addEventListener("click", function () { setView("list"); });
  var lensButtons = document.querySelectorAll(".lenses button");
  for (var li = 0; li < lensButtons.length; li++) {
    lensButtons[li].addEventListener("click", function () {
      lens = this.getAttribute("data-lens");
      for (var lj = 0; lj < lensButtons.length; lj++) {
        lensButtons[lj].classList.toggle("on", lensButtons[lj] === this);
      }
      renderList();
    });
  }

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
    // Read counts drive the Unread lens. Fetched before the empty-store early return so an
    // empty list still renders its own empty state rather than only the graph's.
    // renderStats() too: it counts never-read atoms, and it runs synchronously below while the
    // read map is still empty -- so without this the rail claimed every atom in the store had
    // never been retrieved. Measured wrong by 3x on a real store, on the one number the whole
    // design argues from.
    fetchJSON("/api/reads").then(function (r) { reads = r || {}; renderList(); renderStats(); }, function () {
      // Without this the rejection is unhandled, reads stays empty, and every atom reports
      // zero -- so the Unread lens quietly claims the entire store has never been read.
      reads = {};
      readsFailed = true;
      renderList();
      renderStats();
    });
    if (!nodes.length) { document.getElementById("empty").hidden = false; return; }
    renderLegend();
    renderStats();
    // settle off-screen so the graph opens calm, then frame it and let it freeze
    for (var s = 0; s < 240; s++) step();
    alpha = 0.05;
    fit();
    frame();


    // knowl edit <id> deep-links here. Open the row rather than leaving somebody to hunt for
    // a dot in a physics simulation, which is the whole reason that command exists.
    var wanted = /^#[/]atom[/](.+)$/.exec(window.location.hash || "");
    if (wanted) {
      var target = byId[decodeURIComponent(wanted[1])];
      if (target) { setView("list"); openInspector(target); }
    }
  });
})();
</script>
</body>
</html>`;
