import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_CLAUDE_CONTINUATION_REMINDER,
  KNOWL_CLAUDE_MODE_LINE,
  KNOWL_CLAUDE_OPERATIONAL_CARD,
  KNOWL_CLAUDE_PROMPT_REMINDER,
  KNOWL_HOST_NEUTRAL_MODE_LINE,
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_GROUPS,
  KNOWL_MCP_TOOL_NAMES,
  KNOWL_SUBAGENT_BOOTSTRAP_CARD,
  renderFullKnowlGuidance,
  renderManagedKnowlGuidanceSection,
} from '../../src/core/knowl-guidance.js';

const EXPECTED_TOOLS = [
  'knowl_query',
  'knowl_recent', 'knowl_state', 'knowl_context',
  'knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish',
  'knowl_store', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update',
  'knowl_timeline', 'knowl_evidence_list', 'knowl_conflicts', 'knowl_feedback',
  'knowl_skill_list', 'knowl_skill_read', 'knowl_skill_run', 'knowl_skill_create',
  'knowl_ingest', 'knowl_synthesize', 'knowl_session_finish', 'knowl_gc_preview', 'knowl_gc_apply',
  'knowl_handoff',
  'knowl_park', 'knowl_resume',
] as const;

const EXPECTED_CLAUDE_CARD = [
  'KNOWL WORKFLOW - for project work.',
  'Start: use a relevant active lifecycle hit; else call knowl_query with the words that name the subject before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
  'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.',
  'Manual fallback: knowl task run for one bounded command; resumable work uses knowl_task_start once, knowl_task_checkpoint at milestones or blockers with its taskId, and knowl_task_finish once after verification.',
  'Route by what you need; the tool list names them:',
  '- retrieval: knowl_query first. Recent context only without bootstrap or for a refresh, broad state for status, a packed context only when a token budget is given.',
  '- durable memory: store one verified atom, batch several, record a confirmed decision, or correct a stale one. Correct rather than duplicate.',
  '- audit: inspect history, evidence or conflicts when needed; record feedback only after actual use or correction.',
  '- skills: read a matching skill before running a trusted entrypoint; create one only on explicit request.',
  '- special: raw-source ingest only on an explicit request, never silent chat; synthesis only for an explicit scope; preview garbage collection first and apply only after approval.',
  '- leaving work: one baton the next session here consumes once, or a key the user keeps and hands back any time later, from anywhere.',
  'During work, store or update verified durable findings; never raw transcripts, secrets, or routine command noise.',
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
  it('defines nine groups and the exact 27-tool inventory', () => {
    expect(KNOWL_MCP_TOOL_GROUPS).toHaveLength(9);
    expect(KNOWL_MCP_TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(new Set(KNOWL_MCP_TOOL_NAMES).size).toBe(27);
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
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toHaveLength(1_737);
    expect(KNOWL_MCP_SERVER_INSTRUCTIONS).toHaveLength(1_788);
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

  it('changes only the lifecycle mode line between compact renderings', () => {
    expect(
      KNOWL_CLAUDE_OPERATIONAL_CARD.replace(KNOWL_CLAUDE_MODE_LINE, KNOWL_HOST_NEUTRAL_MODE_LINE),
    ).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('documents every canonical MCP tool in the README table', async () => {
    const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
    const documentedTools = [...readme.matchAll(/^\| \`(knowl_[a-z_]+)\` \|/gm)]
      .map(match => match[1]);
    expect(documentedTools).toEqual([...KNOWL_MCP_TOOL_NAMES]);
    expect(new Set(documentedTools).size).toBe(27);
    expect(readme).toContain('KNOWL.md');
    expect(readme).toContain('GEMINI.md');
    expect(readme).toContain('agent-reminder claude --json');
    expect(readme).toContain('previewed maintenance after explicit approval');
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
