import { describe, expect, it } from 'vitest';
import { vectorCoverageCheck } from '../../src/cli/vector-coverage.js';

describe('vector coverage check', () => {
  it('reports OK when vector search is disabled, whatever the counts', () => {
    const check = vectorCoverageCheck({ enabled: false, model: 'local/m', activeItems: 10, embeddedItems: 0 });
    expect(check.status).toBe('OK');
    expect(check.message).toMatch(/disabled/i);
  });

  it('reports OK when every active item is embedded', () => {
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 10 });
    expect(check.status).toBe('OK');
    expect(check.message).toContain('local/m');
  });

  it('reports OK for an empty project, which has nothing to embed yet', () => {
    expect(vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 0, embeddedItems: 0 }).status).toBe('OK');
  });

  it('warns when active items have no embedding, naming how many', () => {
    // The case that was silently reported as healthy: write-time embedding refuses to
    // download the model, nothing else downloads it until the first query, and every item
    // written before that is permanently invisible to vector search.
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 4 });
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('6');
    expect(check.message).toMatch(/vector search/i);
  });

  it('does not warn when write-time embedding was deliberately switched off', () => {
    // A chosen gap is not a problem to report. Warning here would turn a signal that should
    // mean "something is wrong" into noise, and it is the standard CI configuration.
    const check = vectorCoverageCheck({
      enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 0, writeEmbeddingDisabled: true,
    });
    expect(check.status).toBe('OK');
    expect(check.fix).toBeUndefined();
  });

  it('names the exact command that fixes it', () => {
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 0 });
    expect(check.fix).toContain('knowl reindex --vectors');
  });

  it('warns when nothing at all is embedded, which is the fresh-project case', () => {
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 3, embeddedItems: 0 });
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('3');
  });
});
