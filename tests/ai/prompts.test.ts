import { describe, expect, it } from 'vitest';
import { FILTER_SYSTEM_PROMPT } from '../../src/ai/prompts.js';

/**
 * The filter is a gate, not an advisor. `runPipeline` returns early the moment it rejects
 * (`src/pipeline/pipeline.ts`), so extraction never sees that input and no later stage can
 * report what was lost. Anything the extract prompt is told to keep has to survive the filter
 * first, or the extract rule is unreachable prose.
 *
 * The pair drifted apart exactly there. Extraction learned to keep a diagnosis whose cause will
 * recur, while the filter still carried a MUST-reject for "temporary coding errors that are
 * immediately fixed" — precisely what a diagnosed and fixed config trap looks like from the
 * gate. The filter's own allow list already named resolved debugging procedures as valuable, so
 * that bullet was also contradicting the line eight above it. Both stages now split on
 * recurrence rather than on whether an error occurred.
 */
describe('AI pipeline prompts', () => {
  it('does not reject at the gate the recurring diagnoses extraction is told to keep', () => {
    expect(FILTER_SYSTEM_PROMPT).toMatch(/recur/);
    // The two phrases that made a fixed, understood config trap read as a MUST-reject.
    expect(FILTER_SYSTEM_PROMPT).not.toMatch(/immediately fixed/);
    expect(FILTER_SYSTEM_PROMPT).not.toMatch(/intermediate debugging noise/);
  });
});
