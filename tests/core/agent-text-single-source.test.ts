import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWL_CLAUDE_CONTINUATION_REMINDER, KNOWL_LOAD_SCHEMA_LINE, KNOWL_NO_SECRETS_LINE,
  KNOWL_USE_TOGETHER_LINE, KNOWL_WRITE_ROUTING,
} from '../../src/core/knowl-guidance.js';
import { hermesPluginGuidance } from '../../src/core/plugin-guidance.js';
import { GLOBAL_BLOCK } from '../../src/cli/agents/global-instructions.js';
import { renderMidSessionSilenceNudge, renderSilenceNudge, renderTurnCapturePrompt } from '../../src/store/capture-outcome.js';
import { renderCorrectionNudge } from '../../src/store/pending-lessons.js';

/**
 * Every text that tells an agent to WRITE to memory must carry the one shared routing sentence.
 *
 * Why this exists: the reminder, the three capture nudges, the correction nudge, the global
 * instruction block and the Hermes plugin's rules each hand-wrote their own "store it" line, and
 * they drifted. Three nudges named `knowl_store or knowl_decide` and never `knowl_update`, so an
 * agent told to write was never told to correct stale memory instead of duplicating it. The
 * invariant is a relationship, not a snapshot: whatever the sentence says, every text that
 * speaks about writing says the same thing. Adding a new nudge means adding it to this list.
 */
describe('agent-facing write guidance has one source', () => {
  const writers: Record<string, string> = {
    'mid-turn reminder': KNOWL_CLAUDE_CONTINUATION_REMINDER,
    'turn capture nudge': renderTurnCapturePrompt(),
    'mid-session silence nudge': renderMidSessionSilenceNudge(),
    'session-end silence nudge': renderSilenceNudge(),
    'correction nudge': renderCorrectionNudge(),
    'global instruction block': GLOBAL_BLOCK,
    'hermes project rules': hermesPluginGuidance().projectRules,
    'hermes global rules': hermesPluginGuidance().globalRules,
  };

  for (const [name, text] of Object.entries(writers)) {
    it(`${name} carries the shared write routing`, () => {
      expect(text).toContain(KNOWL_WRITE_ROUTING);
    });
  }

  it('the routing names the update path, so no text can tell an agent to write without it', () => {
    for (const tool of ['knowl_store', 'knowl_update', 'knowl_decide']) expect(KNOWL_WRITE_ROUTING).toContain(tool);
    expect(KNOWL_WRITE_ROUTING).toMatch(/instead of storing a duplicate/);
  });

  it('the global texts and the reminder share their other sentences too', () => {
    expect(GLOBAL_BLOCK).toContain(KNOWL_USE_TOGETHER_LINE);
    expect(hermesPluginGuidance().globalRules).toContain(KNOWL_USE_TOGETHER_LINE);
    expect(KNOWL_CLAUDE_CONTINUATION_REMINDER).toContain(KNOWL_LOAD_SCHEMA_LINE);
    expect(hermesPluginGuidance().projectRules).toContain(KNOWL_NO_SECRETS_LINE);
  });

  /**
   * The plugin is Python and cannot import any of this, which is how it came to hold its own
   * copies. It now reads `guidance.json`, rendered from `plugin-guidance.ts`; this pins that the
   * file on disk is that render, and that the Python file carries no rule prose of its own.
   */
  it('the plugin reads rendered guidance and holds no copy of its own', () => {
    const dir = path.join(__dirname, '..', '..', 'integrations', 'hermes', 'knowl');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guidance.json'), 'utf8'));
    expect(onDisk).toEqual(hermesPluginGuidance());
    const source = fs.readFileSync(path.join(dir, '__init__.py'), 'utf8');
    expect(source).not.toContain('# Knowl project memory (active');
    expect(source).not.toContain('# Knowl personal defaults');
  });
});
