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

  it('warns about a tail of unembedded items, naming how many', () => {
    // The case that was silently reported as healthy: write-time embedding refuses to
    // download the model, nothing else downloads it until the first query, and every item
    // written before that is permanently invisible to vector search.
    //
    // Still a warning at this size, deliberately: the item is reachable by keyword, which is
    // the same reasoning `lexicalCoverageCheck` uses in the other direction.
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 7 });
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('3');
    expect(check.message).toMatch(/vector search/i);
  });

  it('fails when most of the store is unembedded, because search then misrepresents it', () => {
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 4 });
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('4');
    expect(check.message).toContain('10');
  });

  it('turns on the majority, so half embedded is still only advisory', () => {
    // The boundary stated as a test rather than left to be re-derived from `missing * 2 >
    // active`: at exactly half, semantic search still reaches half the store.
    expect(vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 5 }).status)
      .toBe('WARN');
    expect(vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 11, embeddedItems: 5 }).status)
      .toBe('FAIL');
  });

  it('fails a store where one stray row is embedded and nothing else is', () => {
    // Why the rule is the majority and not `embedded === 0`. This is the production shape --
    // embedding never worked, then a single query downloaded the model and one later write
    // succeeded -- and a strict zero test would grade it advisory.
    expect(vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 345, embeddedItems: 1 }).status)
      .toBe('FAIL');
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

  it('fails when nothing at all is embedded', () => {
    // Was a warning under a READY verdict. On knowl-cloud production this exact state -- 345
    // atoms, zero vectors, every embed failing on an unlogged EACCES -- was reported as healthy
    // for twelve hours.
    const check = vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 3, embeddedItems: 0 });
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('3');
  });

  it('still reports OK for a store with nothing in it, which is not a broken one', () => {
    // `0 * 2 > 0` is false, so an empty project does not trip the majority rule. Asserted
    // because a fresh `knowl init` reporting NOT READY is the exact false alarm that made
    // WARN stop deciding the verdict in the first place.
    expect(vectorCoverageCheck({ enabled: true, model: 'local/m', activeItems: 0, embeddedItems: 0 }).status)
      .toBe('OK');
  });

  /**
   * The gap an UPGRADE opened, which is a different condition from the gap a missing model left.
   *
   * `fingerprintProfile` hashes the embedding recipe and the batching policy alongside the model,
   * deliberately, so a recipe change invalidates its own rows. Retrieval filters on that same
   * fingerprint. The consequence is that a release can take a fully-embedded store to zero
   * reachable vectors at once, through no action of the user's -- and the old wording described
   * that as items that "are embedded", counted them as never-embedded, and told the reader
   * "nothing embeds these retroactively", which is the one thing that is not true of them.
   */
  describe('when a previous embedding recipe left rows behind', () => {
    it('says the rows exist under an older profile rather than implying they were never made', () => {
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 747, embeddedItems: 23, staleItems: 724,
      });
      expect(check.status).toBe('FAIL');
      expect(check.message).toContain('724');
      expect(check.message).toMatch(/earlier embedding recipe|previous embedding recipe/i);
      expect(check.message).toMatch(/upgrade/i);
    });

    it('does NOT say nothing embeds them retroactively, because a reindex is exactly what does', () => {
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 747, embeddedItems: 23, staleItems: 724,
      });
      expect(check.message).not.toMatch(/retroactively/i);
      expect(check.fix).toMatch(/reindex/);
    });

    it('separates rows left by an upgrade from rows that were never embedded at all', () => {
      // 100 active, 10 current, 60 stale -- so 30 were never embedded. Reporting one number
      // would hide that two different things went wrong and only one of them is an upgrade.
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 100, embeddedItems: 10, staleItems: 60,
      });
      expect(check.message).toContain('60');
      expect(check.message).toContain('30');
    });

    it('still fails loudly when an upgrade darkened the whole store', () => {
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 48, embeddedItems: 0, staleItems: 48,
      });
      expect(check.status).toBe('FAIL');
      expect(check.remedy).toEqual({ kind: 'reindex-vectors' });
    });

    it('a stale tail is a warning, matching how a never-embedded tail is treated', () => {
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 100, embeddedItems: 97, staleItems: 3,
      });
      expect(check.status).toBe('WARN');
      expect(check.message).toMatch(/earlier embedding recipe|previous embedding recipe/i);
    });

    it('keeps the never-embedded wording when nothing is stale, so the old case is unchanged', () => {
      const check = vectorCoverageCheck({
        enabled: true, model: 'local/m', activeItems: 10, embeddedItems: 4, staleItems: 0,
      });
      expect(check.message).toMatch(/retroactively/i);
      expect(check.message).not.toMatch(/recipe/i);
    });
  });
});
