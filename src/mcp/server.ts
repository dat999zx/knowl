import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { getProjectByRootPath } from '../store/repository.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { queryKnowledgeForAgent } from '../store/agent-query.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../store/knowledge-actions.js';
import { storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../store/knowledge-writer.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { ProjectConfig, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { findProjectRoot, hasAiConfigured, loadConfig } from '../core/config.js';
import { initDb } from '../store/database.js';
import { initAI } from '../ai/provider.js';
import { formatHierarchyToMarkdown } from '../core/format.js';

const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'];

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

  // --- TOOLS DEFINITIONS ---

  // 1. List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'knowl_ingest',
          description: 'Process raw text or conversational inputs (like decision discussions, developer notes, or bug reports) through the Knowl pipeline to filter, extract, and store verified knowledge.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The raw text or conversation log to ingest.',
              },
              commitMessage: {
                type: 'string',
                description: 'Optional human-readable description for the knowledge commit.',
              },
              autoResolve: {
                type: 'boolean',
                description: 'Whether to auto-resolve contradictions by superseding old knowledge (defaults to false).',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'knowl_state',
          description: 'Get the full current active state of the project. Use for broad project-memory summaries, status checks, or full-state requests; prefer knowl_query for specific factual questions.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_store',
          description: 'Store one concise structured knowledge atom directly, not raw chat transcripts. Use after discovering durable project knowledge or completing work. This is deterministic and does not require Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                enum: KNOWLEDGE_CATEGORIES,
                description: 'Knowledge category.',
              },
              title: {
                type: 'string',
                description: 'Concise title for the knowledge item.',
              },
              content: {
                type: 'string',
                description: 'Knowledge content in markdown or plain text.',
              },
              reasoning: {
                type: 'string',
                description: 'Optional reasoning or justification.',
              },
              alternatives: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional alternatives considered for decisions.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags.',
              },
              source: {
                type: 'string',
                description: 'Optional source label.',
              },
              confidence: {
                type: 'number',
                description: 'Optional confidence from 0.0 to 1.0.',
              },
              steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ordered steps when category is skill.',
              },
            },
            required: ['category', 'title', 'content'],
          },
        },
        {
          name: 'knowl_ingest_atoms',
          description: 'Store pre-extracted structured knowledge atoms from an MCP client. Do not store raw chat transcripts; extract durable facts, decisions, constraints, architecture, state, skills, and batch store implementation summaries first. This is the preferred MCP ingestion path and does not require Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              atoms: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', enum: KNOWLEDGE_CATEGORIES },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    reasoning: { type: 'string' },
                    alternatives: { type: 'array', items: { type: 'string' } },
                    tags: { type: 'array', items: { type: 'string' } },
                    source: { type: 'string' },
                    confidence: { type: 'number' },
                    steps: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['category', 'title', 'content'],
                },
                description: 'Structured knowledge atoms extracted by the MCP client model.',
              },
              commitMessage: {
                type: 'string',
                description: 'Optional commit message for the batch.',
              },
            },
            required: ['atoms'],
          },
        },
        {
          name: 'knowl_decide',
          description: 'Record a specific project decision directly into the knowledge base without requiring Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Descriptive title of the decision (e.g. "Use PostgreSQL").',
              },
              content: {
                type: 'string',
                description: 'The decision details (what was decided).',
              },
              reasoning: {
                type: 'string',
                description: 'The reasoning or justification for the choice.',
              },
              alternatives: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of alternative options considered.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags to organize this decision.',
              },
            },
            required: ['title', 'content', 'reasoning'],
          },
        },
        {
          name: 'knowl_query',
          description: 'Use this first for specific project questions. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Use 2-6 concise keywords from the user question, not the whole sentence. Example: "database sqlite persistence".',
              },
              category: {
                type: 'string',
                enum: ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'],
                description: 'Optional category hint. Omit unless you are certain; MCP queries retry without it on miss to avoid false negatives.',
              },
              status: {
                type: 'string',
                enum: ['active', 'deprecated', 'rejected', 'archived', 'superseded'],
                description: 'Filter by status (defaults to active).',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter items that contain all of these tags.',
              },
              limit: {
                type: 'number',
                description: 'Maximum results to return; defaults to 3 for MCP queries.',
              },
            },
          },
        },
        {
          name: 'knowl_update',
          description: 'Update the metadata, status, or content of an existing knowledge item. Use to correct stale or contradicted memory instead of adding duplicates.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The unique ID of the knowledge item.',
              },
              title: {
                type: 'string',
                description: 'New title.',
              },
              content: {
                type: 'string',
                description: 'New content markdown.',
              },
              status: {
                type: 'string',
                enum: ['active', 'deprecated', 'rejected', 'archived', 'superseded'],
                description: 'New status.',
              },
              reasoning: {
                type: 'string',
                description: 'Updated reasoning.',
              },
            },
            required: ['id'],
          },
        },
      ],
    };
  });

  // 2. Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (initError) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Knowl MCP Server is active but not initialized for the current directory.\nReason: ${initError}\n\nPlease run 'knowl init' in your project root to initialize this project.`,
          },
        ],
      };
    }

    try {
      if (name === 'knowl_ingest') {
        const { text, commitMessage, autoResolve } = args as any;
        if (!config || !hasAiConfigured(config)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Raw text ingestion requires explicit Knowl AI configuration. For MCP clients like Codex, extract knowledge with the client model and call knowl_ingest_atoms instead.',
              },
            ],
          };
        }

        initAI(config.ai!);
        const result = await runPipeline(projectId!, text, config!, {
          autoResolveContradictions: autoResolve ?? false,
          commitMessage: commitMessage || 'Ingest via MCP tool',
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } 
      
      else if (name === 'knowl_state') {
        const hierarchy = await getHierarchicalKnowledge(projectId!);
        const md = formatHierarchyToMarkdown(hierarchy);
        return {
          content: [{ type: 'text', text: md }],
        };
      } 

      else if (name === 'knowl_store') {
        const { category, title, content, reasoning, alternatives, tags, source, confidence, steps } = args as any;

        if (!KNOWLEDGE_CATEGORIES.includes(category)) {
          throw new Error(`Invalid knowledge category: ${category}`);
        }

        const result = await storeKnowledgeItemDeduped(
          projectId!,
          {
            category,
            title,
            content,
            reasoning,
            alternatives,
            tags,
            source,
            confidence,
            steps,
          },
          `Store ${category}: ${title}`
        );

        if (result.action === 'duplicate') {
          return {
            content: [{ type: 'text', text: `Matched existing ${category} ${result.item.id}; skipped duplicate insert` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Successfully stored ${category} ${result.item.id}` }],
        };
      }

      else if (name === 'knowl_ingest_atoms') {
        const { atoms, commitMessage } = args as any;

        if (!Array.isArray(atoms) || atoms.length === 0) {
          throw new Error('atoms must be a non-empty array');
        }

        for (const atom of atoms) {
          if (!KNOWLEDGE_CATEGORIES.includes(atom.category)) {
            throw new Error(`Invalid knowledge category: ${atom.category}`);
          }
        }

        const result = await storeKnowledgeAtomsDeduped(
          projectId!,
          atoms,
          commitMessage || `Store ${atoms.length} structured knowledge atom(s)`
        );

        return {
          content: [{ type: 'text', text: `Stored ${result.itemIds.length} knowledge atom(s): ${result.itemIds.join(', ')}` }],
        };
      }
      
      else if (name === 'knowl_decide') {
        const { title, content, reasoning, alternatives, tags } = args as any;
        const item = await recordDecisionDirect(projectId!, {
          title,
          content,
          reasoning,
          alternatives,
          tags: tags || [],
        }, `Record decision via MCP: ${title}`);

        return {
          content: [{ type: 'text', text: `Successfully recorded decision ${item.id}` }],
        };
      } 
      
      else if (name === 'knowl_query') {
        const { query, category, status, tags, limit } = args as any;
        const items = await queryKnowledgeForAgent(projectId!, {
          query,
          category: category as KnowledgeCategory,
          status: status as KnowledgeStatus,
          tags,
          limit,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        };
      } 
      
      else if (name === 'knowl_update') {
        const { id, title, content, status, reasoning } = args as any;
        const updated = await updateKnowledgeItemWithCommit(projectId!, id, {
          title,
          content,
          status: status as KnowledgeStatus,
          reasoning,
        });

        return {
          content: [{ type: 'text', text: `Successfully updated item ${id}:\n\n${JSON.stringify(updated, null, 2)}` }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing tool "${name}": ${error.message}` }],
      };
    }
  });

  // --- RESOURCES DEFINITIONS ---

  // 1. List resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'knowl://brain',
          name: 'Project Brain State',
          description: 'A markdown document summarizing the full active goals, constraints, architecture, decisions, and tasks.',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // 2. Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (initError) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `❌ Knowl MCP Server is active but not initialized for the current directory.\nReason: ${initError}\n\nPlease run 'knowl init' in your project root to initialize this project.`,
          },
        ],
      };
    }

    try {
      if (uri === 'knowl://brain') {
        const hierarchy = await getHierarchicalKnowledge(projectId!);
        const md = formatHierarchyToMarkdown(hierarchy);
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: md,
            },
          ],
        };
      }

      // Check category resource knowl://category/{name}
      const categoryMatch = uri.match(/^knowl:\/\/category\/([a-z]+)$/);
      if (categoryMatch) {
        const category = categoryMatch[1] as KnowledgeCategory;
        const items = await queryKnowledgeBase(projectId!, {
          category,
          status: 'active',
        });
        
        let md = `# Active ${category.toUpperCase()} Items\n\n`;
        if (items.length === 0) {
          md += `No active items recorded in this category.`;
        } else {
          for (const item of items) {
            md += `## ${item.title} (ID: ${item.id})\n\n${item.content}\n\n`;
            if (item.reasoning) md += `**Reasoning:** ${item.reasoning}\n\n`;
            if (item.alternatives && item.alternatives.length > 0) {
              md += `**Alternatives:** ${item.alternatives.join(', ')}\n\n`;
            }
            md += `---\n\n`;
          }
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: md,
            },
          ],
        };
      }

      throw new Error(`Resource not found: ${uri}`);
    } catch (error: any) {
      throw new Error(`Error reading resource "${uri}": ${error.message}`);
    }
  });

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
