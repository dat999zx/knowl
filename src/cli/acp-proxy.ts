import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findProjectRoot } from '../core/config.js';
import { ProjectNotFoundError } from '../core/errors.js';
import { closeDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { handleHostLifecycleEvent } from '../session/host-lifecycle.js';
import { normalizeHostHook } from './agents/host-hook.js';
import type { NormalizedHookEventName } from '../core/host-hook-types.js';

/**
 * Knowl between an ACP client and an ACP agent.
 *
 * The Agent Client Protocol is what Zed and JetBrains built so any agent can run in any editor,
 * and its registry now covers Neovim, Kiro, Factory Droid and Cursor's CLI. None of them can be
 * a `HostProfile`, for a reason no profile can work around: ACP's interesting traffic runs
 * **agent to client**. `session/update` streams tool calls to the editor and
 * `session/request_permission` asks the editor for authorization -- neither invites a third
 * party, and there is no hook to register. The only seat available is *between* them.
 *
 * ## The one design property that makes this safe to ship
 *
 * **Every byte is forwarded exactly as received, and observation happens on a copy.** Lines are
 * relayed verbatim -- never parsed and re-serialized -- so this cannot reorder a field, drop an
 * unknown one, or change number formatting in a stream two other programs are speaking. Parsing
 * happens beside the relay, for reading only, and every failure there is swallowed.
 *
 * That makes the failure mode "Knowl recorded nothing" rather than "your editor broke", which is
 * the same direction every other Knowl hook fails in. It is also why this can ship before anyone
 * has run it against every agent in the registry: a proxy that adds nothing to the wire is a
 * no-op, and a no-op is recoverable.
 *
 * ## What it deliberately does not do
 *
 * **It does not answer `session/request_permission`.** That request is the write gate's natural
 * home here, and answering it means choosing one of the `PermissionOption`s the agent offered --
 * a shape the published schema describes as `RequestPermissionOutcome` without enumerating its
 * variants. Guessing it does not degrade quietly: it resolves a prompt the person was supposed
 * to see, in their editor, with an answer Knowl invented. So permission traffic is relayed
 * untouched and the gate stays hook-only until someone reads the outcome shape off a real
 * session. Capture, change cards and CODE IMPACT all work without it.
 *
 * ## Usage
 *
 *   knowl acp -- <agent-command> [args...]
 *
 * Point the editor at that instead of at the agent directly.
 */

/** ACP methods that mark a session boundary, mapped to what the lifecycle already understands. */
const METHOD_EVENTS: Record<string, NormalizedHookEventName> = {
  'session/new': 'session-start',
  'session/prompt': 'turn-start',
  'session/cancel': 'turn-stop',
};

type JsonRpc = {
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The file paths a tool call touched, from `ToolCall.locations`.
 *
 * ACP reports locations as `{path, line?}` so the editor can follow along, which happens to be
 * exactly what the impact subsystem needs and is the reason this lane is worth a component at
 * all: the agent volunteers which files it read and wrote, on every call, in one shape.
 */
function locationPaths(update: Record<string, unknown>): string[] {
  const locations = Array.isArray(update.locations) ? update.locations : [];
  return locations
    .map(entry => text(record(entry)?.path))
    .filter((value): value is string => Boolean(value))
    .slice(0, 50);
}

/**
 * ACP's `ToolCallKind`, mapped onto the read/write distinction the detector needs.
 *
 * `kind` is the agent's own classification -- `read`, `edit`, `execute` and so on -- which is
 * better evidence than a tool name, because it is what the protocol asks the agent to declare
 * rather than something we recognise after the fact.
 */
const KIND_TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
};

/** One observed message, turned into a lifecycle event, or nothing. */
function eventFor(message: JsonRpc): { event: NormalizedHookEventName; raw: Record<string, unknown> } | undefined {
  const params = message.params ?? {};
  const sessionId = text(params.sessionId);

  const boundary = message.method ? METHOD_EVENTS[message.method] : undefined;
  if (boundary) {
    return { event: boundary, raw: { conversation_id: sessionId ?? 'acp', status: 'finished' } };
  }

  if (message.method !== 'session/update') return undefined;
  const update = record(params.update);
  // Only settled tool calls: an in-progress update repeats as the call runs, and recording each
  // one would write the same read several times over.
  if (!update || text(update.sessionUpdate) !== 'tool_call' || text(update.status) !== 'completed') return undefined;

  const paths = locationPaths(update);
  if (paths.length === 0) return undefined;
  const toolName = KIND_TOOL_NAMES[text(update.kind) ?? ''] ?? 'Edit';
  return {
    event: 'session-event',
    raw: {
      conversation_id: sessionId ?? 'acp',
      tool_name: toolName,
      changed_paths: paths,
      title: text(update.title),
    },
  };
}

export interface AcpProxyOptions {
  /** Injected by tests; production spawns a real child. */
  spawnAgent?: typeof spawn;
  cwd?: string;
}

/**
 * Relay stdin/stdout between an editor and an ACP agent, observing as it goes.
 *
 * Resolves with the agent's exit code so the caller can exit with it -- the editor treats this
 * process as the agent, so its status has to be the agent's.
 */
export async function runAcpProxy(
  command: string,
  args: string[],
  options: AcpProxyOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const spawnFn = options.spawnAgent ?? spawn;
  const child = spawnFn(command, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });

  // Resolved once, lazily, and never retried: an ACP session outlives many messages, and a
  // directory that is not a Knowl project stays one for the life of the process.
  let project: Promise<{ id: string; root: string } | null> | undefined;
  const knowlProject = () => {
    if (!project) {
      project = (async () => {
        const root = await findProjectRoot(cwd);
        await initDb(root);
        const found = await getProjectByRootPath(root);
        return found ? { id: found.id, root } : null;
      })().catch(error => {
        // Not a Knowl repository is the ordinary case for an editor opened anywhere else.
        if (!(error instanceof ProjectNotFoundError)) {
          console.error(`knowl acp: memory unavailable (${(error as Error).message})`);
        }
        return null;
      });
    }
    return project;
  };

  async function observe(line: string): Promise<void> {
    try {
      const message = JSON.parse(line) as JsonRpc;
      const mapped = eventFor(message);
      if (!mapped) return;
      const found = await knowlProject();
      if (!found) return;
      const normalized = normalizeHostHook('generic', mapped.event, {
        ...mapped.raw,
        cwd: found.root,
        sessionId: text(mapped.raw.conversation_id) ?? 'acp',
        type: mapped.event === 'session-event' ? 'checkpoint' : undefined,
        changedPaths: mapped.raw.changed_paths,
      });
      await handleHostLifecycleEvent(found.id, normalized);
    } catch {
      // Observation is never worth interrupting the relay for. A message this build does not
      // understand is the normal case for a protocol both ends may be ahead of us on.
    }
  }

  /** Relay a stream line by line, forwarding the original text and observing a parsed copy. */
  const relay = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream, watch: boolean) => {
    const lines = createInterface({ input: from, crlfDelay: Infinity });
    lines.on('line', line => {
      // Forwarded first and unchanged. Observation must never sit between two programs and
      // their next message, and must never be able to alter one.
      to.write(`${line}\n`);
      if (watch) void observe(line);
    });
    return lines;
  };

  relay(process.stdin, child.stdin!, true);
  relay(child.stdout!, process.stdout, true);

  return new Promise<number>(resolve => {
    child.on('error', error => {
      console.error(`knowl acp: could not start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('close', async code => {
      await closeDb().catch(() => {});
      resolve(code ?? 0);
    });
  });
}
