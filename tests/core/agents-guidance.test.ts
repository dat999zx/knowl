import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installKnowlProjectGuidance,
  isKnowlProjectGuidanceCurrent,
} from '../../src/core/agents-guidance.js';
import { renderManagedKnowlGuidanceSection } from '../../src/core/knowl-guidance.js';

const ROOT = path.resolve('.knowl-project-guidance-test');
afterEach(() => fs.rm(ROOT, { recursive: true, force: true }));

describe('project guidance files', () => {
  it('creates canonical KNOWL.md and synchronized AGENTS.md', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'created', agents: 'created' });
    const knowl = await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8');
    const agents = await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(knowl).toBe(renderManagedKnowlGuidanceSection());
    expect(agents).toBe(`# Agent Instructions\n\n${renderManagedKnowlGuidanceSection()}`);
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
  });

  it('preserves content outside stale managed sections in both files', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    const stale = '<!-- KNOWL_PROJECT_MEMORY -->\nstale\n<!-- /KNOWL_PROJECT_MEMORY -->';
    await fs.writeFile(path.join(ROOT, 'KNOWL.md'), `Before\n\n${stale}\n\nAfter\n`);
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), `Rules\n\n${stale}\n\nTail\n`);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'updated', agents: 'updated' });
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('Before');
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('After');
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Rules');
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Tail');
  });

  it('replaces an unterminated section through EOF and is idempotent', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(path.join(ROOT, 'KNOWL.md'), 'Keep\n\n<!-- KNOWL_PROJECT_MEMORY -->\nbroken');
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), 'Keep agents\n\n<!-- KNOWL_PROJECT_MEMORY -->\nbroken');
    await installKnowlProjectGuidance(ROOT);
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toMatch(/^Keep\n\n<!-- KNOWL_PROJECT_MEMORY -->/);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'unchanged', agents: 'unchanged' });
  });

  it('collapses duplicate managed sections and rejects them as current', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    const managed = renderManagedKnowlGuidanceSection();
    const stale = '<!-- KNOWL_PROJECT_MEMORY -->\nstale duplicate\n<!-- /KNOWL_PROJECT_MEMORY -->\n';
    await fs.writeFile(path.join(ROOT, 'KNOWL.md'), `${managed}\n${stale}\nKnowl tail\n`);
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), `Agent rules\n\n${stale}\n${managed}`);

    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(false);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'updated', agents: 'updated' });

    for (const filename of ['KNOWL.md', 'AGENTS.md']) {
      const saved = await fs.readFile(path.join(ROOT, filename), 'utf8');
      expect(saved.match(/<!-- KNOWL_PROJECT_MEMORY -->/g)).toHaveLength(1);
      expect(saved.match(/<!-- \/KNOWL_PROJECT_MEMORY -->/g)).toHaveLength(1);
      expect(saved).not.toContain('stale duplicate');
    }
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('Knowl tail');
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Agent rules');
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'unchanged', agents: 'unchanged' });
  });

  /**
   * A CRLF checkout is current, and stays current.
   *
   * Everything here composes with `\n` and `core.autocrlf` hands back `\r\n`, so an exact
   * comparison calls a perfectly good file stale on every Windows clone — with no action that
   * fixes it, because the next checkout restores CRLF. Survivable while staleness was advisory;
   * not once it blocks `doctor`'s verdict, which is how it was caught: `doctor` reported NOT
   * READY on this repository minutes after the severity changed.
   */
  it('treats a CRLF checkout as current, and does not rewrite it', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await installKnowlProjectGuidance(ROOT);
    for (const name of ['KNOWL.md', 'AGENTS.md']) {
      const file = path.join(ROOT, name);
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('\n', '\r\n'), 'utf8');
    }

    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
    // And a reinstall leaves it alone rather than churning every line back to LF.
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'unchanged', agents: 'unchanged' });
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('\r\n');
  });

  it('does not double the carriage return when refreshing a CRLF file', async () => {
    // The bug the check above would otherwise hide: composing without normalising first expands
    // each `\n` of an already-CRLF prefix into `\r\r\n`, so the file never equals itself again.
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), '# Agent Instructions\r\n\r\nHand-written.\r\n', 'utf8');
    await installKnowlProjectGuidance(ROOT);

    const agents = await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8');

    expect(agents).not.toContain('\r\r');
    expect(agents).toContain('Hand-written.');
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
  });

  it('is not current when either file is missing or stale', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await installKnowlProjectGuidance(ROOT);
    await fs.rm(path.join(ROOT, 'KNOWL.md'));
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(false);
  });
});
