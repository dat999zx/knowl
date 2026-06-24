import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getProjectByRootPath } from '../store/repository.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { askQuestion, filterInput, extractKnowledge, compareKnowledge } from '../ai/provider.js';
import * as repo from '../store/repository.js';
import { ProjectConfig, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { initDb } from '../store/database.js';
import { initAI } from '../ai/provider.js';

/**
 * Creates and configures the MCP Server.
 */
export function createMcpServer(projectId: string, projectRoot: string, config: ProjectConfig): Server {
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
          description: 'Get the full current active state of the project, including goals, constraints, architecture, decisions, and active tasks.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_decide',
          description: 'Record a specific project decision directly into the knowledge base.',
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
          description: 'Query the knowledge base using search term, category, tag, or status filters.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Text search term to match titles, content, or reasoning.',
              },
              category: {
                type: 'string',
                enum: ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'],
                description: 'Filter by specific knowledge category.',
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
            },
          },
        },
        {
          name: 'knowl_ask',
          description: 'Ask a natural language question about the project. Knowl will search the knowledge base and construct a comprehensive answer.',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question to ask.',
              },
            },
            required: ['question'],
          },
        },
        {
          name: 'knowl_update',
          description: 'Update the metadata, status, or content of an existing knowledge item.',
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

    try {
      if (name === 'knowl_ingest') {
        const { text, commitMessage, autoResolve } = args as any;
        const result = await runPipeline(projectId, text, config, {
          autoResolveContradictions: autoResolve ?? false,
          commitMessage: commitMessage || 'Ingest via MCP tool',
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } 
      
      else if (name === 'knowl_state') {
        const hierarchy = await getHierarchicalKnowledge(projectId);
        const md = formatHierarchyToMarkdown(hierarchy);
        return {
          content: [{ type: 'text', text: md }],
        };
      } 
      
      else if (name === 'knowl_decide') {
        const { title, content, reasoning, alternatives, tags } = args as any;
        const item = await repo.createKnowledgeItem(projectId, {
          category: 'decision',
          title,
          content,
          reasoning,
          alternatives,
          tags: tags || [],
        });

        // Record a commit for direct creation
        await repo.createKnowledgeCommit(projectId, `Record decision: ${title}`, [
          { itemId: item.id, action: 'insert', after: item }
        ]);

        return {
          content: [{ type: 'text', text: `Successfully recorded decision ${item.id}:\n\n${JSON.stringify(item, null, 2)}` }],
        };
      } 
      
      else if (name === 'knowl_query') {
        const { query, category, status, tags } = args as any;
        const items = await queryKnowledgeBase(projectId, {
          query,
          category: category as KnowledgeCategory,
          status: status as KnowledgeStatus,
          tags,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        };
      } 
      
      else if (name === 'knowl_ask') {
        const { question } = args as any;
        const hierarchy = await getHierarchicalKnowledge(projectId);
        const contextMarkdown = formatHierarchyToMarkdown(hierarchy);
        const answer = await askQuestion(question, contextMarkdown);

        return {
          content: [{ type: 'text', text: answer }],
        };
      } 
      
      else if (name === 'knowl_update') {
        const { id, title, content, status, reasoning } = args as any;
        
        const beforeItem = await repo.getKnowledgeItem(id);
        if (!beforeItem) {
          throw new Error(`Knowledge item not found with ID ${id}`);
        }

        const updated = await repo.updateKnowledgeItem(id, {
          title,
          content,
          status: status as KnowledgeStatus,
          reasoning,
        });

        await repo.createKnowledgeCommit(projectId, `Update item: ${updated.title}`, [
          {
            itemId: id,
            action: status && status !== beforeItem.status ? (status as any) : 'update',
            before: beforeItem,
            after: updated,
          }
        ]);

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

    try {
      if (uri === 'knowl://brain') {
        const hierarchy = await getHierarchicalKnowledge(projectId);
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
        const items = await queryKnowledgeBase(projectId, {
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
  const projectRoot = await findProjectRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  
  // Init DB and AI
  await initDb(projectRoot);
  initAI(config.ai);

  // Get project details
  const project = await getProjectByRootPath(projectRoot);
  if (!project) {
    throw new Error('Knowl project is not initialized. Run "knowl init" first.');
  }

  const server = createMcpServer(project.id, projectRoot, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Formats a hierarchical knowledge object into clean readable markdown.
 */
function formatHierarchyToMarkdown(hierarchy: {
  state: any[];
  knowledge: any[];
  skills: any[];
  archive: any[];
}): string {
  let md = `# KNOWL — PROJECT BRAIN STATE\n\n`;

  // Goals & Constraints
  const goals = hierarchy.knowledge.filter(x => x.category === 'goal');
  const constraints = hierarchy.knowledge.filter(x => x.category === 'constraint');
  
  md += `## 🎯 GOALS\n\n`;
  if (goals.length === 0) md += `No active goals recorded.\n\n`;
  else goals.forEach(g => { md += `- **${g.title}**: ${g.content}\n`; });
  md += `\n`;

  md += `## ⚠️ CONSTRAINTS\n\n`;
  if (constraints.length === 0) md += `No active constraints recorded.\n\n`;
  else constraints.forEach(c => { md += `- **${c.title}**: ${c.content}\n`; });
  md += `\n`;

  // Active state
  md += `## ⚡ ACTIVE STATE\n\n`;
  if (hierarchy.state.length === 0) md += `No active state updates recorded.\n\n`;
  else {
    hierarchy.state.forEach(s => {
      md += `### ${s.title} (ID: ${s.id})\n${s.content}\n\n`;
    });
  }

  // Decisions & Architecture
  const decisions = hierarchy.knowledge.filter(x => x.category === 'decision');
  const arch = hierarchy.knowledge.filter(x => x.category === 'architecture');
  const facts = hierarchy.knowledge.filter(x => x.category === 'fact');

  md += `## 🏛️ ARCHITECTURE\n\n`;
  if (arch.length === 0) md += `No active architecture specifications.\n\n`;
  else {
    arch.forEach(a => {
      md += `### ${a.title}\n${a.content}\n\n`;
    });
  }

  md += `## 💡 DECISIONS\n\n`;
  if (decisions.length === 0) md += `No active decisions recorded.\n\n`;
  else {
    decisions.forEach(d => {
      md += `### ${d.title} (ID: ${d.id})\n${d.content}\n`;
      if (d.reasoning) md += `**Reasoning:** ${d.reasoning}\n`;
      if (d.alternatives && d.alternatives.length > 0) {
        md += `**Alternatives considered:** ${d.alternatives.join(', ')}\n`;
      }
      md += `\n`;
    });
  }

  md += `## 📋 GENERAL FACTS\n\n`;
  if (facts.length === 0) md += `No general facts recorded.\n\n`;
  else {
    facts.forEach(f => {
      md += `- **${f.title}**: ${f.content}\n`;
    });
    md += `\n`;
  }

  // Learned skills
  md += `## 🛠️ LEARNED SKILLS\n\n`;
  if (hierarchy.skills.length === 0) md += `No skills learned yet.\n\n`;
  else {
    hierarchy.skills.forEach(s => {
      md += `### ${s.title} (ID: ${s.id})\n${s.content}\n\n`;
    });
  }

  return md;
}
