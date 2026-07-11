import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeCategory } from '../core/types.js';
import { getRecentContext } from '../store/recent-context.js';
import { formatRecentContextToMarkdown, formatHierarchyToMarkdown } from '../core/format.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';

export function registerResources(
  server: Server,
  getProjectId: () => string | null,
  getInitError: () => string | null
): void {
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
        {
          uri: 'knowl://recent',
          name: 'Recent Session Context',
          description: 'Compact fallback context for resuming a project session; lifecycle bootstrap returns the same bounded source automatically when supported.',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // 2. Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const initError = getInitError();
    const projectId = getProjectId();

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
      if (uri === 'knowl://recent') {
        const context = await getRecentContext(projectId!);
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: formatRecentContextToMarkdown(context),
            },
          ],
        };
      }

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
}
