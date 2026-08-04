import { describe, expect, it } from 'vitest';
import { formatInitError } from '../../src/mcp/init-error.js';
import { KNOWL_SCHEMA_VERSION, SchemaTooNewError } from '../../src/store/schema-version.js';

/**
 * Init failures are read by an agent that will act on them, so the guidance line matters as
 * much as the reason line. Two of these cases are ones where "run knowl init" is actively
 * wrong, and both were found by a human hitting them rather than by a test.
 */
describe('formatInitError', () => {
  /**
   * Built from the real error rather than a copied string, so rewording `SchemaTooNewError`
   * fails here instead of quietly dropping this branch back to the generic guidance -- which
   * is precisely the failure being fixed, one level up.
   */
  const SCHEMA_TOO_NEW =
    `Failed to initialize database at "d:\\repo\\.knowl\\knowl.db": ` +
    new SchemaTooNewError('(open database)', KNOWL_SCHEMA_VERSION + 2, KNOWL_SCHEMA_VERSION)
      .message;

  it('does not tell a schema-locked repo to initialize itself', () => {
    const message = formatInitError(SCHEMA_TOO_NEW);
    expect(message).not.toContain('not initialized');
    expect(message).not.toContain('knowl init');
  });

  it('names the version stamp as the fault, so the reader stops suspecting the repo', () => {
    const message = formatInitError(SCHEMA_TOO_NEW);
    expect(message).toMatch(/schema version|version stamp/i);
  });

  /**
   * The case that cost an evening: every database on the machine was stamped by an
   * experimental build that was then abandoned, so "upgrade Knowl" named a version that had
   * never been published. A reader who is not told this can only conclude their data is gone.
   */
  it('covers the stamp coming from a build that no longer exists', () => {
    const message = formatInitError(SCHEMA_TOO_NEW);
    expect(message).toMatch(/no newer Knowl|never published|no longer exists/i);
  });

  it('keeps the underlying reason, which carries both version numbers', () => {
    const message = formatInitError(SCHEMA_TOO_NEW);
    expect(message).toContain(SCHEMA_TOO_NEW);
  });

  it('still treats a momentary lock as transient rather than as a missing repo', () => {
    const message = formatInitError('database is locked (SQLITE_BUSY)');
    expect(message).toContain('temporarily locked');
    expect(message).not.toContain('knowl init');
  });

  it('keeps the original guidance for a failure it does not recognize', () => {
    const message = formatInitError('ENOENT: no such file or directory');
    expect(message).toContain('not initialized');
    expect(message).toContain('knowl init');
  });
});
