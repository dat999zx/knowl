import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProjectConfig } from '../core/types.js';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

export const KNOWL_MCP_TOOL_NAMES = [
  'knowl_ingest',
  'knowl_state',
  'knowl_recent',
  'knowl_store',
  'knowl_ingest_atoms',
  'knowl_decide',
  'knowl_query',
  'knowl_update',
  'knowl_gc_preview',
  'knowl_gc_apply',
] as const;

/**
 * Creates and configures the MCP Server.
 */
export function createMcpServer(
  projectId: string | null,
  projectRoot: string | null,
  config: ProjectConfig | null,
  initError: string | null = null
): Server {
  const server = new Server(
    {
      name: 'knowl-knowledge-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // Register tools and resources
  registerTools(
    server,
    () => projectId,
    () => projectRoot,
    () => config,
    () => initError
  );

  registerResources(
    server,
    () => projectId,
    () => initError
  );

  return server;
}

/**
 * Utility to start the stdio transport server.
 */
export async function startMcpServer(): Promise<void> {
  let projectRoot: string | null = null;
  let config: ProjectConfig | null = null;
  let project: any = null;
  let initError: string | null = null;

  try {
    projectRoot = await findProjectRoot(process.cwd());
    config = await loadConfig(projectRoot);
    
    // Init DB. AI is optional and initialized lazily only for AI-backed tools.
    await initDb(projectRoot);

    // Get project details
    project = await getProjectByRootPath(projectRoot);
    if (!project) {
      throw new Error('Knowl project is not initialized. Run "knowl init" first.');
    }
  } catch (error: any) {
    initError = error.message;
  }

  const server = createMcpServer(
    project ? project.id : null,
    projectRoot,
    config,
    initError
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
