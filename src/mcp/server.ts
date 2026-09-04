import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { mcpModeLineForHost } from '../session/hosts/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProjectConfig } from '../core/types.js';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { ProjectNotFoundError } from '../core/errors.js';
import { initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { adoptProject, scaffoldProject, scaffoldTarget, serveAutoInitAllowed } from './auto-init.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  KNOWL_MCP_TOOL_NAMES,
  mcpServerInstructions,
} from '../core/knowl-guidance.js';
import { beginStartupTrace, finishStartupTrace, serveBanner, tracePhase } from '../core/startup-trace.js';
import { knowlHome } from '../core/paths.js';
import { globalOnlyNamespaces } from '../store/namespaces.js';

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
  /** Appended to the instructions card verbatim; auto-init announces itself through this. */
  instructionsSuffix?: string;
  /**
   * The lifecycle sentence for the host that registered this server, from `serve --host`.
   *
   * Absent keeps today's neutral card, which is what every MCP config written before this
   * existed still produces -- so an install that predates the flag keeps working unchanged and
   * simply keeps reading the conditional line.
   */
  modeLine?: string;
  /** The host name from `serve --host`, for anything that must not double up with its hooks. */
  host?: string;
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
  // Register tools and resources
  const getConfig = deferred.getConfig ?? (() => config);

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
      // From the getter, not the positional argument. The real startup passes `null`
      // positionally and hands the live config over through `deferred`, so this card was
      // always built from a null config in production -- the transcript routing line existed
      // and reached nobody. Only the tests, which construct positionally, ever saw it.
      //
      // The SDK captures this string in the constructor and replays it in the initialize
      // response, so it cannot be recomputed later; `startMcpServer` settles the config read
      // before building the server for exactly that reason.
      // The suffix exists for auto-init: stderr is dropped by most hosts, so a banner there
      // is invisible, while this card is captured at construction and replayed to the model.
      // One line naming the directory serve created state in is the difference between a
      // silent store and an invisible one.
      instructions: mcpServerInstructions(getConfig(), deferred.modeLine) + (deferred.instructionsSuffix ?? ''),
    }
  );

  const getProjectId = deferred.getProjectId ?? (() => projectId);
  const getInitError = deferred.getInitError ?? (() => initError);

  registerTools(
    server,
    getProjectId,
    deferred.getProjectRoot ?? (() => projectRoot),
    getConfig,
    getInitError,
    deferred.whenReady ?? (async () => {}),
    () => deferred.host
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
 * Those two numbers arrived with the audit branch, which is why this note used to describe
 * a smaller exposure and attribute the larger one to a fork. The retrying pool is this
 * repo's now, so the arithmetic above is this repo's too. The structure was wrong either
 * way -- unbounded work sitting on a bounded deadline -- and a slow open for any other
 * reason, a large migration, a network-backed disk, a loaded machine, lands on the same
 * deadline.
 *
 * Nothing in the handshake needs the database: the tool list is a static literal and the
 * declared capabilities are constants. So connect first and initialize behind it. Tool calls
 * await `ready`, and they answer to the tool-call timeout -- hours, not seconds -- which is
 * the right clock for work whose duration depends on what other processes are doing.
 *
 * The startup trace deliberately stays armed until initialization settles, so a database that
 * is still stuck at 25s says so on stderr even though the handshake itself already succeeded.
 */
/**
 * Whether a failed project resolution may be answered from the global store instead.
 *
 * Only when there was no project to find. The block this guards resolves the root *and* loads the
 * config, so "there is no project here" and "this project's config is broken" arrive at the same
 * `catch` — and treating them alike makes a repository with a malformed config serve someone's
 * machine-wide preferences while looking healthy, with its own memory reading as empty. A project
 * that exists and cannot be opened stays an error.
 *
 * Its own function so the rule can be asserted without booting a server, which is the only reason
 * it was ever easy to get wrong.
 */
export function shouldServeGlobalOnly(error: unknown, hasGlobalStore: boolean): boolean {
  return error instanceof ProjectNotFoundError && hasGlobalStore;
}

export async function startMcpServer(options: { host?: string } = {}): Promise<void> {
  beginStartupTrace({ version: PACKAGE_VERSION });

  let projectRoot: string | null = null;
  let config: ProjectConfig | null = null;
  let project: any = null;
  let initError: string | null = null;

  // Root and config settle BEFORE the server is built, deliberately, and they are the only
  // two things that do. Neither is the database open the handshake is racing -- one walks
  // directories and one reads a JSON file -- and the `instructions` card is captured by the
  // SDK at construction, so a config that arrives afterwards can never reach a client.
  let autoInitialized = false;
  try {
    projectRoot = await tracePhase('findProjectRoot', () => findProjectRoot(process.cwd()));
    config = await tracePhase('loadConfig', () => loadConfig(projectRoot!));
  } catch (error: any) {
    // The catalog-install case: nobody ever ran `knowl init`, and nobody could have -- no
    // marketplace install flow contains a step that would (see auto-init.ts). Scaffold here,
    // because it is filesystem-only and the config it writes is what the `instructions` card
    // needs before the server is built; the database half waits for `ready` below.
    //
    // `scaffoldTarget` may refuse -- no git repository to anchor on, or the target is the
    // machine's Knowl home -- and the refusal deliberately lands on the ordinary
    // ProjectNotFoundError message: for a directory whose owner expressed no intent, "run
    // knowl init" is the right guidance, not a store they never asked for.
    const target = error instanceof ProjectNotFoundError && serveAutoInitAllowed()
      ? await tracePhase('autoInitTarget', () => scaffoldTarget(process.cwd()))
      : null;
    if (target) {
      try {
        projectRoot = target;
        await tracePhase('autoInitScaffold', () => scaffoldProject(target));
        config = await tracePhase('autoInitLoadConfig', () => loadConfig(target));
        autoInitialized = true;
      } catch (scaffoldError: any) {
        // Prefixed so `formatInitError` can tell "serve tried to create a store and could
        // not" apart from "there is no store" -- the guidance differs, because the agent
        // reading it must not be told to run the thing that just failed.
        initError = `Automatic initialization failed: ${scaffoldError.message}`;
      }
    } else if (shouldServeGlobalOnly(error, globalOnlyNamespaces().length > 0)) {
      // No project anywhere above this directory, and a global store exists: serve the
      // personal-defaults layer alone. That is the Hermes Desktop session with no folder open,
      // and `knowl` run outside a repository.
      //
      // **Only for `ProjectNotFoundError`.** The `try` above also runs `loadConfig`, so without
      // this guard a project whose config is malformed -- present, findable, and broken -- fell
      // through to the same branch and served personal defaults instead of reporting the error.
      // The repository's own memory would read as empty while the server looked healthy, which
      // is the silent wrong scope this layer exists to prevent. A project that exists and cannot
      // be opened stays an error.
      projectRoot = null;
      config = await tracePhase('globalLoadConfig', () => loadConfig(knowlHome()));
      initError = null;
    } else {
      initError = error.message;
    }
  }

  // Never rejects: every failure is captured as `initError`, which the tools already render
  // for the user. An unhandled rejection here would take down a server that is otherwise fine.
  const ready = (async () => {
    if (initError) return;
    try {
      if (projectRoot) {
        // Init DB. AI is optional and initialized lazily only for AI-backed tools.
        await tracePhase('initDb', () => initDb(projectRoot!));

        // Get project details
        project = await tracePhase('getProject', () => getProjectByRootPath(projectRoot!));
        if (autoInitialized) {
          // The scaffold above made the directory a root; this finishes what init would have:
          // the machine registry entry and the `.gitignore` line. Not gated on `!project`,
          // because `getProjectByRootPath` synthesizes the local project for any root — a
          // truthy project says nothing about whether those two side effects ever happened.
          // Behind the handshake because it opens the database, which is the work the connect
          // deadline must not wait on.
          project = await tracePhase('adoptProject', () => adoptProject(projectRoot!));
        }
        if (!project) {
          throw new Error('Knowl project is not initialized. Run "knowl init" first.');
        }
      } else {
        project = { id: 'local', name: 'global', rootPath: knowlHome() };
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
    modeLine: mcpModeLineForHost(options.host),
    host: options.host,
    ...(autoInitialized ? {
      // The path is collapsed to single spaces before it goes in: this card is the
      // highest-trust text the server hands a model, and a POSIX directory name may contain
      // a newline, which would let a crafted checkout append its own lines to it.
      instructionsSuffix:
        `\nNOTE: no Knowl store existed here, so serve created an empty one at "${projectRoot!.replace(/\s+/g, ' ')}"` +
        ' (KNOWL_DISABLE_SERVE_AUTO_INIT=1 prevents this). Memory starts empty; what you store' +
        ' this session is what later sessions will find.',
    } : {}),
  });

  const transport = new StdioServerTransport();
  const connectedAt = Date.now();
  await tracePhase('connect', () => server.connect(transport));

  // Printed after the handshake rather than after initialization: this line is the host log's
  // proof that the process is alive and talking, and it used to be withheld until the slowest
  // part of startup had finished -- which is why a stalled boot left no evidence but a banner.
  //
  // The root is already known here, unlike in the version this replaces: settling it before
  // the server is built (see above) is what the `instructions` card needs, and it means the
  // very first line a host log gets can name its repository instead of saying `unresolved`
  // and correcting itself later.
  process.stderr.write(serveBanner({ pid: process.pid, projectRoot, autoInitialized }) + '\n');

  void ready.then(() => {
    // The second line is about the database, which the first could not wait for. `readyMs`
    // is the number that separates "connected and working" from "connected and stuck".
    process.stderr.write(
      serveBanner({
        pid: process.pid, projectRoot, autoInitialized, readyMs: Date.now() - connectedAt,
      }) + '\n',
    );
    finishStartupTrace({
      ok: !initError,
      initError,
      vectorModel: (config as any)?.search?.vector?.model ?? null,
    });
  });
}
