import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_CLAUDE_MODE_LINE,
  KNOWL_CLAUDE_OPERATIONAL_CARD,
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
] as const;

const EXPECTED_CLAUDE_CARD = [
  'KNOWL WORKFLOW - for project work.',
  'Start: use a relevant active lifecycle hit; else call knowl_query with 2-6 keywords before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
  'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.',
  'Manual fallback: one bounded command uses knowl task run; resumable work uses knowl_task_start once, knowl_task_checkpoint at meaningful milestones/blockers with its taskId, and knowl_task_finish once after verification.',
  'Route:',
  '- retrieval: knowl_query; knowl_recent only without bootstrap or for refresh; knowl_state for broad state; knowl_context for a token-budgeted pack.',
  '- durable memory: knowl_store one atom; knowl_ingest_atoms a batch; knowl_decide a confirmed choice; knowl_update a stale or contradicted item.',
  '- audit: knowl_timeline, knowl_evidence_list, knowl_conflicts; knowl_feedback after actual use or correction.',
  '- skills: knowl_skill_list, knowl_skill_read, knowl_skill_run only for a trusted matching entrypoint; knowl_skill_create only when explicitly requested.',
  '- special: knowl_ingest only for explicit raw-source ingestion, never silent chat; knowl_synthesize only for an explicit scope; knowl_session_finish only for an explicitly owned manual session; knowl_gc_preview before maintenance; knowl_gc_apply only after preview and explicit approval.',
  '- handoff: knowl_handoff parks a workstream for the next session; delivered once, then archived.',
  'During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.',
].join('\n');

const namesIn = (text: string) => [...new Set(text.match(/\bknowl_[a-z_]+\b/g) ?? [])].sort();

describe('canonical Knowl agent guidance', () => {
  it('defines eight groups and the exact 25-tool inventory', () => {
    expect(KNOWL_MCP_TOOL_GROUPS).toHaveLength(8);
    expect(KNOWL_MCP_TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(new Set(KNOWL_MCP_TOOL_NAMES).size).toBe(25);
    expect(KNOWL_MCP_TOOL_NAMES).not.toContain('knowl_ask');
  });

  it('renders every tool into the full and compact guidance', () => {
    expect(namesIn(renderFullKnowlGuidance())).toEqual([...EXPECTED_TOOLS].sort());
    expect(namesIn(KNOWL_CLAUDE_OPERATIONAL_CARD)).toEqual([...EXPECTED_TOOLS].sort());
    expect(namesIn(KNOWL_MCP_SERVER_INSTRUCTIONS)).toEqual([...EXPECTED_TOOLS].sort());
    expect(renderManagedKnowlGuidanceSection()).toContain('<!-- KNOWL_PROJECT_MEMORY -->');
    expect(renderFullKnowlGuidance()).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(renderFullKnowlGuidance()).toContain('Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.');
    expect(renderFullKnowlGuidance()).toContain('never send the current conversation silently');
    expect(renderFullKnowlGuidance()).toContain('never a hook session');
  });

  it('keeps both compact renderings bounded and front-loads the required action', () => {
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toBe(EXPECTED_CLAUDE_CARD);
    // One Route line for the handoff group: +97 chars on each card. The binding limit is not
    // this 2,000 ceiling but the transcript-enabled card in tests/transcripts/mcp-gating.test.ts,
    // which carries one more line and now sits at 1,982. That is the budget to check first.
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toHaveLength(1_792);
    expect(KNOWL_MCP_SERVER_INSTRUCTIONS).toHaveLength(1_843);
    for (const card of [KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS]) {
      expect(card.length).toBeLessThan(2_000);
      expect(card.slice(0, 512)).toContain('knowl_query');
      expect(card.slice(0, 512)).toContain('own lifecycle');
      expect(Math.ceil(card.length / 4)).toBeLessThanOrEqual(500);
      expect(20 * Math.ceil(card.length / 4)).toBeLessThanOrEqual(10_000);
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
    expect(new Set(documentedTools).size).toBe(25);
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
