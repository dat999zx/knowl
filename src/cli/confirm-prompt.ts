/**
 * Ask, as a two-option menu, before something that cannot be taken back.
 *
 * A menu rather than a y/n confirm because these two commands are where a wrong answer costs the
 * most, and a menu is the one shape that cannot be answered by reflex: both outcomes are spelled
 * out and named, and the hint says what each one actually does. It matches the settings picker in
 * `config/ui.ts`, which is where a reader has already met this interaction.
 *
 * The three answers are distinct because the caller's remedy differs. `no-tty` is not a "no": the
 * question was never asked, so the caller must say how to answer it without a terminal (`--yes`)
 * and exit non-zero rather than treat silence as consent. `declined` is a decided no and exits
 * clean. Collapsing the two would either block CI or let it proceed unasked, and both have shipped
 * in this file before.
 *
 * `isTTY` is injectable for the same reason it is on `pickWorkspace`: the interactive branch is the
 * only place these commands actually run, so it has to be reachable from a test. The version this
 * replaces called a bare global `confirm()` -- a browser API that is undefined in Node -- at both
 * call sites, and every test drove them with `--yes`, which skips the branch entirely.
 *
 * The prompt library is imported lazily, matching `cloud-picker.ts`: it is reachable only from
 * interactive paths and must not be paid for by `knowl serve`.
 */
export async function askConfirm(
  message: string,
  io: { isTTY?: boolean; acceptHint?: string; declineHint?: string } = {},
): Promise<'confirmed' | 'declined' | 'no-tty'> {
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return 'no-tty';

  const clack = await import('@clack/prompts');
  const chosen = await clack.select({
    message,
    options: [
      { value: 'declined', label: 'Decline', hint: io.declineHint },
      { value: 'confirmed', label: 'Accept', hint: io.acceptHint },
    ],
    // Decline is both first and preselected, so the answer a bare Enter gives is the answer that
    // costs nothing. The irreversible option is never the one under the cursor on arrival.
    initialValue: 'declined',
  });

  // Cancelling (Ctrl-C at the menu) is a decline. It is the one answer a user gives by reflex when
  // they did not mean to be here at all, so it must never fall through to the irreversible half.
  return clack.isCancel(chosen) || chosen !== 'confirmed' ? 'declined' : 'confirmed';
}
