/**
 * One directory, one key.
 *
 * project_dir is an opaque string in every transcript query, so each spelling of
 * the same path becomes a separate archive. On Windows that is not hypothetical:
 * `D:\Code\x`, `d:\Code\x` and `d:/Code/x` all reach the same folder and all
 * arrived here, depending on whether the caller was the CLI (path.resolve), the
 * MCP server (its configured root) or a script.
 *
 * Measured on a real database before this existed: 59,358 messages indexed three
 * times over under three spellings, with every embedding attached to just one of
 * them - so semantic search from the MCP server scored against a set that had no
 * vectors at all and silently returned lexical results. The duplicates also
 * tripled the storage.
 *
 * Purely lexical, and deliberately NOT path.resolve. This value is also what
 * encodeProjectDir turns into a transcript directory name, so it has to stay the
 * path Claude Code encoded - and resolve() rewrites a Windows-shaped path on a
 * POSIX host into cwd + the literal string, because backslashes are not
 * separators there. That pointed the whole index at a directory that does not
 * exist and failed 22 tests on Linux while passing on Windows. Only the two
 * things that actually vary are canonicalized: the case of the drive letter, and
 * which slash was typed.
 *
 * This lives alone, with no imports, because the schema bootstrap needs it to
 * migrate old rows and everything else in the store imports the bootstrap.
 */
export function normalizeProjectDir(dir: string): string {
  if (!/^[a-zA-Z]:/.test(dir)) return dir;
  return dir[0].toUpperCase() + dir.slice(1).replace(/\//g, '\\').replace(/[\\]+$/, '');
}
