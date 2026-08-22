import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installKnowlHostInstructions,
  verifyKnowlHostInstructions,
} from '../../src/cli/agents/instruction-files.js';
import { renderManagedKnowlGuidanceSection } from '../../src/core/knowl-guidance.js';

const ROOT = path.resolve('.knowl-host-instructions-test');
afterEach(() => fs.rm(ROOT, { recursive: true, force: true }));

// A table of one since the Gemini adapter was retired. Kept as a table rather than inlined:
// what these cases actually exercise is `hasActiveGuidanceImport`, which is host-independent
// and is the part worth keeping -- fenced, inline-code and indented-code examples must not
// count as an active import, and both `@KNOWL.md` and `@./KNOWL.md` spellings must.
describe.each([
  ['claude', 'CLAUDE.md', '@KNOWL.md'],
] as const)('%s native instructions', (host, filename, preferredImport) => {
  const pathname = path.join(ROOT, filename);

  it('creates the preferred import and reruns unchanged', async () => {
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('configured');
    expect(await fs.readFile(pathname, 'utf8')).toBe(`${preferredImport}\n`);
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
  });

  it.each(['@KNOWL.md', '@./KNOWL.md', '@AGENTS.md', '@./AGENTS.md'])(
    'accepts an existing standalone %s import',
    async importLine => {
      await fs.mkdir(ROOT, { recursive: true });
      await fs.writeFile(pathname, `${importLine}\n\nHost rules stay.\n`);
      expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
      expect(await fs.readFile(pathname, 'utf8')).toContain('Host rules stay.');
    },
  );

  it('accepts an active import embedded in prose', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Host rules load @KNOWL.md here.\n');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
  });

  it('does not mistake inline-code or fenced examples for an active import', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, '<!-- @KNOWL.md -->\nLiteral `@KNOWL.md` example.\n\n```md\n@KNOWL.md\n```\n');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    expect((await fs.readFile(pathname, 'utf8')).startsWith(`${preferredImport}\n`)).toBe(true);
  });

  it.each([
    '    @./KNOWL.md',
    '\t@AGENTS.md',
  ])('does not mistake an indented-code %s example for an active import', async example => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, `Example only:\n\n${example}\n`);

    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved.startsWith(`${preferredImport}\n`)).toBe(true);
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
  });

  it('removes only legacy managed guidance and preserves custom content', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, `Before\n\n${renderManagedKnowlGuidanceSection()}\nAfter\n`);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).toContain('Before');
    expect(saved).toContain('After');
    expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('does not duplicate an existing import while removing legacy guidance', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, `${preferredImport}\n\n${renderManagedKnowlGuidanceSection()}\nHost rules stay.\n`);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(saved).toContain('Host rules stay.');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('removes every duplicate legacy managed section in one run', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    const managed = renderManagedKnowlGuidanceSection();
    await fs.writeFile(pathname, `${preferredImport}\n\n${managed}\nHost rules stay.\n\n${managed}`);

    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(saved).toContain('Host rules stay.');
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
  });

  it('repairs an unterminated legacy section from its opening marker through EOF', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Keep this.\n\n<!-- KNOWL_PROJECT_MEMORY -->\ndiscard this');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).toContain('Keep this.');
    expect(saved).not.toContain('discard this');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('rejects missing imports and remaining legacy markers during verification', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Host rules only.\n');
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(false);
    await fs.writeFile(pathname, `${preferredImport}\n<!-- KNOWL_PROJECT_MEMORY -->\nstale\n`);
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(false);
  });
});
