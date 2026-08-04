import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProjectConfig } from '../core/types.js';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  KNOWL_MCP_TOOL_NAMES,
  mcpServerInstructions,
} from '../core/knowl-guidance.js';
import { beginStartupTrace, finishStartupTrace, serveBanner, tracePhase } from '../core/startup-trace.js';

export { KNOWL_MCP_TOOL_NAMES };

/**
 * Values the server does not have yet when it is built.
 *
 * `startMcpServer` completes the handshake before the database is open, so its project id,
 * root and config arrive later. Passing getters rather than values lets the same server
 * object serve both callers: tests hand over settled values positionally, and the real
 * startup hands over a window onto variables it is still filling in.
 */
export interface DeferredServerState {
  getProjectId?: () => string | null;
  getProjectRoot?: () => string | null;
  getConfig?: () => ProjectConfig | null;
  getInitError?: () => string | null;
  /** Resolves once initialization has settled, successfully or not. */
  whenReady?: () => Promise<void>;
}

/**
 * Creates and configures the MCP Server.
 */
export function createMcpServer(
  projectId: string | null,
  projectRoot: string | null,
  config: ProjectConfig | null,
  initError: string | null = null,
  deferred: DeferredServerState = {}
): Server {
  const server = new Server(
    {
      name: 'knowl-knowledge-server',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: mcpServerInstructions(config),
    }
  );

  // Register tools and resources
  const getProjectId = deferred.getProjectId ?? (() => projectId);
  const getInitError = deferred.getInitError ?? (() => initError);

  registerTools(
    server,
    getProjectId,
    deferred.getProjectRoot ?? (() => projectRoot),
    deferred.getConfig ?? (() => config),
    getInitError,
    deferred.whenReady ?? (async () => {})
  );

  registerResources(
    server,
    getProjectId,
    getInitError,
    deferred.whenReady ?? (async () => {})
  );

  return server;
}

/**
 * Utility to start the stdio transport server.
 *
 * **The handshake completes before the database opens, deliberately.**
 *
 * The host allows 30s for an MCP server to connect and then kills it. Opening the database
 * runs `bootstrapSchema` -- real writes -- against a file every other live session is also
 * writing to, and `busy_timeout = 5000` means each contended statement waits up to five
 * seconds rather than failing. Bootstrap issues many, so the wait compounds with the number
 * of processes racing, and none of it knows about the deadline it is being charged against.
 *
 * How bad that gets is deployment-specific. Twenty-two recorded kills of this shape came
 * from a fork that raises `busy_timeout` and retries in `acquireClient`, which turns "slow"
 * into "reliably fatal"; this repo has neither, so its exposure is smaller. The structure is
 * the same either way, and it is the structure that is wrong: unbounded work sitting on a
 * bounded deadline. A slow open for any reason -- a large migration, a network-backed disk,
 * a loaded machine -- lands on the connect deadline today.
 *
 * Nothing in the handshake needs the database: the tool list is a static literal and the
 * declared capabilities are constants. So connect first and initialize behind it. Tool calls
 * await `ready`, and they answer to the tool-call timeout -- hours, not seconds -- which is
 * the right clock for work whose duration depends on what other processes are doing.
 *
 * The startup trace deliberately stays armed until initialization settles, so a database that
 * is still stuck at 25s says so on stderr even though the handshake itself already succeeded.
 */
export async function startMcpServer(): Promise<void> {
  beginStartupTrace({ version: PACKAGE_VERSION });

  let projectRoot: string | null = null;
  let config: ProjectConfig | null = null;
  let project: any = null;
  let initError: string | null = null;

  // Never rejects: every failure is captured as `initError`, which the tools already render
  // for the user. An unhandled rejection here would take down a server that is otherwise fine.
  const ready = (async () => {
    try {
      projectRoot = await tracePhase('findProjectRoot', () => findProjectRoot(process.cwd()));
      config = await tracePhase('loadConfig', () => loadConfig(projectRoot!));

      // Init DB. AI is optional and initialized lazily only for AI-backed tools.
      await tracePhase('initDb', () => initDb(projectRoot!));

      // Get project details
      project = await tracePhase('getProject', () => getProjectByRootPath(projectRoot!));
      if (!project) {
        throw new Error('Knowl project is not initialized. Run "knowl init" first.');
      }
    } catch (error: any) {
      initError = error.message;
    }
  })();

  const server = createMcpServer(null, null, null, null, {
    getProjectId: () => (project ? project.id : null),
    getProjectRoot: () => projectRoot,
    getConfig: () => config,
    getInitError: () => initError,
    whenReady: () => ready,
  });

  const transport = new StdioServerTransport();
  const connectedAt = Date.now();
  await tracePhase('connect', () => server.connect(transport));

  // Printed after the handshake rather than after initialization: this line is the host log's
  // proof that the process is alive and talking, and it used to be withheld until the slowest
  // part of startup had finished -- which is why a stalled boot left no evidence but a banner.
  process.stderr.write(serveBanner({ pid: process.pid, projectRoot: null }) + '\n');

  void ready.then(() => {
    // The root the first line could not know yet. Without it every serve process in a host
    // log is anonymous, and "which repository is this one?" is the first question asked of it.
    process.stderr.write(
      serveBanner({ pid: process.pid, projectRoot, readyMs: Date.now() - connectedAt }) + '\n',
    );
    finishStartupTrace({
      ok: !initError,
      initError,
      vectorModel: (config as any)?.search?.vector?.model ?? null,
    });
  });
}
