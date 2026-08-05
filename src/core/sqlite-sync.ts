/**
 * How hard SQLite works to get a commit onto the platter, and the one place that is decided.
 *
 * `synchronous` was never set anywhere, so every database ran at SQLite's default of FULL by
 * inheritance rather than by decision. FULL fsyncs the WAL on every commit, and because a bare
 * `execute` is its own implicit transaction that is one fsync per un-batched write -- which is
 * the common shape here: one `knowl_store`, one hook capture, one session event.
 *
 * MEASURED on this schema (Windows 11, node 24.13, @libsql/client 0.14.0, interleaved A/B,
 * medians over 15 rounds): un-batched writes cost 3.488 ms/row at FULL against 0.832 at NORMAL,
 * 4.19x. NORMAL matched `synchronous=OFF` (0.867) to within noise, which is what identifies the
 * fsync as the whole of the gap rather than a part of it. Under contention it is better, not
 * merely faster alone -- the case that decides it, since `serve`, the hooks and the CLI all
 * hold one file: six concurrent processes went 173 -> 337 writes/s, p95 6.161 -> 0.198 ms, with
 * zero SQLITE_BUSY either way. A writer that does not fsync holds the write lock for less time.
 *
 * THE TRADE, in what a user loses. SQLite's documentation is unambiguous that this is not a
 * corruption risk in WAL: "WAL mode is safe from corruption with synchronous=NORMAL... A
 * transaction committed in WAL mode with synchronous=NORMAL might roll back following a power
 * loss or system crash. Transactions are durable across application crashes regardless of the
 * synchronous setting or journal mode." (pragma.html#pragma_synchronous). So a crashed agent, a
 * killed `serve`, a closed laptop lid, Ctrl-C -- none of those lose anything. Only a power cut
 * or an OS crash can drop the last seconds, and the file still opens cleanly afterwards.
 *
 * For project memory that is re-derivable from the transcripts on disk beside it, that is the
 * right default. It is still a policy, and a policy applied to every database with no way out
 * is not a decision anyone gets to make -- hence the variable.
 */
export type SynchronousMode = 'NORMAL' | 'FULL';

export const SYNCHRONOUS_ENV_VAR = 'KNOWL_SQLITE_SYNCHRONOUS';

/**
 * Resolved on every database open rather than cached at module load, so a test can set it per
 * case and a long-lived `serve` never holds a stale value.
 *
 * `OFF` is not offered. It CAN corrupt the file on power loss, and it measured no faster than
 * NORMAL, so it is a real risk for no gain -- and somebody reaching for it is owed that reason
 * rather than a generic parse failure.
 */
export function resolveSynchronous(env: NodeJS.ProcessEnv = process.env): SynchronousMode {
  const raw = env[SYNCHRONOUS_ENV_VAR];
  if (raw === undefined) return 'NORMAL';

  // Trimmed and case-folded: a trailing space out of a shell profile is a typo that should
  // work, not one that should stop every command.
  const value = raw.trim().toUpperCase();
  if (value === '') return 'NORMAL';
  if (value === 'NORMAL' || value === 'FULL') return value;

  if (value === 'OFF') {
    throw new Error(
      `${SYNCHRONOUS_ENV_VAR}=OFF is refused: it can corrupt the database on power loss and `
      + 'measured no faster than NORMAL. Use NORMAL (the default) or FULL.',
    );
  }
  // Thrown rather than ignored. Silently supplying NORMAL to somebody who asked for FULL is the
  // exact failure this variable exists to prevent, and every command opens a database, so a
  // typo surfaces at once instead of at some later write nobody connects to it.
  throw new Error(
    `${SYNCHRONOUS_ENV_VAR} must be NORMAL or FULL, not ${JSON.stringify(raw)}.`,
  );
}

/** The statement, ready to execute. Connection state, not file state: every connection sets it. */
export function synchronousPragma(env: NodeJS.ProcessEnv = process.env): string {
  return `PRAGMA synchronous = ${resolveSynchronous(env)};`;
}
