import { KNOWLEDGE_CATEGORIES } from '../core/types.js';
import { MAX_ITEM_CONTENT_CHARS } from '../core/token-budget.js';
import { UNTRUSTED_NOTICE } from '../core/untrusted.js';

/**
 * The MCP tool schemas, as data.
 *
 * They lived inside `registerTools`'s sibling `knowlToolDefinitions`, which meant nothing
 * outside the running server could read them -- so the README's tool table and its
 * "exactly N tools" line were maintained by hand and drifted to three different numbers at
 * once. `scripts/generate-docs.ts` reads this module, and a CI check fails on drift.
 *
 * Moving the literal costs nothing at runtime: it is the same array, evaluated once at module
 * load instead of once per `knowlToolDefinitions` call.
 */
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * Ceilings named inside the schemas below, so they travel with the text that quotes them.
 *
 * The transcript tools already bound every numeric argument and cap their rendered output;
 * the older tools bounded nothing, and one `knowl_context` call was measured at 58,531
 * characters. These are the same ceilings expressed for this half of the surface.
 */
export const MAX_QUERY_LIMIT = 25;
export const MIN_MARKDOWN_CHARS = 200;
export const MAX_MARKDOWN_CHARS = 20_000;
export const MAX_CONTEXT_TOKEN_BUDGET = 4_000;

/** Registered only when the repo turned transcript search on. */
export const TRANSCRIPT_TOOL_DEFINITIONS: ToolDefinition[] = [
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

/** Every tool the server always offers, in listing order. */
export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = [
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
                description: 'Repository-relative file paths this knowledge depends on. Every query that returns this item returns them with it, and because content comes back truncated they are how the next reader reaches the source instead of searching for it. An item without them is a fact whose evidence only you can find.',
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
                description: 'How this came to be believed: observed (execution or direct inspection), user_stated (the human said so), or inferred (concluded without direct evidence). Claiming observed or user_stated ranks an item above one that claims nothing, and leaving this unset scores exactly the same as an honest inferred -- silence buys no rank, so say which it was.',
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
                // Every other array on this surface is capped -- tags/repos/completed at 20 --
                // and this one, the one that writes the store, was unbounded. 400 atoms in a
                // single call produced a 92,000-character response and one transaction that
                // could retire other atoms from the same batch.
                maxItems: 50,
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
                    affectedPaths: {
                      type: 'array', items: { type: 'string' },
                      description: 'Repository-relative file paths this atom depends on. Returned with the atom on every query, and the only route from a truncated result back to the source.',
                    },
                    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Optional confidence from 0.0 to 1.0. Values outside that range are refused.' },
                    provenance: {
                      type: 'string',
                      enum: ['observed', 'user_stated', 'inferred'],
                      description: 'How this came to be believed: observed (execution or direct inspection), user_stated (the human said so), or inferred (concluded without direct evidence). Claiming observed or user_stated ranks an item above one that claims nothing, and leaving this unset scores exactly the same as an honest inferred -- silence buys no rank, so say which it was.',
                    },
                    steps: { type: 'array', items: { type: 'string' } },
                    supersedes: { type: 'string', minLength: 1, description: 'Id of an active item this atom replaces; it is marked superseded (retired but still queryable), not deleted.' },
                    // The batch writer forwards these; the schema did not offer them, so
                    // exclusivity was enforceable from knowl_store and unreachable from a
                    // batch -- the two write paths disagreeing about what a conflict key means.
                    conflictKey: { type: 'string', description: 'Optional normalized semantic identity key.' },
                    conflictScope: { type: 'object', description: 'Optional scope for the conflict key.' },
                    conflictExclusive: { type: 'boolean', description: 'Whether only one active value may exist for this key/scope.' },
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
          description: 'Use this first for specific project questions, before each new subtask, and when switching areas during multi-step work. Use every word that names the subject and none that does not: one more on-subject term retrieves better, one off-subject term retrieves worse, so never pad a query to reach a length and never drop a real term to stay under one. Skip only for directly relevant active lifecycle context, a same-request query, or relevant memory returned by knowl_task_start. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests -- and on a miss, re-run once with different words first, because a first-pass miss is usually vocabulary rather than absence. `content` is cut at '
            + MAX_ITEM_CONTENT_CHARS
            + ' characters and marked `truncated` when it was; `affectedPaths` names the files the item depends on, so open those rather than searching for them. To read a truncated item in full, call again with `id` set to the id of that result. Results carry `score` (0-1) when semantic search is available: it is the relevance the ranker ordered by and it is comparable across queries, so a low top score means the best available match is weak rather than that it is the answer. When no calibrated number exists, `score` is the string `uncalibrated (<reason>)`: the ranker has an order but no opinion on strength, so do not read position as confidence -- judge the content itself. '
            + UNTRUSTED_NOTICE,
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                description: 'Fetch exactly this item, whole: full untruncated content plus the fields a search result omits (reasoning, alternatives, provenance, status, source, timestamps). Use it to read the rest of a result that came back `truncated`. When set, every other argument except includeEvidence is ignored.',
              },
              query: {
                type: 'string',
                maxLength: 500,
                description: 'The words that name the subject, not the whole sentence. Length is not the variable -- relevance is: adding a term that is genuinely about the subject helps, and adding one that is not costs more than leaving a term out. Example: "sqlite wal checkpoint corruption durability".',
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
          description: 'Run an approved learned-skill entrypoint. A skill must be approved by the user with `knowl skill approve <name>` before it will run, and any edit to the package revokes that approval. Only an entrypoint whose author set `autoRun: true` will run; that is not the default. If the call is refused, relay the approval command to the user rather than trying to work around it.',
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
