/**
 * Knowl lifecycle plugin for Cline.
 *
 * Cline is the one host `knowl init` cannot configure: it has no hooks file and no
 * shell-command channel, only `AgentPlugin` objects loaded into its own runtime. So the adapter
 * in `src/cli/agents/` writes MCP config and stops, and this file is the other half -- the same
 * lifecycle every other host gets, in the only shape Cline accepts.
 *
 * It is still a `HostProfile` (`src/session/hosts/cline.ts`), because cannot be *configured*
 * like one and cannot *send* like one are different claims. This file does the sending.
 *
 * It is a plain `.mjs` rather than an npm package on purpose. Cline loads plugins from
 * `pluginPaths`, so a file path is the entire installation: no registry, no version to keep in
 * step with the CLI it shells out to, and nothing to publish before someone can try it.
 *
 * ## Install
 *
 *   // cline.config.mjs, or wherever ClineCore.start() is configured
 *   import knowl from './node_modules/@dat999zx/knowl/integrations/cline/knowl-plugin.mjs';
 *   ClineCore.start({ extensions: [knowl] });
 *
 * or, without importing:
 *
 *   ClineCore.start({ pluginPaths: ['./integrations/cline/knowl-plugin.mjs'] });
 *
 * ## What it does
 *
 * Every method forwards one normalized event to `knowl agent-hook cline <event> --json` over
 * stdin, which is the same entry point every other host's hooks call. Cline's own method names
 * are mapped here rather than in the profile, because they arrive as calls on a JavaScript
 * object and this file is the only code that can see them.
 *
 * ## What it deliberately does not do
 *
 * `beforeTool` can refuse a call by returning `{skip: true, reason}`, so the write gate is
 * reachable from here. It is not wired up, and that is a decision rather than an omission: the
 * gate's contract is that a failure allows the write, and this plugin runs inside Cline's
 * process where a hung child process stalls the agent rather than timing out a hook runner.
 * Capture first, refuse later, once someone has run this against a real session.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

/** Cline's method names, mapped to the events `knowl agent-hook` already understands. */
const EVENTS = {
  beforeRun: 'session-start',
  afterRun: 'session-stop',
  beforeModel: 'turn-start',
  afterModel: 'turn-stop',
  afterTool: 'session-event',
};

const HOOK_TIMEOUT_MS = 10_000;

/**
 * Run one hook and return its stdout, or null.
 *
 * Never throws and never rejects. This runs inside Cline's own process, so an exception here is
 * not a failed hook, it is a failed *agent turn* -- the asymmetry that makes every other host's
 * hook runner a separate process. The timeout exists for the same reason: a Knowl invocation
 * that hangs must cost this turn nothing rather than stalling it indefinitely.
 */
function runHook(event, payload) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      // No `shell`. `knowl.cmd` is named explicitly on Windows, so there is nothing PATHEXT
      // needs to resolve -- and a shell puts `cmd.exe` between this and the real process, so
      // `child.kill()` on a timeout would kill the shell and orphan the Knowl process inside
      // it. Once per timeout, forever, inside somebody's editor session.
      const command = process.platform === 'win32' ? 'knowl.cmd' : 'knowl';
      const child = spawn(command, ['agent-hook', 'cline', event, '--json'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, HOOK_TIMEOUT_MS);
      timer.unref?.();

      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          done(out.trim() ? JSON.parse(out) : null);
        } catch {
          done(null);
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      done(null);
    }
  });
}

/**
 * A stable id for this plugin instance, used when Cline's context names none.
 *
 * Without *some* session id `normalizeHostHook` throws `IncompleteHostHookPayloadError`, which
 * `runAgentHook` deliberately swallows in silence -- so a context object that spells its task id
 * differently than expected would make the whole integration dark with no error anywhere. Cline
 * loads one plugin instance per run, so falling back to a per-instance id is wrong only in
 * degree: turns still group together, they are just grouped by process instead of by task.
 */
const FALLBACK_SESSION_ID = `cline-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * The identity Knowl keys a memory session on.
 *
 * `cwd` is what `requireProjectRoot` reads, and a session id is what binds turns together --
 * without one every turn opens its own memory session and nothing accumulates. Cline names
 * these differently across versions, so several spellings are tried, and neither field is
 * allowed to end up undefined.
 */
function basePayload(context = {}) {
  const session = context.taskId ?? context.conversationId ?? context.sessionId ?? FALLBACK_SESSION_ID;
  return {
    cwd: context.cwd ?? context.workspaceRoot ?? context.workspace ?? process.cwd(),
    conversation_id: session,
    session_id: session,
    turn_id: context.requestId ?? context.turnId,
  };
}

/** Pull the context Knowl injects out of whatever envelope the hook returned. */
const contextFrom = result =>
  result?.additionalContext
  ?? result?.hookSpecificOutput?.additionalContext
  ?? result?.context
  ?? null;

const knowlPlugin = {
  name: 'knowl',
  version: '1.0.0',

  async beforeRun(context) {
    const result = await runHook(EVENTS.beforeRun, { ...basePayload(context), title: 'Agent session' });
    const injected = contextFrom(result);
    // Cline's documented way for a plugin to add to the model's context. Returning nothing is
    // always valid, which is what a miss, a timeout and a crash all produce.
    return injected ? { additionalContext: injected } : undefined;
  },

  async beforeModel(context) {
    const result = await runHook(EVENTS.beforeModel, { ...basePayload(context), title: 'Agent turn' });
    const injected = contextFrom(result);
    return injected ? { additionalContext: injected } : undefined;
  },

  async afterTool(context) {
    const result = await runHook(EVENTS.afterTool, {
      ...basePayload(context),
      type: 'checkpoint',
      tool_name: context?.toolName ?? context?.name,
      tool_input: context?.input ?? context?.parameters ?? {},
      // Both spellings, because `changedPaths` reads either and Cline's key has moved.
      file_path: context?.input?.path ?? context?.input?.file_path,
    });
    const injected = contextFrom(result);
    return injected ? { additionalContext: injected } : undefined;
  },

  async afterModel(context) {
    await runHook(EVENTS.afterModel, { ...basePayload(context), status: 'finished' });
  },

  async afterRun(context) {
    await runHook(EVENTS.afterRun, { ...basePayload(context), status: 'finished' });
  },
};

export default knowlPlugin;
