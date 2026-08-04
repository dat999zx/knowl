/**
 * Formats the message shown to an MCP caller when project initialization failed.
 *
 * SQLITE_BUSY means the database was healthy and another process just held it
 * momentarily -- "run knowl init" is wrong advice for that case and sends the user
 * down an unrelated path. A schema stamp above this build's floor is the same kind of
 * mistake for a different reason: the repository is complete, and initializing it again
 * cannot lower a version number. Every other init failure keeps the original guidance.
 *
 * Neither branch names a command the reader should not run. These strings are read by
 * agents that act on them, and an agent that finds `knowl init` in the text may run it
 * however the sentence around it was phrased.
 */
export function formatInitError(initError: string): string {
  if (/SQLITE_BUSY/i.test(initError)) {
    return `❌ Knowl MCP Server could not open the project database: it is temporarily locked by another process.\nReason: ${initError}\n\nThis is usually transient. Retry in a moment or reconnect this MCP server; if it keeps happening, check for another 'knowl serve' process holding the database.`;
  }
  // Tied to SchemaTooNewError's wording; tests/mcp/init-error.test.ts formats a real one, so
  // this stops matching loudly rather than silently if that message is ever reworded.
  if (/written by a newer Knowl \(schema/i.test(initError)) {
    return `❌ Knowl MCP Server could not open the project database: its schema version stamp is newer than this build accepts.\nReason: ${initError}\n\nThe repository is set up correctly -- the fault is the version stamp in the database header, not the project. Either a newer Knowl wrote this file, in which case upgrading to that version opens it, or no newer Knowl was ever published, in which case the stamp came from a build that no longer exists and the file is held behind a version nobody can install. Check the published versions before concluding the data is unreadable.`;
  }
  return `❌ Knowl MCP Server is active but not initialized for the current directory.\nReason: ${initError}\n\nPlease run 'knowl init' in your project root to initialize this project.`;
}
