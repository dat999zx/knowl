/**
 * Formats the message shown to an MCP caller when project initialization failed.
 *
 * SQLITE_BUSY means the database was healthy and another process just held it
 * momentarily -- "run knowl init" is wrong advice for that case and sends the user
 * down an unrelated path. Every other init failure keeps the original guidance.
 */
export function formatInitError(initError: string): string {
  if (/SQLITE_BUSY/i.test(initError)) {
    return `❌ Knowl MCP Server could not open the project database: it is temporarily locked by another process.\nReason: ${initError}\n\nThis is usually transient. Retry in a moment or reconnect this MCP server; if it keeps happening, check for another 'knowl serve' process holding the database.`;
  }
  return `❌ Knowl MCP Server is active but not initialized for the current directory.\nReason: ${initError}\n\nPlease run 'knowl init' in your project root to initialize this project.`;
}
