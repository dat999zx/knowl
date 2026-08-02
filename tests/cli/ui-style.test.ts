import { afterEach, describe, expect, it, vi } from 'vitest';

const ESC = '\u001b';

/**
 * The style module reads the environment when a helper runs, not when it loads, so each
 * case sets the environment and re-imports to get a clean module state.
 */
async function loadStyle(env: Record<string, string | undefined>, isTty: boolean) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
  const style = await import('../../src/cli/ui/style.js');
  return { style, restore: () => { if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor); } };
}

const CLEAN_ENV = { NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: undefined, WT_SESSION: undefined, TERM_PROGRAM: undefined, ConEmuTask: undefined };

afterEach(() => {
  for (const key of Object.keys(CLEAN_ENV)) delete process.env[key];
  vi.resetModules();
});

describe('terminal style', () => {
  it('colours an interactive terminal', async () => {
    const { style, restore } = await loadStyle({ ...CLEAN_ENV }, true);
    expect(style.color.cyan('x')).toContain(ESC);
    restore();
  });

  it('emits no escape codes when output is redirected', async () => {
    // A piped or logged run must stay readable, so colour is dropped rather than
    // written into the file as noise.
    const { style, restore } = await loadStyle({ ...CLEAN_ENV }, false);
    expect(style.color.cyan('x')).toBe('x');
    expect(style.color.bold('x')).toBe('x');
    restore();
  });

  it('honours NO_COLOR even on a terminal', async () => {
    const { style, restore } = await loadStyle({ ...CLEAN_ENV, NO_COLOR: '1' }, true);
    expect(style.color.red('x')).toBe('x');
    restore();
  });

  it('honours TERM=dumb', async () => {
    const { style, restore } = await loadStyle({ ...CLEAN_ENV, TERM: 'dumb' }, true);
    expect(style.color.green('x')).toBe('x');
    restore();
  });

  it('lets FORCE_COLOR override a non-terminal', async () => {
    const { style, restore } = await loadStyle({ ...CLEAN_ENV, FORCE_COLOR: '1' }, false);
    expect(style.color.cyan('x')).toContain(ESC);
    restore();
  });

  it('carries no literal escape byte in its own source', async () => {
    // A raw 0x1B survives git and tsc but not every editor or patch tool in between.
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/cli/ui/style.ts', 'utf8');
    expect(source.includes(ESC)).toBe(false);
  });
});

describe('unicode fallback', () => {
  it('uses box drawing on a modern terminal and ASCII on a legacy one', async () => {
    const modern = await loadStyle({ ...CLEAN_ENV, WT_SESSION: '1' }, true);
    expect(modern.style.symbol.cursor).toBe('❯');
    expect(modern.style.symbol.barStart).toBe('┌');
    modern.restore();

    // A double-clicked cmd.exe has none of the modern-host markers, and an unrenderable
    // glyph there becomes a question mark rather than a character.
    const legacy = await loadStyle({ ...CLEAN_ENV }, true);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(legacy.style.symbol.cursor).toBe('>');
    expect(legacy.style.symbol.more).toBe('...');
    Object.defineProperty(process, 'platform', platform);
    legacy.restore();
  });

  it('strips escape sequences so a highlight cannot be cut short by one', async () => {
    const { style, restore } = await loadStyle({ ...CLEAN_ENV, FORCE_COLOR: '1' }, true);
    const coloured = `a ${style.color.cyan('b')} c`;
    expect(coloured).toContain(ESC);
    expect(style.stripAnsi(coloured)).toBe('a b c');
    restore();
  });
});
