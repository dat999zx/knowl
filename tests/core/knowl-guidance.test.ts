import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KNOWL_CLAUDE_CONTINUATION_REMINDER,
  KNOWL_CLAUDE_MODE_LINE,
  KNOWL_CLAUDE_OPERATIONAL_CARD,
  KNOWL_CLAUDE_PROMPT_REMINDER,
  KNOWL_HOST_NEUTRAL_MODE_LINE,
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_SERVER_KEY,
  KNOWL_MCP_TOOL_GROUPS,
  KNOWL_MCP_TOOL_NAMES,
  KNOWL_NAMESPACED_TOOL_PREFIX,
  KNOWL_SUBAGENT_BOOTSTRAP_CARD,
  renderFullKnowlGuidance,
  renderManagedKnowlGuidanceSection,
} from '../../src/core/knowl-guidance.js';
import { mergeCodexTomlConfig, mergeJsonMcpConfig } from '../../src/cli/agents/files.js';

const EXPECTED_TOOLS = [
  'knowl_query',
  'knowl_recent', 'knowl_state', 'knowl_context',
  'knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish',
  'knowl_store', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update',
  'knowl_timeline', 'knowl_evidence_list', 'knowl_conflicts', 'knowl_drift', 'knowl_feedback',
  'knowl_skill_list', 'knowl_skill_read', 'knowl_skill_run', 'knowl_skill_create',
  'knowl_ingest', 'knowl_synthesize', 'knowl_session_finish', 'knowl_gc_preview', 'knowl_gc_apply',
  'knowl_handoff',
  'knowl_park', 'knowl_resume',
] as const;

const EXPECTED_CLAUDE_CARD = [
  'KNOWL WORKFLOW - for project work.',
  'Start: use a relevant active lifecycle hit; else call knowl_query with the words that name the subject before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are absent, stop and tell the user.',
  'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.',
  'Manual fallback: knowl task run for one bounded command; resumable work uses knowl_task_start once, knowl_task_checkpoint at milestones or blockers with its taskId, and knowl_task_finish once after verification.',
  'Route by what you need; the tool list names them:',
  '- retrieval: knowl_query first. Recent context only without bootstrap or for a refresh, broad state for status, a packed context only when a token budget is given.',
  '- durable memory: store one verified atom, batch several, record a confirmed decision, a stated goal, or a recurring diagnosis, or correct a stale one. Correct rather than duplicate.',
  '- audit: inspect history, evidence or conflicts when needed; record feedback only after actual use or correction.',
  '- skills: read a matching skill before running a trusted entrypoint; create one only on explicit request.',
  '- special: raw-source ingest only on an explicit request, never silent chat; synthesis only for an explicit scope; preview garbage collection first and apply only after approval.',
  '- leaving work: one baton the next session here consumes once, or a key the user keeps and hands back any time later, from anywhere.',
  'During work, store durable findings, stated intent, and recurring diagnoses — a goal counts before it settles; never raw transcripts, secrets, or routine command noise.',
].join('\n');

const namesIn = (text: string) => [...new Set(text.match(/\bknowl_[a-z_]+\b/g) ?? [])].sort();

/**
 * The only tool names the compact card is required to carry.
 *
 * `knowl_query` because "call this first, before files" is sequencing *across* tools, which no
 * single tool's description can state. The lifecycle four because "never call these while hooks
 * are active" is a prohibition, and a tool's own description is the last place a caller looks
 * for one.
 *
 * Everything else is deliberately absent -- see the note on `renderCompactKnowlGuidance`.
 */
const CARD_MUST_NAME = [
  'knowl_query',
  'knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish', 'knowl_session_finish',
] as const;

/** Every routing group the compact card has to cover, and a phrase that proves it does. */
const CARD_MUST_ROUTE: Array<[string, RegExp]> = [
  ['retrieval', /retrieval:/],
  ['durable memory', /durable memory:/],
  ['audit', /audit:/],
  ['skills', /skills:/],
  ['special', /special:/],
  ['leaving work', /leaving work:/],
];

describe('canonical Knowl agent guidance', () => {
  it('defines nine groups and the exact 28-tool inventory', () => {
    expect(KNOWL_MCP_TOOL_GROUPS).toHaveLength(9);
    expect(KNOWL_MCP_TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(new Set(KNOWL_MCP_TOOL_NAMES).size).toBe(28);
    expect(KNOWL_MCP_TOOL_NAMES).not.toContain('knowl_ask');
  });

  it('renders every tool into the full guidance, which is where the inventory belongs', () => {
    // The full guidance is written once per repo as a file, not paid per session, so it can
    // afford to name everything -- and it is the right place for someone to look one up.
    expect(namesIn(renderFullKnowlGuidance())).toEqual([...EXPECTED_TOOLS].sort());
    expect(renderManagedKnowlGuidanceSection()).toContain('<!-- KNOWL_PROJECT_MEMORY -->');
    expect(renderFullKnowlGuidance()).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(renderFullKnowlGuidance()).toContain('Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.');
    expect(renderFullKnowlGuidance()).toContain('never send the current conversation silently');
    expect(renderFullKnowlGuidance()).toContain('never a hook session');
  });

  it('carries policy in the compact card, not an inventory', () => {
    // The card used to name all 27 tools, which made it grow with the inventory until it sat
    // six characters under the ceiling. Measured against that: the same MCP handshake already
    // delivers tools/list -- 22,394 characters including every name and 6,195 of descriptions.
    // Names are not what an agent lacks; sequencing and prohibitions are.
    for (const card of [KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS]) {
      // Only the names that carry policy a description cannot.
      for (const required of CARD_MUST_NAME) expect(card).toContain(required);

      // No name may appear that is not a real tool -- a card naming something the server does
      // not expose sends the agent looking for a tool that is not there.
      for (const named of namesIn(card)) expect(EXPECTED_TOOLS).toContain(named);

      // Every capability still has to be routable, or a group silently drops out of guidance
      // the moment someone shortens a line to buy room.
      for (const [group, pattern] of CARD_MUST_ROUTE) {
        expect(card, `card lost routing for "${group}"`).toMatch(pattern);
      }
    }
  });

  it('does not grow when a tool is added, only when a capability is', () => {
    // The property that replaced the every-name assertion. 22 of 27 tools are unnamed here by
    // design, so a 28th within an existing group costs the card nothing.
    const named = namesIn(KNOWL_MCP_SERVER_INSTRUCTIONS);
    expect(named.length).toBeLessThan(EXPECTED_TOOLS.length);
    expect(named.sort()).toEqual([...CARD_MUST_NAME].sort());
  });

  it('keeps both compact renderings bounded and front-loads the required action', () => {
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toBe(EXPECTED_CLAUDE_CARD);
    // The binding limit is the transcript-enabled card in tests/transcripts/mcp-gating.test.ts,
    // which carries one more line. Check that budget first.
    //
    // These lengths are pinned so a change to the card is deliberate, not so they must never
    // move. What must not move is the *shape*: the card no longer scales with the tool count
    // (see 'does not grow when a tool is added'), so a new tool inside an existing group should
    // leave both numbers untouched. If adding a tool changes them, something re-introduced the
    // inventory the card stopped carrying.
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toHaveLength(1_828);
    expect(KNOWL_MCP_SERVER_INSTRUCTIONS).toHaveLength(1_879);
    for (const card of [KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS]) {
      expect(card.length).toBeLessThan(2_000);
      expect(card.slice(0, 512)).toContain('knowl_query');
      expect(card.slice(0, 512)).toContain('own lifecycle');
      expect(Math.ceil(card.length / 4)).toBeLessThanOrEqual(500);
      expect(20 * Math.ceil(card.length / 4)).toBeLessThanOrEqual(10_000);
    }
  });

  /**
   * The guidance used to say "2-6 keywords" in six places. A ground-truth ablation over the
   * project's own suites refuted it: truncating the suites' own over-length queries to six
   * words cost 4.7pp hit@1 on retrieval-suite-v2 (n=63) and 7.2pp on retrieval-suite (n=97),
   * while padding a compliant query with three off-subject words cost 24-37pp. Count is not
   * the variable; on-subject-ness is, and a numeric cap taught agents to trim real terms.
   * Measured against 921 real knowl_query calls in the local transcript archive, 26.6% were
   * over the cap and the mean sat at 5.75 words -- the cap was binding on live behaviour.
   *
   * See docs/evals/agent-surface.md. Pinned because a plausible-sounding number is exactly the
   * kind of thing that gets re-added by someone tightening prose.
   */
  it('never states a numeric keyword cap, in any surface that reaches an agent', () => {
    const surfaces = [
      KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS,
      KNOWL_SUBAGENT_BOOTSTRAP_CARD, KNOWL_CLAUDE_PROMPT_REMINDER,
      KNOWL_CLAUDE_CONTINUATION_REMINDER, renderFullKnowlGuidance(),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toMatch(/\d+\s*-\s*\d+\s+(concise\s+)?keywords/i);
      expect(surface).not.toMatch(/keywords\)/i);
    }
    // And the replacement is actually present where the rule has to land.
    expect(renderFullKnowlGuidance()).toMatch(/on-subject/);
    for (const card of [KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_SUBAGENT_BOOTSTRAP_CARD]) {
      expect(card).toMatch(/words that name the subject/);
    }
  });

  /**
   * Storage guidance must name stated intent, not only verified findings.
   *
   * Grounded in a live failure, not taste: an agent following these cards faithfully skipped
   * storing two strategy conversations (2026-08-10) — the user's declared plan for a whole
   * venture — because every storage cue said "verified" and a conversation verifies nothing.
   * The user had to notice the gap and request the save manually. The goal category and
   * user_stated provenance exist for exactly this content; guidance that never mentions them
   * teaches agents to leave intent unstored until it is too late to recover.
   *
   * Pinned for the same reason the keyword-cap test above is: "verified durable findings" is
   * precisely the kind of tight phrase someone re-introduces while shortening a line to buy
   * room, and the omission it causes is invisible until a user is annoyed.
   *
   * The diagnosis half is pinned with its qualifier, not just its class name. Recurrence is the
   * axis that predicts value, and "resolved" is not it: a typo is resolved too, and rule 5
   * excludes it by name. A cue reading only "resolved diagnoses" would summarise the rule as its
   * own counterexample, so each surface has to say *which* diagnoses — the recurring ones. The
   * compact cards get this wrong the moment someone drops an adjective to buy back characters,
   * which is the same pressure that produced the original omission.
   */
  it('names stated intent and recurring diagnoses as storable in every storage cue that reaches an agent', () => {
    const recurrence = /recurring diagnos|diagnosis whose cause will recur/;
    for (const surface of [
      KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS,
      KNOWL_CLAUDE_PROMPT_REMINDER, KNOWL_CLAUDE_CONTINUATION_REMINDER,
    ]) {
      expect(surface).toMatch(/stated (intent|goal)/);
      expect(surface).toMatch(recurrence);
    }
    // The full guidance names the mechanism, not just the class: which category, which
    // provenance, and the recovery test that decides.
    expect(renderFullKnowlGuidance()).toContain('user_stated');
    expect(renderFullKnowlGuidance()).toContain('could a fresh session recover this from memory alone?');
    expect(renderFullKnowlGuidance()).toContain('resolved diagnoses stored as skills');
    // The subagent card stays intent-free — a subagent receives a bounded task, not a user
    // conversation — but it does debug, so diagnoses are in its storable class too.
    expect(KNOWL_SUBAGENT_BOOTSTRAP_CARD).toMatch(recurrence);
  });

  /**
   * Listed-but-not-callable has to be distinguishable from unavailable.
   *
   * Grounded in a live failure, not taste: a Claude Code session (2026-08-16) listed all of
   * knowl's tools by name under "schemas are NOT loaded -- calling them directly will fail",
   * and reaching `knowl_query` first cost a schema-load round-trip that rule 6 did not describe.
   * Rule 6 read "if Knowl MCP tools are unavailable, stop and tell the user", which an agent
   * looking at a list of uncallable tools can reasonably read as its own case -- and the
   * instructed response to that case is to stop using Knowl.
   *
   * The subagent card already had this line, because a subagent is dispatched into exactly that
   * shape. It is the same failure in the main session and it wants the same sentence.
   */
  it('tells an agent that listed-but-not-callable tools are loadable, not unavailable', () => {
    const guidance = renderFullKnowlGuidance();
    expect(guidance).toMatch(/listed but not callable is not unavailable/i);
    expect(guidance).toMatch(/load the schema/i);
    // The bare name does not resolve on a namespacing host, so the rule prints the form that does.
    expect(guidance).toContain(`${KNOWL_NAMESPACED_TOOL_PREFIX}knowl_query`);
    // Unchanged: the genuine-absence half of the rule still has to survive the rewrite.
    expect(guidance).toMatch(/stop and tell the user/i);
    // The subagent card is the surface this was generalised from; it must not regress.
    expect(KNOWL_SUBAGENT_BOOTSTRAP_CARD).toMatch(/listed but not callable/i);
  });

  /**
   * The printed name must be built from the written one.
   *
   * This is a known defect class in this project: a surface that PRINTS an identifier drifts
   * from the identifier that actually resolves, because nothing joins the two halves. It has
   * already happened twice with CLI command names. A namespaced tool name is the same shape --
   * derived from the MCP registration key, which lives in the config writers -- so the prefix is
   * derived from one exported constant and asserted against what the writers actually emit.
   */
  it('derives the namespaced tool prefix from the key the config writers register', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-mcp-key-'));
    const entry = { command: 'knowl', args: ['serve'] };

    try {
      const jsonPath = path.join(directory, '.mcp.json');
      await mergeJsonMcpConfig(jsonPath, entry);
      const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      expect(Object.keys(json.mcpServers)).toEqual([KNOWL_MCP_SERVER_KEY]);

      const tomlPath = path.join(directory, 'config.toml');
      await mergeCodexTomlConfig(tomlPath, entry);
      expect(await fs.readFile(tomlPath, 'utf8')).toContain(`[mcp_servers.${KNOWL_MCP_SERVER_KEY}]`);

      // Deliberately NOT `expect(PREFIX).toBe(\`mcp__${KNOWL_MCP_SERVER_KEY}__\`)`. That restates
      // the definition, so it cannot fail -- proven by mutation: renaming the constant left this
      // whole file passing while the guidance rendered a name nothing registers. Read the key
      // back off the config that was actually written, and assert the guidance prints THAT.
      const written = Object.keys(json.mcpServers)[0];
      expect(renderFullKnowlGuidance()).toContain(`mcp__${written}__knowl_query`);
      expect(KNOWL_NAMESPACED_TOOL_PREFIX).toBe(`mcp__${written}__`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('changes only the lifecycle mode line between compact renderings', () => {
    expect(
      KNOWL_CLAUDE_OPERATIONAL_CARD.replace(KNOWL_CLAUDE_MODE_LINE, KNOWL_HOST_NEUTRAL_MODE_LINE),
    ).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('documents every canonical MCP tool in the full reference', async () => {
    const reference = await fs.readFile(path.resolve('docs/reference.md'), 'utf8');
    const documentedTools = [...reference.matchAll(/^\| `(knowl_[a-z_]+)` \|/gm)]
      .map(match => match[1]);
    expect(documentedTools).toEqual([...KNOWL_MCP_TOOL_NAMES]);
    expect(new Set(documentedTools).size).toBe(28);
    expect(reference).toContain('KNOWL.md');
    // The instruction files Knowl actually writes. `GEMINI.md` was here until the Gemini CLI
    // adapter was retired; a doc-coverage assertion that outlives the thing it covers keeps
    // passing on prose nobody reads and starts failing only when the prose is finally correct.
    expect(reference).toContain('AGENTS.md');
    expect(reference).toContain('CLAUDE.md');
    // The reference names the command generically now, because four hosts declare a prompt
    // event rather than one. Pinning `agent-reminder claude` would have kept the docs describing
    // Claude as the only host that gets a per-turn card long after that stopped being true.
    expect(reference).toContain('agent-reminder <host>');
    expect(reference).toContain('previewed maintenance after explicit approval');
  });

  it('keeps the README delegating to the full reference it summarizes', async () => {
    const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
    const reference = await fs.readFile(path.resolve('docs/reference.md'), 'utf8');
    // The README links deep into the reference; a renamed section there must not
    // silently leave the front door pointing at an anchor that no longer exists.
    //
    // Each space becomes its own hyphen -- `\s` and not `\s+`. GitHub strips the punctuation
    // between two words and leaves both surrounding spaces, so `A — B` anchors as `a--b` with
    // two hyphens, which is what `#seeing-what-exists-and-what-is-on--knowl-config-list` in this
    // file's own table of contents has always relied on. Collapsing the run instead produced a
    // slug GitHub never generates, so a correct README link to any em-dashed heading read as
    // broken. Latent until one existed: every README anchor pointed at a punctuation-free
    // heading, so the two models agreed everywhere it was tested.
    const slugs = new Set(
      [...reference.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match =>
        match[1].toLowerCase().trim().replace(/`/g, '').replace(/[^\w\s-]/g, '').replace(/\s/g, '-'),
      ),
    );
    // Pinned directly rather than only through whatever the README happens to link today, so the
    // double-hyphen rule stays checked even in a release where no front-door link uses one.
    expect(slugs.has('seeing-what-exists-and-what-is-on--knowl-config-list')).toBe(true);
    const anchors = [...readme.matchAll(/docs\/reference\.md#([a-z0-9-]+)/g)].map(match => match[1]);
    expect(anchors.length).toBeGreaterThan(10);
    expect(anchors.filter(anchor => !slugs.has(anchor))).toEqual([]);
    expect(readme).toContain('](docs/reference.md)');
  });

  /**
   * The sibling test above pins the cap out of the six `src/` constants. That sweep counted
   * eight places and all eight were source, so the README went on telling readers to "query
   * with two to six keywords" after the rule had been refuted and removed everywhere else.
   * Prose is an agent-facing surface too: KNOWL.md is installed into projects verbatim, and
   * the README is where a human reads the workflow before writing it into their own guidance.
   * Spelled-out numbers are checked because that is the form that survived.
   */
  it('never states a numeric keyword cap in the prose docs either', async () => {
    const digits = /\d+\s*(?:-|–|to)\s*\d+\s+(?:concise\s+)?keywords/i;
    const words = /(?:one|two|three|four|five|six|seven|eight)\s+to\s+(?:one|two|three|four|five|six|seven|eight)\s+keywords/i;
    for (const file of ['README.md', 'KNOWL.md', 'docs/reference.md']) {
      const text = await fs.readFile(path.resolve(file), 'utf8');
      expect(text, `${file} states a numeric keyword cap`).not.toMatch(digits);
      expect(text, `${file} states a numeric keyword cap`).not.toMatch(words);
    }
    // And the replacement actually landed in the README's workflow summary.
    const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
    expect(readme).toMatch(/words that name the subject/);
  });
});

describe('workspace guidance', () => {
  it('tells agents what a repo label means, in the surfaces that reach them', () => {
    // The MCP instructions block does not reach subagents -- probed, which is why the
    // bootstrap card exists. These two are the surfaces that do.
    for (const text of [renderFullKnowlGuidance(), KNOWL_SUBAGENT_BOOTSTRAP_CARD]) {
      expect(text).toMatch(/repo/i);
      expect(text).toMatch(/not necessarily this one|describes \*\*that\*\* repo/i);
    }
  });

  it('names the command that shares knowledge across repos', () => {
    expect(renderFullKnowlGuidance()).toContain('knowl workspace promote');
  });

  it('explains the repos filter matches the owning repo', () => {
    expect(renderFullKnowlGuidance()).toMatch(/repos: \["<name>"\]/);
  });

  it('keeps the subagent card to a single paragraph', () => {
    // Charged to every subagent on every dispatch, so growth has to stay deliberate.
    expect(KNOWL_SUBAGENT_BOOTSTRAP_CARD.split('\n').length).toBe(1);
    expect(KNOWL_SUBAGENT_BOOTSTRAP_CARD.length).toBeLessThan(1000);
  });
});
