#!/usr/bin/env node
import dotenv from 'dotenv';

/**
 * The process entry, and deliberately almost nothing else.
 *
 * ESM static imports are evaluated before the importing module's own body runs, so anything
 * this file imports at the top is loaded on *every* invocation, whatever was asked for. When
 * the whole command surface lived here, that meant the MCP server, the viewer, the
 * tree-sitter code indexer, the config UI, the AI pipeline and the transcript indexer were
 * all constructed before commander had looked at argv.
 *
 * That is affordable for a command a human types. It is not affordable for `agent-hook`,
 * which is a fresh process per agent tool call -- hundreds per session. Measured on this
 * machine, one hook call: 224ms through the full entry, 169ms through a minimal one. The
 * ~55ms difference is import scope and nothing else.
 *
 * So the fast path is a dynamic import of the hook module alone, and the command surface
 * (`./cli/program.js`) is loaded only when a command is actually going to be parsed. Help
 * still falls through to the program, so `knowl agent-hook --help` describes the command
 * rather than waiting on stdin.
 *
 * `dotenv` stays here rather than in either branch: it is a few kilobytes, and a `.env` that
 * applied to some commands and not others would be a worse surprise than the cost.
 */
dotenv.config();

const command = process.argv[2];
const wantsHelp = process.argv.includes('--help') || process.argv.includes('-h');

if (command === 'agent-hook' && !wantsHelp) {
  const { runAgentHook } = await import('./cli/agent-hook.js');
  await runAgentHook(process.argv[3], process.argv[4]);
} else {
  await import('./cli/program.js');
}
