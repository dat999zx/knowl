import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureChangeWatermark, consumeChangeNotice } from './change-notice.js';
import { KNOWLEDGE_CATEGORIES, ProjectConfig, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { assertOwnedItem } from '../workspace/ownership.js';
import { queryFederated, type FederatedResult } from '../workspace/federated-query.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { formatHierarchyToMarkdown, formatRecentContextToMarkdown } from '../core/format.js';
import { compactMcpJson, compactItemResponse, compactAssertionResponse, boundedEvidence } from './response-format.js';
import { MAX_ITEM_CONTENT_CHARS, truncateText } from '../core/token-budget.js';
import { getRecentContext } from '../store/recent-context.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../store/knowledge-writer.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../store/knowledge-actions.js';
import { isVectorSearchEnabled, createLocalEmbeddingProvider, getVectorSearchConfig } from '../ai/embeddings.js';
import { queryKnowledgeForAgent, queryKnowledgeForAgentExplained } from '../store/agent-query.js';
import { previewKnowledgeGc, applyKnowledgeGc } from '../store/gc.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop } from '../store/work-loop.js';
import { formatInitError } from './init-error.js';
import { indexSkillPackage, recordSkillRun } from '../skills/knowledge-index.js';
import { createSkillPackage, listSkillPackages, readSkillPackage, runSkillPackage } from '../skills/registry.js';
import { KnowledgeValidationError } from '../core/knowledge-validation.js';
import { isEvidenceStale, listEvidenceForItem } from '../store/evidence-repository.js';
import { recordKnowledgeFeedback } from '../store/access-feedback.js';
import { finishMemorySession } from '../store/session-repository.js';
import { finalizeMemorySession } from '../store/session-finalizer.js';
import { configuredNamespaces, namespaceDescriptor, queryLayeredKnowledge, withNamespaceDatabase } from '../store/namespaces.js';


// The write engine never discards content, so a write can leave memory in one of two
// states the caller should know about: a predecessor was retired, or an overlapping item
// is still active beside the new one. Both are reported in the tool result rather than
// only in the tool description, because that is the one channel every MCP client model
// reads back regardless of how it treats schema prose.
export function describeWriteReconciliation(result: {
  item: { id: string };
  superseded?: { id: string; title: string };
  nearDuplicate?: { id: string; title: string };
  crossRepo?: Array<{ repo: string; id: string; title: string; kind: 'conflict' | 'duplicate'; kin?: boolean; role?: string }>;
}): string {
  const notes: string[] = [];
  if (result.superseded) {
    notes.push(`Retired the superseded predecessor ${result.superseded.id} ("${result.superseded.title}"); it is no longer active but stays queryable.`);
  }
  if (result.nearDuplicate) {
    notes.push(`STILL ACTIVE: overlapping item ${result.nearDuplicate.id} ("${result.nearDuplicate.title}") was kept, so memory now holds both. If your write corrects or replaces it, retire it now with knowl_update using id "${result.item.id}" and supersedeId "${result.nearDuplicate.id}". If both are genuinely true, leave it.`);
  }
  // Deliberately different advice from the near-duplicate note above: that item belongs to
  // another repo, and knowl_update on it is refused by assertOwnedItem. Telling the agent to
  // retire it would point it at an operation that cannot succeed.
  for (const overlap of result.crossRepo ?? []) {
    const what = overlap.kind === 'conflict'
      ? `CONTRADICTS linked repo "${overlap.repo}"`
      : `OVERLAPS linked repo "${overlap.repo}"`;
    const describes = overlap.role ? ` (${overlap.role})` : '';
    // Only for kin. An unrelated repo's advisory must stay exactly as it was, or every
    // cross-repo note grows a clause that means nothing.
    const lineage = overlap.kin
      ? ` That repo shares this repo's lineage, so a same-subject item is more likely a real divergence in convention than a coincidence of wording.`
      : '';
    notes.push(`${what}${describes}: item ${overlap.id} ("${overlap.title}"). You cannot retire or edit it from this repo -- it belongs to "${overlap.repo}". Your write stands; if the two genuinely disagree, raise it with whoever owns that repo.${lineage}`);
  }
  return notes.length ? ` ${notes.join(' ')}` : '';
}

export function registerTools(
  server: Server,
  getProjectId: () => string | null,
  getProjectRoot: () => string | null,
  getConfig: () => ProjectConfig | null,
  getInitError: () => string | null
): void {
  // 1. List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'knowl_ingest',
          description: 'Process explicitly supplied raw source text through the configured Knowl AI pipeline. Use only for an explicit ingestion request; never silently ingest the current conversation or prompt.',
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
            properties: { maxChars: { type: 'number', description: 'Maximum markdown characters; defaults to 3000.' } },
          },
        },
        {
          name: 'knowl_recent',
          description: 'Get compact recent session context only when lifecycle bootstrap is unavailable (including manual mode) or an explicit refresh is needed.',
          inputSchema: {
            type: 'object',
            properties: {
              itemLimit: {
                type: 'number',
                description: 'Maximum recent active knowledge items to return; defaults to 3.',
              },
              commitLimit: {
                type: 'number',
                description: 'Maximum recent knowledge commits to return; defaults to 8.',
              },
              maxChars: { type: 'number', description: 'Maximum markdown characters; defaults to 3000.' },
            },
          },
        },
        {
          name: 'knowl_store',
          description: 'Store one concise structured knowledge atom directly, not raw chat transcripts. Use immediately after discovering durable project knowledge or completing each subtask, not only at the end. This is deterministic and does not require Knowl AI configuration. When this atom corrects or replaces knowledge a query already returned, pass that item id as `supersedes` in this same call so the outdated item is retired in one write; never leave two active items asserting different values for the same thing. The result reports any item left active beside this one and the exact call to retire it.',
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
              sourceCommit: {
                type: 'string',
                description: 'Optional git commit where this knowledge was last reviewed.',
              },
              affectedPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional repository-relative file paths that this knowledge depends on.',
              },
              confidence: {
                type: 'number',
                description: 'Optional confidence from 0.0 to 1.0.',
              },
              conflictKey: { type: 'string', description: 'Optional normalized semantic identity key.' },
              conflictScope: { type: 'object', description: 'Optional scope for the conflict key.' },
              conflictExclusive: { type: 'boolean', description: 'Whether only one active value may exist for this key/scope.' },
              supersedes: { type: 'string', description: 'Id of an active item this write replaces; it is marked superseded (retired but still queryable), not deleted. Pass it whenever you are correcting knowledge a query returned. Independently of this field, any category whose title names the same subject as an existing item supersedes it automatically, and content is never silently dropped.' },
              steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ordered steps when category is skill.',
              },
              namespace: { type: 'string', enum: ['session', 'project', 'organization', 'global'], description: 'Write target; project is default. Non-project namespaces must be configured.' },
            },
            required: ['category', 'title', 'content'],
          },
        },
        {
          name: 'knowl_ingest_atoms',
          description: 'Store pre-extracted structured knowledge atoms from an MCP client. Do not store raw chat transcripts; extract durable facts, decisions, constraints, architecture, state, skills, and batch store implementation summaries during execution or after each completed subtask. This is the preferred MCP ingestion path and does not require Knowl AI configuration. When an atom corrects or replaces knowledge a query already returned, set `supersedes` on that atom to the outdated item id so it is retired in the same write; never leave two active items asserting different values for the same thing. The result reports each atom individually, including any overlapping item left active and the exact call to retire it.',
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
                    sourceCommit: { type: 'string' },
                    affectedPaths: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'number' },
                    steps: { type: 'array', items: { type: 'string' } },
                    supersedes: { type: 'string', description: 'Id of an active item this atom replaces; it is marked superseded (retired but still queryable), not deleted.' },
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
          description: 'Record a specific project decision directly into the knowledge base without requiring Knowl AI configuration. When this decision reverses or replaces an earlier one, pass that item id as `supersedes` so the superseded decision is retired in the same write; never leave two active decisions contradicting each other. The result reports any decision left active beside this one and the exact call to retire it.',
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
              supersedes: {
                type: 'string',
                description: 'Id of an active decision this one replaces; it is marked superseded (retired but still queryable), not deleted.',
              },
            },
            required: ['title', 'content', 'reasoning'],
          },
        },
        {
          name: 'knowl_query',
          description: 'Use this first for specific project questions, before each new subtask, and when switching areas during multi-step work. Query with 2-6 keywords. Skip only for directly relevant active lifecycle context, a same-request query, or relevant memory returned by knowl_task_start. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests.',
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
              includeEvidence: {
                type: 'boolean',
                description: 'Include linked evidence. Omit for compact results.',
              },
              explain: {
                type: 'boolean',
                description: 'Include ranking explanations. Omit for compact results.',
              },
              asOf: { type: 'string', description: 'ISO-8601 timestamp for historically valid content.' },
              repos: {
                type: 'array',
                items: { type: 'string' },
                description: 'Only in a workspace. Restrict results to knowledge produced by these linked repos. Matches the owning repo, not repos an item merely applies to.',
              },
            },
          },
        },
        {
          name: 'knowl_timeline',
          description: 'Inspect immutable assertions for one knowledge item when its history is needed.',
          inputSchema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
        },
        {
          name: 'knowl_conflicts',
          description: 'Inspect active exclusive conflict identities when a conflict must be resolved.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'knowl_context',
          description: 'Compose a diversified token-budgeted context pack.',
          inputSchema: { type: 'object', properties: { query: { type: 'string' }, task: { type: 'string' }, tokenBudget: { type: 'number' }, explain: { type: 'boolean', description: 'Include excluded-item diagnostics.' } }, required: ['tokenBudget'] },
        },
        {
          name: 'knowl_synthesize',
          description: 'Create or refresh one deterministic evidence-backed project understanding. This never runs automatically on normal writes.',
          inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] },
        },
        {
          name: 'knowl_evidence_list',
          description: 'Inspect evidence linked to one knowledge item when source support must be checked.',
          inputSchema: {
            type: 'object',
            properties: { itemId: { type: 'string', description: 'Knowledge item ID.' } },
            required: ['itemId'],
          },
        },
        {
          name: 'knowl_feedback',
          description: 'Record append-only usefulness feedback only after a retrieved item was actually used, rejected, or caused a correction.',
          inputSchema: {
            type: 'object',
            properties: {
              itemId: { type: 'string', description: 'Knowledge item ID.' },
              used: { type: 'boolean', description: 'Whether the result was used.' },
              useful: { type: 'boolean', description: 'Whether the result was useful.' },
              causedCorrection: { type: 'boolean', description: 'Whether the result caused a correction.' },
            },
            required: ['itemId'],
          },
        },
        {
          name: 'knowl_session_finish',
          description: 'Finish and optionally promote an explicitly owned manual memory session; never a hook-owned session.',
          inputSchema: {
            type: 'object', properties: {
              sessionId: { type: 'string', description: 'Memory session ID.' }, status: { type: 'string', enum: ['finished', 'failed'] }, summary: { type: 'string' }, promote: { type: 'boolean' },
            }, required: ['sessionId', 'status'],
          },
        },
        {
          name: 'knowl_update',
          description: 'Update the metadata, status, or content of an existing knowledge item. Use immediately when execution reveals stale or contradicted memory instead of adding duplicates. To retire an outdated item in favour of one you just stored, call this with `id` set to the NEW item and `supersedeId` set to the OUTDATED item.',
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
              source: {
                type: 'string',
                description: 'Updated source label.',
              },
              sourceCommit: {
                type: 'string',
                description: 'Updated git commit for the reviewed knowledge.',
              },
              affectedPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Updated repository-relative file paths tied to this knowledge.',
              },
              freshness: {
                type: 'string',
                enum: ['fresh', 'stale', 'needs_review'],
                description: 'Optional freshness override. Defaults to fresh when updating reviewed knowledge content or provenance.',
              },
              supersedeId: { type: 'string', description: 'Id of a DIFFERENT active item to retire, pointing it at the item named by `id` as its replacement. This is not the item being updated.' },
            },
            required: ['id'],
          },
        },
        {
          name: 'knowl_gc_preview',
          description: 'Preview knowledge garbage collection recommendations without changing the database. Use to find duplicate, stale, or cold memory before applying GC.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_task_start',
          description: 'Start one manual work loop for multi-command or resumable work when verified lifecycle hooks are unavailable. Returns relevant memory and a taskId. Never use for a hook-owned session.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short task title.',
              },
              query: {
                type: 'string',
                description: 'Optional focused retrieval query for pre-task memory lookup. Defaults to the task title.',
              },
            },
            required: ['title'],
          },
        },
        {
          name: 'knowl_task_checkpoint',
          description: 'Checkpoint meaningful progress or a blocker in a manual work loop using the taskId from knowl_task_start. Never use for a hook-owned session or routine command noise.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                description: 'Durable checkpoint summary.',
              },
              goal: {
                type: 'string',
                description: 'Optional current goal for resumable handoffs.',
              },
              completed: {
                type: 'array',
                description: 'Optional list of completed steps.',
                items: { type: 'string' },
              },
              nextAction: {
                type: 'string',
                description: 'Optional next action to resume with.',
              },
              blocker: {
                type: 'string',
                description: 'Optional current blocker.',
              },
              artifactRefs: {
                type: 'array',
                description: 'Optional file or artifact references relevant to the task.',
                items: { type: 'string' },
              },
              verificationStatus: {
                type: 'string',
                description: 'Optional verification status such as unverified, tests-passing, or needs-review.',
              },
            },
            required: ['taskId', 'summary'],
          },
        },
        {
          name: 'knowl_task_finish',
          description: 'Finish one manual work loop exactly once after verification using the taskId from knowl_task_start. Never use for a hook-owned session.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                description: 'Durable completion summary.',
              },
            },
            required: ['taskId', 'summary'],
          },
        },
        {
          name: 'knowl_gc_apply',
          description: 'Apply knowledge garbage collection only after knowl_gc_preview and explicit user approval; this may purge, archive, or compress records.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_skill_list',
          description: 'List learned file-backed skills from `.knowl/skills`. This is a stable MCP bridge so old sessions can discover newly created skills.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_skill_read',
          description: 'Read one learned skill package from `.knowl/skills/<name>/`, including `skill.json` and `SKILL.md`.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Skill package name.',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'knowl_skill_create',
          description: 'Create and index a learned file-backed skill only when the user explicitly requested a reusable workflow to be codified.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Path-safe skill name using lowercase letters, numbers, underscores, and hyphens.',
              },
              purpose: {
                type: 'string',
                description: 'One-sentence purpose for the skill.',
              },
              markdown: {
                type: 'string',
                description: 'Content for `SKILL.md`.',
              },
              triggers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional trigger phrases for discovery.',
              },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                  },
                  required: ['path', 'content'],
                },
                description: 'Optional files to create inside the skill package, such as `run.ps1` or `run.cmd`.',
              },
              entrypoints: {
                type: 'object',
                description: 'Entrypoints keyed by name, for example `default` or `fallback`.',
                additionalProperties: {
                  type: 'object',
                },
              },
            },
            required: ['name', 'purpose'],
          },
        },
        {
          name: 'knowl_skill_run',
          description: 'Run a trusted matching learned-skill entrypoint after inspecting the package with knowl_skill_read.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Skill package name.',
              },
              entrypoint: {
                type: 'string',
                description: 'Entrypoint name; defaults to `default`.',
              },
              args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional runtime arguments passed to the entrypoint.',
              },
            },
            required: ['name'],
          },
        },
      ],
    };
  });

  // 2. Call tool
  const callTool = async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const initError = getInitError();
    const projectId = getProjectId();
    const projectRoot = getProjectRoot();
    const config = getConfig();

    if (initError) {
      return {
        content: [
          {
            type: 'text',
            text: formatInitError(initError),
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

        // Counts live on mergeResult; reading them off the top level always reported zero.
        const merge = result.mergeResult;
        return {
          content: [{ type: 'text', text: compactMcpJson({ inserted: merge?.insertedIds?.length ?? 0, updated: merge?.updatedIds?.length ?? 0, superseded: merge?.supersededIds?.length ?? 0 }) }],
        };
      }
      
      else if (name === 'knowl_state') {
        const hierarchy = await getHierarchicalKnowledge(projectId!);
        const { maxChars } = args as any;
        const md = formatHierarchyToMarkdown(hierarchy, { maxChars });
        // Names the linked repos without quoting their content: an agent should know a
        // workspace exists and what to filter by, but foreign knowledge arrives only
        // through an explicit query.
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        const workspaceNote = active
          ? `\n\n## WORKSPACE\n\nThis repo is "${active.repo}" in workspace "${active.name}". Linked repos: ${
            active.peers.length ? active.peers.map(peer => `${peer.name}${peer.present ? '' : ' (missing here)'}`).join(', ') : 'none yet'
          }. Their workspace-visible knowledge is searchable with knowl_query; filter with \`repos\`.`
          : '';
        return {
          content: [{ type: 'text', text: `${md}${workspaceNote}` }],
        };
      }

      else if (name === 'knowl_recent') {
        const { itemLimit, commitLimit, maxChars } = args as any;
        const context = await getRecentContext(projectId!, {
          itemLimit,
          commitLimit,
        });
        return {
          content: [{ type: 'text', text: formatRecentContextToMarkdown(context, { maxChars }) }],
        };
      }

      else if (name === 'knowl_store') {
        const { category, title, content, reasoning, alternatives, tags, source, sourceCommit, affectedPaths, confidence, steps, conflictKey, conflictScope, conflictExclusive, supersedes, namespace = 'project' } = args as any;

        if (!KNOWLEDGE_CATEGORIES.includes(category)) {
          throw new Error(`Invalid knowledge category: ${category}`);
        }

        const store = () => storeKnowledgeItemDeduped(
          projectId!,
          {
            category,
            title,
            content,
            reasoning,
            alternatives,
            tags,
            source,
            sourceCommit,
            affectedPaths,
            confidence,
            conflictKey,
            conflictScope,
            conflictExclusive,
            supersedes,
            steps,
          },
          `Store ${category}: ${title}`,
          config?.security,
        );
        const result = namespace === 'project'
          ? await store()
          : await withNamespaceDatabase(namespaceDescriptor(projectRoot!, namespace, config ?? undefined), store);

        if (result.action === 'duplicate') {
          return {
            content: [{ type: 'text', text: `NOT STORED — this ${category} is already held verbatim as item ${result.item.id} ("${result.item.title}"), so nothing was written and nothing was lost. No action needed.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Successfully stored ${category} ${result.item.id}${describeWriteReconciliation(result)}` }],
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
          commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
          config?.security,
        );

        // Report per atom. Counting result.itemIds as "stored" reported a verbatim no-op
        // as a successful write, and said nothing about atoms left beside an overlapping
        // item, so a caller had no way to know memory still held a contradiction.
        const lines = result.outcomes.map(outcome => {
          if (outcome.action === 'duplicate') {
            return `- NOT STORED (already held verbatim as ${outcome.itemId}): "${outcome.title}" — no action needed.`;
          }
          const parts = [`- stored ${outcome.itemId}: "${outcome.title}"`];
          if (outcome.supersededId) parts.push(`retired predecessor ${outcome.supersededId}`);
          if (outcome.nearDuplicateId) {
            parts.push(`STILL ACTIVE beside overlapping item ${outcome.nearDuplicateId} ("${outcome.nearDuplicateTitle}") — if this atom corrects it, retire it with knowl_update using id "${outcome.itemId}" and supersedeId "${outcome.nearDuplicateId}"`);
          }
          // Per atom, so an agent can tell which of five findings overlapped rather than
          // being told only that something in the batch did.
          for (const overlap of outcome.crossRepo ?? []) {
            parts.push(`${overlap.kind === 'conflict' ? 'CONTRADICTS' : 'OVERLAPS'} linked repo "${overlap.repo}" item ${overlap.id} ("${overlap.title}") — you cannot retire or edit it from this repo`);
          }
          return parts.join('; ') + '.';
        });
        const summary = `Stored ${result.insertedCount} of ${atoms.length} atom(s); ${result.duplicateCount} already held verbatim; ${result.supersededIds.length} predecessor(s) retired.`;
        return {
          content: [{ type: 'text', text: `${summary}\n${lines.join('\n')}` }],
        };
      }
      
      else if (name === 'knowl_decide') {
        const { title, content, reasoning, alternatives, tags, supersedes } = args as any;
        const result = await recordDecisionDirect(projectId!, {
          title,
          content,
          reasoning,
          alternatives,
          tags: tags || [],
          supersedes,
        }, `Record decision via MCP: ${title}`, config || undefined);

        if (result.action === 'duplicate') {
          return {
            content: [{ type: 'text', text: `NOT STORED — this decision is already held verbatim as item ${result.item.id} ("${result.item.title}"), so nothing was written and nothing was lost. No action needed.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Successfully recorded decision ${result.item.id}${describeWriteReconciliation(result)}` }],
        };
      }
      
      else if (name === 'knowl_query') {
        const { query, category, status, tags, limit, includeEvidence, explain, asOf, repos } = args as any;
        if (asOf) {
          // queryKnowledgeBase hard-filters on category, unlike every other query path,
          // which passes category: undefined and uses it only as a ranking boost. Without
          // this retry a wrong category guess returns nothing on a historical query while
          // the same query without asOf recovers, contradicting the documented contract.
          // Retrying only when the filtered result is empty means exact-category hits
          // still win and non-empty results never reorder.
          let items = await queryKnowledgeBase(projectId!, { query, category, status, tags, limit, asOf });
          if (items.length === 0 && category) {
            items = await queryKnowledgeBase(projectId!, { query, status, tags, limit, asOf });
          }
          // Access is deliberately not recorded here: retrieval counts feed the
          // access-weighted GC decay, so logging time-travel reads would make stale items
          // look hot and shield them from collection.
          // Wrapped rather than passed point-free: compactItemResponse now takes provenance
          // as its second argument, and map would hand it the array index.
          return { content: [{ type: 'text', text: compactMcpJson(items.map(item => compactItemResponse(item))) }] };
        }
        let vector;
        if (config && projectRoot && query && isVectorSearchEnabled(config)) {
          const embedder = await createLocalEmbeddingProvider(config, projectRoot);
          const [embedding] = await embedder.embed([query]);
          const vectorConfig = getVectorSearchConfig(config);
          vector = {
            enabled: true,
            provider: embedder.provider,
            model: vectorConfig.model,
            embedding,
          };
        }

        const queryOptions = {
          query,
          category: category as KnowledgeCategory,
          status: status as KnowledgeStatus,
          tags,
          limit,
          surface: 'mcp',
          vector,
        };
        const layered = Boolean(projectRoot) && !explain && !vector?.enabled;
        const items = layered
          ? await queryLayeredKnowledge(projectRoot!, query ?? '', configuredNamespaces(projectRoot!, config ?? undefined), limit ?? 3, 'mcp')
          : explain
          ? await queryKnowledgeForAgentExplained(projectId!, queryOptions)
          : await queryKnowledgeForAgent(projectId!, queryOptions);

        // Only the layered path spans namespaces. Vector search and explain both fall
        // through to the ambient project database, so knowledge in other namespaces is
        // absent from these results. Spanning namespaces under vector search needs one
        // workspace-wide embedding identity first: searchKnowledgeEmbeddings filters on
        // provider and model, and that filter is load-bearing because cosine similarity
        // across different dimensions is meaningless. Until then, say what was skipped
        // rather than let the scope narrow silently.
        let skippedNamespaces: string[] = [];
        if (!layered && projectRoot) {
          try {
            skippedNamespaces = configuredNamespaces(projectRoot, config ?? undefined)
              .filter(descriptor => descriptor.namespace !== 'project')
              .map(descriptor => descriptor.namespace);
          } catch {
            // A misconfigured optional namespace must not fail an otherwise good query.
          }
        }

        // Federation is reached only from here. Peers are deliberately absent from
        // configuredNamespaces so implicit context assembly cannot fan out.
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        let skippedRepos: FederatedResult['skipped'] = [];
        let resolvedItems: Array<KnowledgeItem & { repo?: string; explanation?: unknown }> = items as any;
        if (active) {
          // Federation selects from every repo including this one and scores the union in a
          // single pass, so the local result above is not passed in. Handing it pre-selected
          // local items would score them by different rules than the peers' -- and recency,
          // which normalizes against the candidate set it is given, would make every repo's
          // newest item equally recent.
          const federated = await queryFederated({
            workspace: active,
            query: query ?? '',
            category: category as KnowledgeCategory,
            status: status as KnowledgeStatus,
            tags,
            limit: limit ?? 3,
            repos,
            vector,
          });
          skippedRepos = federated.skipped;
          resolvedItems = federated.items;
        }

        const withStaleStatus = async (itemId: string) => Promise.all((await listEvidenceForItem(itemId)).map(async evidence => ({
          ...evidence,
          stale: projectRoot ? await isEvidenceStale(evidence, projectRoot) : false,
        })));
        // The repo label goes through compactItemResponse's provenance argument: the compact
        // shape is an allowlist, so a field attached to the item alone is dropped here.
        const compact = (item: any) => ({
          ...compactItemResponse(item, item.repo ? { repo: item.repo } : undefined),
          ...(explain && item.explanation ? { explanation: item.explanation } : {}),
        });
        // Evidence and staleness resolve against THIS repo's filesystem and database, so a
        // foreign item would be judged against the wrong checkout -- reporting "stale" for a
        // file that is simply somewhere else. Omitting it beats answering wrongly.
        const isForeign = (item: any) => Boolean(active) && item.repo && item.repo !== active!.repo;
        const payload = includeEvidence
          ? await Promise.all(resolvedItems.map(async item => (isForeign(item)
            ? compact(item)
            : { ...compact(item), evidence: boundedEvidence(await withStaleStatus(item.id)) })))
          : resolvedItems.map(compact);
        // The notice is a separate block so the first block stays a bare JSON array for
        // every existing caller.
        const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: compactMcpJson(payload) }];
        if (skippedRepos.length) {
          const described = skippedRepos.map(skip => `${skip.repo} (${skip.reason})`).join(', ');
          blocks.push({
            type: 'text',
            text: `SCOPE: linked repos NOT searched: ${described}. Their knowledge is absent from these results; a miss here does not mean it does not exist.`,
          });
        }
        if (explain && active) {
          // Per-repo reach, so "returned nothing" can be told apart from "was not searched".
          const contributed = new Map<string, number>();
          for (const item of resolvedItems) {
            const repoName = item.repo ?? active.repo;
            contributed.set(repoName, (contributed.get(repoName) ?? 0) + 1);
          }
          const reached = [active.repo, ...active.peers.map(peer => peer.name)]
            .filter(repoName => !skippedRepos.some(skip => skip.repo === repoName))
            .map(repoName => `${repoName}: ${contributed.get(repoName) ?? 0}`);
          blocks.push({
            type: 'text',
            text: `WORKSPACE REACH: searched ${reached.join(', ')}${skippedRepos.length ? `; skipped ${skippedRepos.map(skip => skip.repo).join(', ')}` : ''}.`,
          });
        }
        if (skippedNamespaces.length) {
          blocks.push({
            type: 'text',
            text: `SCOPE: ${explain ? '`explain`' : 'vector search'} limits this query to the project namespace, so ${skippedNamespaces.join(' and ')} knowledge was NOT searched. A miss here does not mean the knowledge is absent; re-run without it for full scope.`,
          });
        }
        return { content: blocks };
      }

      else if (name === 'knowl_timeline') {
        const { itemId } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
        const { listAssertions } = await import('../store/assertions.js');
        return { content: [{ type: 'text', text: compactMcpJson((await listAssertions(itemId)).slice(0, 5).map(compactAssertionResponse)) }] };
      }

      else if (name === 'knowl_conflicts') {
        const { listActiveConflictKeys } = await import('../store/conflicts.js');
        const items = await listActiveConflictKeys();
        return { content: [{ type: 'text', text: compactMcpJson(items.slice(0, 3).map(item => ({ id: item.id, title: item.title, conflictKey: item.conflictKey, conflictScope: item.conflictScope, freshness: item.freshness }))) }] };
      }

      else if (name === 'knowl_context') {
        const { composeContext } = await import('../store/context-composer.js');
        const { query, task, tokenBudget, explain } = args as any;
        const pack = await composeContext(projectId!, { query, task, tokenBudget, namespaceRoot: projectRoot ?? undefined });
        return { content: [{ type: 'text', text: compactMcpJson(explain ? pack : { sections: pack.sections, estimatedTokens: pack.estimatedTokens }) }] };
      }

      else if (name === 'knowl_synthesize') {
        const { scope } = args as any;
        const { synthesizeKnowledge } = await import('../store/synthesis.js');
        return { content: [{ type: 'text', text: compactMcpJson(compactItemResponse(await synthesizeKnowledge(projectId!, scope))) }] };
      }

      else if (name === 'knowl_evidence_list') {
        const { itemId } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
        const evidence = await Promise.all((await listEvidenceForItem(itemId)).map(async item => ({
          ...item,
          stale: projectRoot ? await isEvidenceStale(item, projectRoot) : false,
        })));
        return { content: [{ type: 'text', text: compactMcpJson(boundedEvidence(evidence)) }] };
      }

      else if (name === 'knowl_feedback') {
        const { itemId, used, useful, causedCorrection } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
        const feedback = await recordKnowledgeFeedback({ itemId, used, useful, causedCorrection });
        return { content: [{ type: 'text', text: `Recorded feedback for ${itemId}:\n\n${JSON.stringify(feedback, null, 2)}` }] };
      }

      else if (name === 'knowl_session_finish') {
        const { sessionId, status, summary, promote = true } = args as any;
        const session = await finishMemorySession(sessionId, status, summary);
        const promotion = promote ? await finalizeMemorySession(projectId!, sessionId) : { status: 'skipped', itemIds: [], candidateCount: 0, usedAi: false };
        return { content: [{ type: 'text', text: compactMcpJson({ session: { id: session.id, status: session.status }, promotion: { status: promotion.status, candidateCount: promotion.candidateCount, itemIds: promotion.itemIds.slice(0, 3) } }) }] };
      }
      
      else if (name === 'knowl_update') {
        const { id, title, content, status, reasoning, source, sourceCommit, affectedPaths, freshness, supersedeId } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(id, owner); } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
        const updated = await updateKnowledgeItemWithCommit(projectId!, id, {
          title,
          content,
          status: status as KnowledgeStatus,
          reasoning,
          source,
          sourceCommit,
          affectedPaths,
        }, {
          projectRoot,
          freshness,
          validationOptions: config?.security,
        });

        if (supersedeId) {
          const { supersedeKnowledgeItem } = await import('../store/repository.js');
          await supersedeKnowledgeItem(supersedeId, updated.id);
        }
        return {
          content: [{ type: 'text', text: `Successfully updated item ${id} (${updated.freshness})` }],
        };
      }

      else if (name === 'knowl_gc_preview') {
        const result = await previewKnowledgeGc(projectId!);
        return {
          content: [{ type: 'text', text: compactMcpJson({ summary: result.summary, candidateCount: result.candidates.length, candidates: result.candidates.slice(0, 3) }) }],
        };
      }

      else if (name === 'knowl_task_start') {
        const { title, query } = args as any;
        const result = await startWorkLoop(projectId!, title, query);
        return {
          content: [{ type: 'text', text: compactMcpJson({ ...result, relevantMemory: result.relevantMemory.map(item => ({ ...item, content: truncateText(item.content, MAX_ITEM_CONTENT_CHARS) })) }) }],
        };
      }

      else if (name === 'knowl_task_checkpoint') {
        const { taskId, summary, goal, completed, nextAction, blocker, artifactRefs, verificationStatus } = args as any;
        const result = await checkpointWorkLoop(projectId!, taskId, {
          summary,
          goal,
          completed,
          nextAction,
          blocker,
          artifactRefs,
          verificationStatus,
        });
        return {
          content: [{ type: 'text', text: compactMcpJson(result) }],
        };
      }

      else if (name === 'knowl_task_finish') {
        const { taskId, summary } = args as any;
        const result = await finishWorkLoop(projectId!, taskId, summary);
        return {
          content: [{ type: 'text', text: compactMcpJson(result) }],
        };
      }

      else if (name === 'knowl_gc_apply') {
        const result = await applyKnowledgeGc(projectId!);
        return {
          content: [{ type: 'text', text: compactMcpJson({ summary: result.summary, candidateCount: result.candidates.length, candidates: result.candidates.slice(0, 3) }) }],
        };
      }

      else if (name === 'knowl_skill_list') {
        const skills = await listSkillPackages(projectRoot!);
        return {
          content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }],
        };
      }

      else if (name === 'knowl_skill_read') {
        const { name: skillName } = args as any;
        const skill = await readSkillPackage(projectRoot!, skillName);
        return {
          content: [{ type: 'text', text: compactMcpJson({ manifest: skill.manifest, markdown: truncateText(skill.markdown, MAX_ITEM_CONTENT_CHARS), truncated: skill.markdown.length > MAX_ITEM_CONTENT_CHARS }) }],
        };
      }

      else if (name === 'knowl_skill_create') {
        const { name: skillName, purpose, markdown, triggers, files, entrypoints } = args as any;
        const skill = await createSkillPackage(projectRoot!, {
          name: skillName,
          purpose,
          markdown,
          triggers,
          files,
          entrypoints,
        });
        await indexSkillPackage(projectId!, skill.manifest);
        return {
          content: [{ type: 'text', text: `Successfully created skill ${skill.manifest.name}` }],
        };
      }

      else if (name === 'knowl_skill_run') {
        const { name: skillName, entrypoint, args: runtimeArgs } = args as any;
        const result = await runSkillPackage(projectRoot!, skillName, entrypoint || 'default', runtimeArgs || []);
        await recordSkillRun(projectId!, skillName, result.exitCode === 0);
        return { content: [{ type: 'text', text: compactMcpJson({ ...result, stdout: truncateText(result.stdout, MAX_ITEM_CONTENT_CHARS), stderr: truncateText(result.stderr, MAX_ITEM_CONTENT_CHARS), attempts: result.attempts.map(attempt => ({ entrypoint: attempt.entrypoint, exitCode: attempt.exitCode })) }) }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      const message = error instanceof KnowledgeValidationError
        ? `${error.code}: ${error.message}`
        : error.message;
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing tool "${name}": ${message}` }],
      };
    }
  };

  /**
   * Every tool result carries any foreign memory change this session has not been shown.
   *
   * This is the host-independent half of change notification. The hook path can only
   * reach a host that exposes a mid-turn channel; this reaches anything that can call a
   * tool, which is every MCP client by definition.
   *
   * The watermark is read before dispatch on purpose: it is what lets the notice exclude
   * this call's own writes exactly, by commit position, rather than by matching titles
   * the way the hook path is forced to. A failure anywhere in here degrades to "no
   * notice" -- memory news must never be able to fail a tool call.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const projectRoot = getProjectRoot();
    const watermark = await captureChangeWatermark(projectRoot);
    const result = await callTool(request);
    const notice = await consumeChangeNotice(projectRoot, request.params.name, watermark);
    if (!notice) return result;
    return { ...result, content: [...result.content, { type: 'text' as const, text: notice }] };
  });
}
