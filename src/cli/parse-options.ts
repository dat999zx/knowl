import { InvalidArgumentError } from 'commander';

/**
 * Commander invokes an option coercion as `fn(value, previous)`, and `parseInt`'s second
 * parameter is the **radix**. So `.option('--limit <n>', '…', parseInt)` reads correctly and is
 * wrong: the first occurrence gets `parseInt("8", undefined)` and works, while a repeated flag
 * gets `parseInt("8", 5)` — NaN, because 8 is not a digit in base 5.
 *
 * The failure is silent rather than loud. `NaN ?? 50` is NaN — nullish coalescing does not catch
 * it — and `slice(0, NaN)` returns `[]`, so `knowl list --limit abc` printed "No memories match."
 * against a full store and exited 0. A command that lies about an empty store is worse than one
 * that refuses.
 *
 * Any bare stdlib function handed to commander is suspect for the same reason. `parseFloat` is
 * arity 1 and safe; `parseInt` and `Number.parseInt` are not.
 */
export function positiveInt(label: string): (value: string) => number {
  return (value: string) => {
    const parsed = Number.parseInt(value, 10);
    // Checked, not defaulted. A default here would swallow the typo it exists to catch.
    if (!Number.isInteger(parsed) || parsed < 1) {
      // InvalidArgumentError, not a bare Error: commander catches this one and prints a single
      // line before exiting 1. A plain throw from a coercion escapes as an unhandled exception
      // and shows the user a stack trace through commander's own internals.
      throw new InvalidArgumentError(`${label} must be a whole number of at least 1, not "${value}".`);
    }
    return parsed;
  };
}
