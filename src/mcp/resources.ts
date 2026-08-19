import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeCategory } from '../core/types.js';
import { getRecentContext } from '../store/recent-context.js';
import { formatRecentContextToMarkdown, formatHierarchyToMarkdown } from '../core/format.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, MAX_PREVIEW_CHARS, MAX_TITLE_CHARS, truncateMiddle, truncateText } from '../core/token-budget.js';
import { fenceUntrusted, inlineUntrusted, UNTRUSTED_NOTICE_BRIEF } from '../core/untrusted.js';
import { formatInitError } from './init-error.js';
import { sanitizeToolErrorMessage } from './tool-schema.js';

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
        
        // The third markdown route out of this file, and the one that was left raw. The two
        // above it are contained because they go through the format.ts helpers; this one builds
        // its own markdown and interpolated a stored body straight after a `##`, which is the
        // exact shape `formatHierarchyToMarkdown` was fixed for. Same store, same reader, same
        // defect -- a resource read is answered by the agent's own client with nobody looking.
        //
        // Truncate first, then contain, for the reason `format.ts` gives: otherwise a body whose
        // fence run sits past the ceiling picks the fence length for text that is then cut away.
        let md = `# Active ${category.toUpperCase()} Items\n\n${UNTRUSTED_NOTICE_BRIEF}\n\n`;
        if (items.length === 0) {
          md += `No active items recorded in this category.`;
        } else {
          for (const item of items.slice(0, DEFAULT_RESULT_LIMIT)) {
            md += `## ${inlineUntrusted(truncateText(item.title, MAX_TITLE_CHARS))} (ID: ${item.id})\n\n`;
            // A body keeps its shape, inside a container it cannot close.
            md += `${fenceUntrusted(truncateMiddle(item.content, MAX_ITEM_CONTENT_CHARS))}\n\n`;
            if (item.reasoning) md += `**Reasoning:** ${inlineUntrusted(truncateText(item.reasoning, MAX_PREVIEW_CHARS))}\n\n`;
            if (item.alternatives && item.alternatives.length > 0) {
              md += `**Alternatives:** ${inlineUntrusted(truncateText(item.alternatives.join(', '), MAX_PREVIEW_CHARS))}\n\n`;
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

      // The spec is explicit: a resource that does not exist MUST come back as -32602
      // (Invalid params), and -32603 (Internal error) is reserved for the server having
      // failed. Thrown as a plain Error this fell into the catch below, was re-wrapped, and
      // the SDK mapped it to -32603 -- so knowl reported the caller's bad URI as its own
      // fault, and a client could not tell "you asked for something that isn't here" from
      // "this server is broken". McpError carries the code through the re-wrap untouched.
      throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      // The second place a raw driver message can reach a client. No resource URI carries a
      // caller-supplied field, so the missing-argument route into it does not exist here --
      // but "statement text and bound parameters never leave the process" is the rule, and a
      // rule with one unguarded exit is the shape of the finding, not a fix for it.
      // The cause is attached but never rendered: `sanitizeToolErrorMessage` decides what reaches
      // the client, and this keeps the original for a local stack trace without widening that.
      throw new Error(
        `Error reading resource "${uri}": ${sanitizeToolErrorMessage(String(error?.message ?? error))}`,
        { cause: error },
      );
    }
  });
}
