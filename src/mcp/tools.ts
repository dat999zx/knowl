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
import { DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, truncateText } from '../core/token-budget.js';
import { getRecentContext } from '../store/recent-context.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../store/knowledge-writer.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../store/knowledge-actions.js';
import { isVectorSearchEnabled, createLocalEmbeddingProvider } from '../ai/embeddings.js';
import { queryKnowledgeForAgent, queryKnowledgeForAgentExplained } from '../store/agent-query.js';
import { previewKnowledgeGc, applyKnowledgeGc } from '../store/gc.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop } from '../store/work-loop.js';
import { formatInitError } from './init-error.js';
import { indexSkillPackage, recordSkillRun } from '../skills/knowledge-index.js';
import { createSkillPackage, listSkillPackages, readSkillPackage, runSkillPackage } from '../skills/registry.js';
import { KnowledgeValidationError } from '../core/knowledge-validation.js';
import { isEvidenceStale, listEvidenceForItem } from '../store/evidence-repository.js';
import { recordKnowledgeFeedback } from '../store/access-feedback.js';
import { flagCorrectionSiblingsBestEffort } from '../store/blast-radius.js';
import { applyFeedbackToTierBestEffort } from '../store/tier.js';
import { finishMemorySession } from '../store/session-repository.js';
import { formatPendingHandoffContext, recordDeliberateHandoff } from '../store/session-handoff.js';
import { createResumePoint, formatResumeBrief, listResumePoints, readResumePoint } from '../store/resume-points.js';
import { resumeInstruction } from '../store/resume-keys.js';
import { finalizeMemorySession } from '../store/session-finalizer.js';
import { configuredNamespaces, namespaceDescriptor, queryLayeredKnowledge, withNamespaceDatabase } from '../store/namespaces.js';
import { isTranscriptSearchEnabled } from '../transcripts/config.js';
import { handleSessionList, handleTranscriptRead, handleTranscriptSearch } from '../transcripts/mcp-handlers.js';
import { sanitizeToolErrorMessage, ToolInputError, validateToolArguments } from './tool-schema.js';

/**
 * Ceilings for the tools that return knowledge.
 *
 * The transcript tools already bound every numeric argument and cap their rendered output;
 * the older tools bounded nothing, and one `knowl_context` call was measured at 58,531
 * characters. These are the same ceilings expressed for this half of the surface.
 */
const MAX_QUERY_LIMIT = 25;
const MIN_MARKDOWN_CHARS = 200;
const MAX_MARKDOWN_CHARS = 20_000;
const MAX_CONTEXT_TOKEN_BUDGET = 4_000;
/** Matches `MAX_RESPONSE_CHARS` in the transcript handlers, deliberately. */
const MAX_RESPONSE_CHARS = 12_000;
const MAX_SKILLS_LISTED = 30;
const MAX_SKILL_PURPOSE_CHARS = 200;
const MAX_TRIGGERS_LISTED = 5;
const MAX_TRIGGER_CHARS = 80;


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

type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

// Registered only when the repo turned transcript search on. Two extra tools cost
// guidance-card space in every session of every user, including those who never search one.
const TRANSCRIPT_TOOLS: ToolDefinition[] = [
        {
          name: 'knowl_transcript_search',
          description: 'Search this repo\'s past Claude Code session transcripts. Use after knowl_query misses. Returns pointers into the session files; store anything worth keeping with knowl_store.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string', minLength: 1, maxLength: 500,
                description: 'What to look for, in your own words. Semantic search covers the whole archive, so the exact wording need not match.',
              },
              sessionId: { type: 'string', description: 'Restrict to one session. Accepts a full id or an unambiguous prefix.' },
              repos: {
                type: 'array', items: { type: 'string' }, maxItems: 20,
                description: 'Restrict to these repos by name. Omit to search this repo plus every linked workspace repo that shares its transcripts.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum hits; defaults to 5.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'knowl_transcript_read',
          description: 'Read one transcript message and the turns around it. Pass a locator from knowl_transcript_search exactly as it was returned.',
          inputSchema: {
            type: 'object',
            properties: {
              locator: {
                type: 'string', minLength: 1, maxLength: 500,
                description: 'A transcript://<repo>/<session>#L<line> locator from a search hit, verbatim.',
              },
              context: { type: 'integer', minimum: 0, maximum: 10, description: 'Prose turns to include on each side; defaults to 2.' },
            },
            required: ['locator'],
          },
        },
        {
          name: 'knowl_session_list',
          description: "Browse this project's past Claude Code sessions as an inventory: best-known name (a user rename beats a generated title), the opening ask, status, any declared session card, last activity, and what each session promoted into memory. Use to answer 'which session was about X' or to choose between resuming and starting fresh - then knowl_transcript_search with that sessionId to read into it. Filters over intent only; for content questions use knowl_transcript_search.",
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string', maxLength: 500,
                description: 'Keywords over session names, opening asks and declared cards. Omit to list newest first.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum sessions; defaults to 30.' },
            },
          },
        },
];

/**
 * The published tool surface.
 *
 * At module scope so dispatch can validate a call against the very schema the client was
 * shown. While this lived inside the list handler nothing could check an argument against
 * its own declaration, and the two drifted: confidence documented as 0.0-1.0 and accepted
 * at 999, entrypoints documented as an object and accepted as an array.
 */
export function knowlToolDefinitions(config: ProjectConfig | null): ToolDefinition[] {
  const tools: ToolDefinition[] = [
        {
          name: 'knowl_ingest',
          description: 'Process explicitly supplied raw source text through the configured Knowl AI pipeline. Use only for an explicit ingestion request; never silently ingest the current conversation or prompt.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                minLength: 1,
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
            properties: { maxChars: { type: 'integer', minimum: MIN_MARKDOWN_CHARS, maximum: MAX_MARKDOWN_CHARS, description: 'Maximum markdown characters; defaults to 3000.' } },
          },
        },
        {
          name: 'knowl_recent',
          description: 'Get compact recent session context only when lifecycle bootstrap is unavailable (including manual mode) or an explicit refresh is needed.',
          inputSchema: {
            type: 'object',
            properties: {
              itemLimit: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_QUERY_LIMIT,
                description: 'Maximum recent active knowledge items to return; defaults to 3.',
              },
              commitLimit: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_QUERY_LIMIT,
                description: 'Maximum recent knowledge commits to return; defaults to 8.',
              },
              maxChars: { type: 'integer', minimum: MIN_MARKDOWN_CHARS, maximum: MAX_MARKDOWN_CHARS, description: 'Maximum markdown characters; defaults to 3000.' },
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
                minLength: 1,
                description: 'Concise title for the knowledge item.',
              },
              content: {
                type: 'string',
                minLength: 1,
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
              // Bounded because confidence is a linear term in the ranking sum: an item stored
              // on a percent scale outranks everything for every future query, permanently,
              // and nothing downstream can tell 0.9 from a mis-scaled 90.
              confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Optional confidence from 0.0 to 1.0. Values outside that range are refused.',
              },
              provenance: {
                type: 'string',
                enum: ['observed', 'user_stated', 'inferred'],
                description: 'How this came to be believed: observed (execution or direct inspection), user_stated (the human said so), or inferred (concluded without direct evidence). Inferred items rank lower until confirmed by use.',
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
                    title: { type: 'string', minLength: 1 },
                    content: { type: 'string', minLength: 1 },
                    reasoning: { type: 'string' },
                    alternatives: { type: 'array', items: { type: 'string' } },
                    tags: { type: 'array', items: { type: 'string' } },
                    source: { type: 'string' },
                    sourceCommit: { type: 'string' },
                    affectedPaths: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Optional confidence from 0.0 to 1.0. Values outside that range are refused.' },
                    provenance: {
                      type: 'string',
                      enum: ['observed', 'user_stated', 'inferred'],
                      description: 'How this came to be believed: observed (execution or direct inspection), user_stated (the human said so), or inferred (concluded without direct evidence). Inferred items rank lower until confirmed by use.',
                    },
                    steps: { type: 'array', items: { type: 'string' } },
                    supersedes: { type: 'string', description: 'Id of an active item this atom replaces; it is marked superseded (retired but still queryable), not deleted.' },
                  },
                  required: ['category', 'title', 'content'],
                },
                minItems: 1,
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
                minLength: 1,
                description: 'Descriptive title of the decision (e.g. "Use PostgreSQL").',
              },
              content: {
                type: 'string',
                minLength: 1,
                description: 'The decision details (what was decided).',
              },
              reasoning: {
                type: 'string',
                minLength: 1,
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
                maxLength: 500,
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
                maxItems: 20,
                description: 'Filter items that contain all of these tags.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_QUERY_LIMIT,
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
              // An unparseable timestamp used to fall through to "now", so a typo answered a
              // historical question with the present and said nothing.
              asOf: { type: 'string', format: 'date-time', description: 'ISO-8601 timestamp for historically valid content. An unparseable value is refused, not treated as now.' },
              repos: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 20,
                description: 'Only in a workspace. Restrict results to knowledge produced by these linked repos. Matches the owning repo, not repos an item merely applies to.',
              },
            },
          },
        },
        {
          name: 'knowl_timeline',
          description: 'Inspect immutable assertions for one knowledge item when its history is needed.',
          inputSchema: { type: 'object', properties: { itemId: { type: 'string', minLength: 1 } }, required: ['itemId'] },
        },
        {
          name: 'knowl_conflicts',
          description: 'Inspect active exclusive conflict identities when a conflict must be resolved.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'knowl_context',
          description: 'Compose a diversified token-budgeted context pack.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', maxLength: 500 },
              task: { type: 'string', maxLength: 500 },
              tokenBudget: { type: 'integer', minimum: 100, maximum: MAX_CONTEXT_TOKEN_BUDGET, description: `Token ceiling for the pack, 100-${MAX_CONTEXT_TOKEN_BUDGET}.` },
              explain: { type: 'boolean', description: 'Include excluded-item diagnostics.' },
            },
            required: ['tokenBudget'],
          },
        },
        {
          name: 'knowl_synthesize',
          description: 'Create or refresh one deterministic evidence-backed project understanding. This never runs automatically on normal writes.',
          inputSchema: { type: 'object', properties: { scope: { type: 'string', minLength: 1 } }, required: ['scope'] },
        },
        {
          name: 'knowl_evidence_list',
          description: 'Inspect evidence linked to one knowledge item when source support must be checked.',
          inputSchema: {
            type: 'object',
            properties: { itemId: { type: 'string', minLength: 1, description: 'Knowledge item ID.' } },
            required: ['itemId'],
          },
        },
        {
          name: 'knowl_feedback',
          description: 'Record append-only usefulness feedback only after a retrieved item was actually used, rejected, or caused a correction.',
          inputSchema: {
            type: 'object',
            properties: {
              itemId: { type: 'string', minLength: 1, description: 'Knowledge item ID.' },
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
              sessionId: { type: 'string', minLength: 1, description: 'Memory session ID.' }, status: { type: 'string', enum: ['finished', 'failed'] }, summary: { type: 'string' }, promote: { type: 'boolean' },
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
                minLength: 1,
                description: 'The unique ID of the knowledge item.',
              },
              title: {
                type: 'string',
                minLength: 1,
                description: 'New title.',
              },
              content: {
                type: 'string',
                minLength: 1,
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
              supersedeId: { type: 'string', minLength: 1, description: 'Id of a DIFFERENT active item to retire, pointing it at the item named by `id` as its replacement. This is not the item being updated. Checked before the update is written, so an unknown id changes nothing.' },
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
                minLength: 1,
                description: 'Short task title.',
              },
              query: {
                type: 'string',
                maxLength: 500,
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
                minLength: 1,
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                minLength: 1,
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
                minLength: 1,
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                minLength: 1,
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
          description: 'List learned file-backed skills from `.knowl/skills`, name and purpose only. This is a stable MCP bridge so old sessions can discover newly created skills; read one with knowl_skill_read for its manifest and instructions.',
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
                minLength: 1,
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
                minLength: 1,
                description: 'Path-safe skill name using lowercase letters, numbers, underscores, and hyphens.',
              },
              purpose: {
                type: 'string',
                minLength: 1,
                description: 'One-sentence purpose for the skill.',
              },
              markdown: {
                type: 'string',
                description: 'Content for `SKILL.md`.',
              },
              triggers: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 20,
                description: 'Optional trigger phrases for discovery.',
              },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', minLength: 1 },
                    content: { type: 'string' },
                  },
                  required: ['path', 'content'],
                },
                // `.cmd`/`.bat` are refused: Windows re-parses a batch file's command line after
                // Node has quoted it, so no argv escaping is safe (CVE-2024-24576).
                description: 'Optional files to create inside the skill package, such as `run.ps1`, `run.js` or `run.sh`. Batch scripts (`.cmd`, `.bat`) are refused.',
              },
              // A discriminated union, because the old schema said only "object" and every
              // plausible guess failed with the same unhelpful message -- and an array shape
              // was accepted, silently creating an entrypoint named "0" that knowl_skill_run
              // could never reach.
              entrypoints: {
                type: 'object',
                description: 'Entrypoints keyed by name, for example `default` or `fallback`. Each is either a script or a shell command, and each must opt in to being runnable.',
                additionalProperties: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        type: { type: 'string', const: 'script' },
                        path: { type: 'string', minLength: 1, description: 'Package-relative script path. `.ps1`, `.js`, `.sh` and extensionless are runnable; `.cmd` and `.bat` are refused.' },
                        args: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Fixed arguments prepended to any the caller passes.' },
                        autoRun: { type: 'boolean', description: 'Must be true for knowl_skill_run to execute it. Defaults to false.' },
                      },
                      required: ['type', 'path'],
                      additionalProperties: false,
                    },
                    {
                      type: 'object',
                      properties: {
                        type: { type: 'string', const: 'shell' },
                        command: { type: 'string', minLength: 1, description: 'A shell command line. It cannot accept caller arguments; pass values through the KNOWL_* environment instead.' },
                        autoRun: { type: 'boolean', description: 'Must be true for knowl_skill_run to execute it. Defaults to false.' },
                      },
                      required: ['type', 'command'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            required: ['name', 'purpose'],
          },
        },
        {
          name: 'knowl_skill_run',
          description: 'Run a trusted matching learned-skill entrypoint after inspecting the package with knowl_skill_read. Only an entrypoint whose author set `autoRun: true` will run; that is not the default.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                minLength: 1,
                description: 'Skill package name.',
              },
              entrypoint: {
                type: 'string',
                minLength: 1,
                description: 'Entrypoint name; defaults to `default`.',
              },
              args: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 20,
                description: 'Optional runtime arguments, passed to a `script` entrypoint as argv. A `shell` entrypoint REFUSES arguments -- no quoting is safe across cmd.exe and POSIX shells -- so pass values to one through the KNOWL_* environment instead.',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'knowl_handoff',
          description: 'Park the current workstream so the next session in this project picks it up. Delivered once, then archived - this is a pass, not a durable note. Store anything worth keeping with knowl_store.',
          inputSchema: {
            type: 'object',
            properties: {
              // Non-empty, because there is one baton per project and parking replaces it: an
              // empty goal is not a handoff, it is the destruction of the real one.
              goal: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this workstream is trying to achieve.' },
              completed: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'What is already done.' },
              nextAction: { type: 'string', minLength: 1, maxLength: 2000, description: 'The single next thing to do.' },
              blocker: { type: 'string', maxLength: 2000, description: 'What is in the way, if anything.' },
              artifactRefs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Files or paths the next session should look at.' },
              verificationStatus: { type: 'string', enum: ['verified', 'unverified'], description: 'Whether the work so far was checked.' },
              // Advertised because the dispatcher reads it. An MCP client has no session of its
              // own to report, so this is what a host that knows its session id can pass; the
              // baton is delivered by project and host either way.
              sessionId: { type: 'string', description: 'The host session parking this work, if known.' },
            },
            required: ['goal', 'nextAction'],
          },
        },
        {
          name: 'knowl_park',
          description: 'Park a workstream the user means to return to. Mints a short key and returns a line to hand them verbatim. Unlike knowl_handoff, this is not consumed by resuming and works from any directory, any number of sessions later.',
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this workstream is trying to achieve.' },
              completed: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'What is already done.' },
              nextAction: { type: 'string', minLength: 1, maxLength: 2000, description: 'The next step as it stands now.' },
              blocker: { type: 'string', maxLength: 2000, description: 'What is in the way, if anything.' },
              artifactRefs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Files the returning session should look at.' },
              verificationStatus: { type: 'string', enum: ['verified', 'unverified'], description: 'Whether the work so far was checked.' },
              sessionId: { type: 'string', maxLength: 200, description: 'The session parking this work, if known, so the brief can point at its transcript.' },
            },
            required: ['goal'],
          },
        },
        {
          name: 'knowl_resume',
          description: 'Resume a parked workstream from its key. Call this as soon as a user supplies something that looks like a resume key. With no key, lists what is parked in this project.',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', maxLength: 200, description: 'The key the user pasted, in whatever form they pasted it.' },
            },
          },
        },
  ];

  if (config && isTranscriptSearchEnabled(config)) {
    tools.push(...TRANSCRIPT_TOOLS);
  }

  return tools;
}

/**
 * Every schema by tool name, including the transcript tools whether or not they are listed.
 *
 * Dispatch answers gated tools with their own disabled message rather than "unknown tool",
 * because a client that cached an older tool list can still call them -- so validation has
 * to know their shape even when listing does not offer them.
 */
const SCHEMA_BY_TOOL = new Map<string, Record<string, unknown>>(
  [...knowlToolDefinitions(null), ...TRANSCRIPT_TOOLS].map(tool => [tool.name, tool.inputSchema]),
);

/**
 * A context pack serialized under a hard character ceiling.
 *
 * Dropping whole items keeps the payload valid JSON, which cutting the string would not, and
 * the omitted count is reported so a short answer is never mistaken for a complete one.
 */
function boundContextResponse(pack: { sections: Array<{ name: string; items: unknown[]; estimatedTokens: number }> } & Record<string, unknown>): string {
  const sections = pack.sections.map(section => ({ ...section, items: [...section.items] }));
  const bounded = { ...pack, sections };
  let omitted = 0;
  let text = compactMcpJson(bounded);
  while (text.length > MAX_RESPONSE_CHARS) {
    const widest = sections.reduce((worst, section) => (section.items.length > worst.items.length ? section : worst), sections[0]);
    if (!widest || widest.items.length === 0) break;
    widest.items.pop();
    omitted += 1;
    text = compactMcpJson(omitted ? { ...bounded, omittedItems: omitted } : bounded);
  }
  return text;
}

export function registerTools(
  server: Server,
  getProjectId: () => string | null,
  getProjectRoot: () => string | null,
  getConfig: () => ProjectConfig | null,
  getInitError: () => string | null,
  // Startup completes the handshake before the database is open (see `startMcpServer`), so a
  // tool call can arrive while project id, root and config are all still null. Awaiting this
  // is what makes that restructure invisible to every handler below.
  whenReady: () => Promise<void> = async () => {}
): void {
  // 1. List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: knowlToolDefinitions(getConfig()) }));


  // 2. Call tool
  const callTool = async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    await whenReady();
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
      // Against the very schema `tools/list` published. Nothing did this before: the SDK checks
      // the request envelope, never the tool's own inputSchema, so `arguments` reached the
      // handlers exactly as written -- which is how an out-of-range confidence, a negative
      // maxChars and a missing required field all became runtime behaviour instead of refusals.
      validateToolArguments(name, SCHEMA_BY_TOOL.get(name), args);

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
        const { category, title, content, reasoning, alternatives, tags, source, sourceCommit, affectedPaths, confidence, provenance, steps, conflictKey, conflictScope, conflictExclusive, supersedes, namespace = 'project' } = args as any;

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
            provenance,
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
          // The same default limit the live path applies. Leaving it undefined made asOf the
          // one way to ask for the whole store: 15,133 characters where the same query without
          // it returned 2,528, from an argument that says nothing about size.
          const asOfLimit = limit ?? DEFAULT_RESULT_LIMIT;
          let items = await queryKnowledgeBase(projectId!, { query, category, status, tags, limit: asOfLimit, asOf });
          if (items.length === 0 && category) {
            items = await queryKnowledgeBase(projectId!, { query, status, tags, limit: asOfLimit, asOf });
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
          const embedding = await embedder.embedQuery(query);
          vector = {
            enabled: true,
            profileFingerprint: embedder.profileFingerprint,
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
          // Filters travel with the query. queryLayeredKnowledge has always taken them and
          // this call has always omitted them, so `status`, `tags` and `category` were dropped
          // on the default path -- byte-identical responses with and without, against a tool
          // description that promises they filter.
          ? await queryLayeredKnowledge(projectRoot!, query ?? '', configuredNamespaces(projectRoot!, config ?? undefined), limit ?? DEFAULT_RESULT_LIMIT, 'mcp', {
            category: category as KnowledgeCategory,
            status: status as KnowledgeStatus,
            tags,
          })
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
        // A ceiling on the argument bounds the pack; this bounds the response. Items are
        // dropped from the end rather than the string being cut, so what comes back is still
        // parseable JSON and says how much it left out.
        return { content: [{ type: 'text', text: boundContextResponse(explain ? pack : { sections: pack.sections, estimatedTokens: pack.estimatedTokens }) }] };
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
        // Standing is the deliberate consequence of feedback, applied here rather than
        // inside telemetry recording, which still never alters retrieval by itself.
        const tierChange = await applyFeedbackToTierBestEffort(projectId!, itemId, { useful, causedCorrection });
        // A correction implicates the corrected item's batch, not just the item: the
        // pass that produced one wrong atom usually produced more. Explicit
        // causedCorrection is the unambiguous signal; a routine supersede is not.
        let blast: Awaited<ReturnType<typeof flagCorrectionSiblingsBestEffort>> = null;
        if (causedCorrection === true) {
          const { getKnowledgeItem } = await import('../store/repository.js');
          const corrected = await getKnowledgeItem(itemId);
          blast = await flagCorrectionSiblingsBestEffort(projectId!, itemId, `"${corrected?.title ?? itemId}" (correction feedback)`);
        }
        const tierNote = tierChange
          ? `\n\nStanding: item ${tierChange.reason} to ${tierChange.tier}.`
          : '';
        const blastNote = blast && blast.flaggedIds.length > 0
          ? `\n\nBlast radius: ${blast.flaggedIds.length} sibling item(s) marked needs_review${blast.capped ? ' (capped)' : ''}.`
          : '';
        return { content: [{ type: 'text', text: `Recorded feedback for ${itemId}:\n\n${JSON.stringify(feedback, null, 2)}${tierNote}${blastNote}` }] };
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
        // Checked BEFORE the update is written. It used to be resolved after, so an unknown
        // supersedeId threw once the update had already committed and the whole call was
        // reported as failed -- the agent believed nothing happened while memory had moved.
        const { getKnowledgeItem: readItem, supersedeKnowledgeItem } = await import('../store/repository.js');
        if (supersedeId) {
          if (supersedeId === id) {
            throw new Error('supersedeId names a DIFFERENT item to retire; it cannot be the item being updated.');
          }
          if (!(await readItem(supersedeId))) {
            throw new Error(`No knowledge item "${supersedeId}" to supersede. Nothing was updated.`);
          }
        }
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

        // Past this point the update is durable, so a failure here can never be reported as
        // "the call failed" -- that is the lie the pre-check exists to make impossible, and
        // this is the residual case it cannot cover.
        let supersedeNote = '';
        if (supersedeId) {
          try {
            await supersedeKnowledgeItem(supersedeId, updated.id);
            supersedeNote = `; retired ${supersedeId}`;
          } catch (error) {
            supersedeNote = `. WARNING: the update IS saved, but retiring ${supersedeId} failed (${sanitizeToolErrorMessage(String((error as Error).message))}). Both items are still active`;
          }
        }
        return {
          content: [{ type: 'text', text: `Successfully updated item ${id} (${updated.freshness})${supersedeNote}` }],
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
        // The one tool that bypassed response formatting entirely: pretty-printed, unbounded,
        // and echoing an absolute path per skill -- 13,871 characters for six of them. A list
        // is for choosing which skill to read; knowl_skill_read is where the detail lives.
        const listed = skills.slice(0, MAX_SKILLS_LISTED).map(skill => ({
          name: skill.name,
          purpose: truncateText(skill.purpose, MAX_SKILL_PURPOSE_CHARS),
          triggers: skill.triggers.slice(0, MAX_TRIGGERS_LISTED).map(trigger => truncateText(trigger, MAX_TRIGGER_CHARS)),
          entrypoints: skill.entrypoints,
        }));
        return {
          content: [{
            type: 'text',
            text: compactMcpJson(skills.length > listed.length
              ? { skills: listed, omitted: skills.length - listed.length }
              : listed),
          }],
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

      else if (name === 'knowl_handoff') {
        const { goal, completed, nextAction, blocker, artifactRefs, verificationStatus, sessionId } = args as any;
        const { handoff } = await recordDeliberateHandoff(projectId!, {
          // The MCP layer is host-neutral and has no way to learn which host is calling, so a
          // baton parked here is filed under the host whose hooks deliver it on session start.
          host: 'claude',
          projectRoot: projectRoot!,
          externalSessionId: sessionId ? String(sessionId) : 'unknown',
          taskState: {
            goal: String(goal ?? ''),
            nextAction: String(nextAction ?? ''),
            completed: Array.isArray(completed) ? completed.map(String).slice(0, 20) : undefined,
            blocker: blocker ? String(blocker) : undefined,
            artifactRefs: Array.isArray(artifactRefs) ? artifactRefs.map(String).slice(0, 20) : undefined,
            verificationStatus: verificationStatus === 'verified' ? 'verified' : 'unverified',
          },
        });
        return {
          content: [{
            type: 'text',
            text: `Parked. The next session in this project will receive this once.\n\n${formatPendingHandoffContext(handoff)}`,
          }],
        };
      }

      else if (name === 'knowl_park') {
        const { goal, completed, nextAction, blocker, artifactRefs, verificationStatus, sessionId } = args as any;
        const point = await createResumePoint(projectRoot!, {
          goal: String(goal ?? ''),
          completed: Array.isArray(completed) ? completed.map(String).slice(0, 20) : undefined,
          nextAction: nextAction ? String(nextAction) : undefined,
          blocker: blocker ? String(blocker) : undefined,
          artifactRefs: Array.isArray(artifactRefs) ? artifactRefs.map(String).slice(0, 20) : undefined,
          verificationStatus: verificationStatus === 'verified' ? 'verified' : 'unverified',
          sessionId: sessionId ? String(sessionId) : undefined,
        });

        // The instruction line, not the bare key: told only "your key is k3t9m4", people write
        // down something the next session will not recognise as a resume request.
        return {
          content: [{ type: 'text', text: `Parked.\n\n${resumeInstruction(point.key)}` }],
        };
      }

      else if (name === 'knowl_resume') {
        const { key } = args as any;

        if (key) {
          // Looked up globally, with no project filter. A key is held by the user, and pasting
          // one while sitting in a different repo is the normal case rather than a mistake.
          const point = await readResumePoint(String(key));
          if (!point) {
            return {
              content: [{
                type: 'text',
                text: 'No parked workstream for that key. Call knowl_resume with no key to list what is parked in this project.',
              }],
            };
          }
          return { content: [{ type: 'text', text: formatResumeBrief(point) }] };
        }

        const points = await listResumePoints(projectRoot!);
        if (points.length === 0) {
          return { content: [{ type: 'text', text: 'Nothing is parked in this project.' }] };
        }
        return {
          content: [{
            type: 'text',
            text: [
              'Parked in this project:',
              ...points.map(point => `- ${point.key}: ${point.goal} (${point.createdAt})`),
              '',
              'Resume one with knowl_resume and its key.',
            ].join('\n'),
          }],
        };
      }

      // Both handlers re-check the gate themselves and answer with DISABLED_MESSAGE rather than
      // throwing. A client that cached an older tool list can still call these, so the gate has
      // to hold at dispatch and not only at listing.
      else if (name === 'knowl_transcript_search') {
        const { query, sessionId, repos, limit } = args as any;
        const text = await handleTranscriptSearch({
          config,
          projectRoot,
          query: String(query ?? ''),
          sessionId: sessionId ? String(sessionId) : undefined,
          repos: Array.isArray(repos) ? repos.map(String) : undefined,
          limit: typeof limit === 'number' ? limit : undefined,
        });
        return { content: [{ type: 'text', text }] };
      }

      else if (name === 'knowl_session_list') {
        const { query, limit } = args as any;
        const text = await handleSessionList({
          config,
          projectRoot,
          projectId,
          query: query ? String(query) : undefined,
          limit: typeof limit === 'number' ? limit : undefined,
        });
        return { content: [{ type: 'text', text }] };
      }

      else if (name === 'knowl_transcript_read') {
        const { locator, context } = args as any;
        const text = await handleTranscriptRead({
          config,
          projectRoot,
          locator: String(locator ?? ''),
          context: typeof context === 'number' ? context : undefined,
        });
        return { content: [{ type: 'text', text }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      if (error instanceof ToolInputError) {
        // Refused, not executed. Named separately so the caller can tell "I sent this wrong"
        // from "the store failed", and so the message is the argument rather than a statement.
        return { isError: true, content: [{ type: 'text', text: `Invalid arguments for "${name}": ${error.message}` }] };
      }
      const message = error instanceof KnowledgeValidationError
        ? `${error.code}: ${error.message}`
        : sanitizeToolErrorMessage(String(error?.message ?? error));
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
    // Before `getProjectRoot()`, not just before dispatch: startup fills that variable in
    // behind the handshake, and reading it early would take a watermark against `null`.
    await whenReady();
    const projectRoot = getProjectRoot();
    const watermark = await captureChangeWatermark(projectRoot);
    const result = await callTool(request);
    const notice = await consumeChangeNotice(projectRoot, request.params.name, watermark);
    if (!notice) return result;
    return { ...result, content: [...result.content, { type: 'text' as const, text: notice }] };
  });
}
