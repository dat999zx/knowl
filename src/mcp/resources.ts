import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeCategory } from '../core/types.js';
import { getRecentContext } from '../store/recent-context.js';
import { formatRecentContextToMarkdown, formatHierarchyToMarkdown } from '../core/format.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, truncateText } from '../core/token-budget.js';
import { formatInitError } from './init-error.js';

export function registerResources(
  server: Server,
  getProjectId: () => string | null,
  getInitError: () => string | null,
  // Same reason as `registerTools`: the handshake now completes before the database is open,
  // so a read arriving early would see neither a project id nor an init error and proceed
  // against null. Listing resources is a static literal and needs no such wait.
  whenReady: () => Promise<void> = async () => {}
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
          description: 'Compact recent context only when lifecycle bootstrap is unavailable (including manual mode) or an explicit refresh is needed.',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // 2. Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    await whenReady();
    const initError = getInitError();
    const projectId = getProjectId();

    if (initError) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: formatInitError(initError),
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
          for (const item of items.slice(0, DEFAULT_RESULT_LIMIT)) {
            md += `## ${truncateText(item.title, MAX_ITEM_CONTENT_CHARS)} (ID: ${item.id})\n\n${truncateText(item.content, MAX_ITEM_CONTENT_CHARS)}\n\n`;
            if (item.reasoning) md += `**Reasoning:** ${truncateText(item.reasoning, MAX_ITEM_CONTENT_CHARS)}\n\n`;
            if (item.alternatives && item.alternatives.length > 0) {
              md += `**Alternatives:** ${truncateText(item.alternatives.join(', '), MAX_ITEM_CONTENT_CHARS)}\n\n`;
            }
            md += `---\n\n`;
          }
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: truncateText(md, DEFAULT_CONTEXT_MAX_CHARS, '[Context truncated]'),
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
