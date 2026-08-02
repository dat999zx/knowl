/**
 * Shared terminal styling for Knowl's interactive commands.
 *
 * Two rules from the CLI guidelines drive everything here:
 *
 *   "Use color with intention." Colour marks one thing per line -- the value that
 *   changed, the key you would script with -- and nothing else. A screen where
 *   everything is coloured says no more than one where nothing is.
 *
 *   "Disable color if your program is not in a terminal." Redirected output, NO_COLOR,
 *   and TERM=dumb all drop to plain text, so a piped or logged run stays readable.
 *
 * Box-drawing characters follow the same shape as clack's `unicodeOr`: a terminal that
 * cannot render them gets ASCII rather than mojibake. That matters most on Windows,
 * where a legacy code page turns a missing glyph into a question mark.
 */

function colorEnabled(): boolean {
  // Explicit opt-out wins over every heuristic. https://no-color.org
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

const ESC = '\u001b';

// Written as an escape rather than a literal control byte: a raw 0x1B in source survives
// git and the compiler, but not every editor, formatter or patch tool in between.
function wrap(open: number, close: number) {
  return (text: string) => (colorEnabled() ? `${ESC}[${open}m${text}${ESC}[${close}m` : text);
}

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/**
 * Whether the terminal can be trusted with box-drawing characters.
 *
 * Windows Terminal, VS Code and every modern *nix terminal can. The legacy conhost
 * window cannot, and it is still what a double-clicked `cmd.exe` opens, so the check is
 * for the modern host rather than for Windows.
 */
export function supportsUnicode(): boolean {
  if (process.platform !== 'win32') return process.env.TERM !== 'dumb';
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuTask);
}

const unicodeOr = (rich: string, plain: string) => (supportsUnicode() ? rich : plain);

/**
 * Resolved on access rather than at import.
 *
 * Frozen constants read the environment once, at whatever moment the module first loads
 * -- which for a library is before the process has necessarily finished setting itself
 * up, and for a test is before the case can describe the terminal it wants. Getters cost
 * a few environment lookups and make the fallback observable.
 */
export const symbol = {
  get barStart() { return unicodeOr('┌', '-'); },
  get bar() { return unicodeOr('│', '|'); },
  get barEnd() { return unicodeOr('└', '-'); },
  get cursor() { return unicodeOr('❯', '>'); },
  get back() { return unicodeOr('←', '<'); },
  get more() { return unicodeOr('…', '...'); },
  get dot() { return unicodeOr('·', '-'); },
  get info() { return unicodeOr('◇', 'o'); },
  get warn() { return unicodeOr('▲', '!'); },
  get done() { return unicodeOr('◆', '*'); },
};

/** Opens a framed session: a titled top rule, so the prompts below read as one screen. */
export function intro(title: string, subtitle?: string): void {
  console.log('');
  console.log(`${color.gray(symbol.barStart)}  ${color.bold(title)}${subtitle ? `  ${color.gray(`${symbol.dot} ${subtitle}`)}` : ''}`);
  console.log(color.gray(symbol.bar));
}

/** Closes it. Every exit goes through here, so a run never just stops mid-air. */
export function outro(message: string): void {
  console.log(color.gray(symbol.bar));
  console.log(`${color.gray(symbol.barEnd)}  ${message}`);
  console.log('');
}

/**
 * Drops every escape sequence from a string.
 *
 * Needed because a prompt library highlights the active row by wrapping whatever text it
 * was given. If that text already carries colour, the inner reset ends the highlight
 * partway along the row and the rest of the line loses it. Normalising first means a row
 * can be coloured for the list and still highlight cleanly when selected.
 */
export function stripAnsi(text: string): string {
  // Built from ESC rather than written as a literal, for the same reason as `wrap`.
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}

/** A breadcrumb, so a nested list says where it sits rather than only what it holds. */
export function crumb(...parts: string[]): string {
  return parts.filter(Boolean).join(color.gray(` ${unicodeOr('›', '>')} `));
}
