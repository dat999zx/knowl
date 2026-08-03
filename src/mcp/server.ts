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
import { beginStartupTrace, finishStartupTrace, tracePhase } from '../core/startup-trace.js';

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
 * writing to, and the pool waits out a lock rather than failing on it: `busy_timeout` is 10s
 * and `acquireClient` retries five times. That is a bound of roughly 50s of legitimate,
 * working-as-designed waiting on a 30s deadline, so a busy machine could not help but lose
 * the race. Twenty-two recorded kills across four repos are that arithmetic, not a fault.
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
  await tracePhase('connect', () => server.connect(transport));

  // Printed after the handshake rather than after initialization: this line is the host log's
  // proof that the process is alive and talking, and it used to be withheld until the slowest
  // part of startup had finished -- which is why a stalled boot left no evidence but a banner.
  process.stderr.write(
    [
      '[knowl serve]',
      `pid=${process.pid}`,
      'projectRoot=pending',
      'note=host-owned stdio process; one serve process per connected host session; hooks use agent-hook and do not spawn serve',
    ].join(' ') + '\n'
  );

  void ready.then(() => {
    finishStartupTrace({
      ok: !initError,
      initError,
      vectorModel: (config as any)?.search?.vector?.model ?? null,
    });
  });
}
