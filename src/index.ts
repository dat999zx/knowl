#!/usr/bin/env node
import module from 'node:module';
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
 *
 * The compile cache is enabled here for the same reason, and it is the larger half: it caches
 * V8's compiled bytecode for every module compiled *after* the call, which is both dynamic
 * branches and everything they pull in. Measured at roughly 115ms off a cold start, against a
 * ~218ms floor that `agent-hook` pays hundreds of times a session.
 *
 * Guarded twice on purpose. `engines` is `>=22` and `enableCompileCache` landed in 22.1.0, so
 * the method can be absent; and the cache directory can be unwritable, so the call can throw.
 * A startup optimisation must never be what fails a command. Called with no argument, so the
 * cache lands in `NODE_COMPILE_CACHE` if the user set one and node's own default otherwise --
 * choosing a directory for them is a decision this does not need to make.
 */
try {
  module.enableCompileCache?.();
} catch {
  // Pre-22.1, or a read-only cache directory. Neither is worth failing the command over.
}

// `quiet` is not optional decoration. dotenv 17 prints "injected env (N) from .env" plus a
// rotating tip to STDOUT on every call, which lands in front of the JSON that `--json`
// commands emit and makes it unparseable -- caught by four CLI suites on the upgrade.
dotenv.config({ quiet: true });

const command = process.argv[2];
const wantsHelp = process.argv.includes('--help') || process.argv.includes('-h');

// This dispatcher is the whole argument parser for the two hook commands -- commander never sees
// them -- so it has to do commander's job for the flags the generated hook configs actually
// write. Reading `argv[3]` and `argv[4]` positionally was correct only for the exact word order
// `hook-config.ts` emits: `knowl agent-reminder claude --json`. Written the other way round,
// `knowl agent-reminder --json claude` made "--json" the host.
const hookArgs = process.argv.slice(3);
const hookOptions = { json: hookArgs.includes('--json') };
const [hookHost, hookEvent] = hookArgs.filter(argument => !argument.startsWith('-'));

if (command === 'agent-hook' && !wantsHelp) {
  const { runAgentHook } = await import('./cli/agent-hook.js');
  await runAgentHook(hookHost, hookEvent, hookOptions);
} else if (command === 'agent-reminder' && !wantsHelp) {
  // Same fast path, and for the same reason: this is a per-prompt process, and since it
  // started reading `capture_outcomes` to decide whether to speak it opens the store too.
  // Routing it through commander loaded the MCP server, the viewer and the code indexer
  // first, on every single prompt.
  const { runAgentReminder } = await import('./cli/agents/reminder.js');
  await runAgentReminder(hookHost, hookOptions);
} else {
  // Called rather than relying on an import-time side effect: parsing on import meant any test
  // that imported the command tree consumed the test runner's argv and exited.
  const { runProgram } = await import('./cli/program.js');
  runProgram();
}
