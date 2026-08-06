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
import { DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, MAX_PREVIEW_CHARS, truncateText, uncalibratedScore, type UncalibratedScore } from '../core/token-budget.js';
import { getRecentContext } from '../store/recent-context.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../store/knowledge-writer.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../store/knowledge-actions.js';
import { isVectorSearchEnabled, createLocalEmbeddingProvider } from '../ai/embeddings.js';
import { queryKnowledgeForAgentExplained } from '../store/agent-query.js';
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
import { CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS, type ToolDefinition } from './tool-definitions.js';

/**
 * Ceilings for the handlers. The ones the SCHEMAS quote live beside the schemas, in
 * `./tool-definitions.ts`, so the text and the number cannot drift apart.
 */
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
    ...CORE_TOOL_DEFINITIONS,
  ];

  if (config && isTranscriptSearchEnabled(config)) {
    tools.push(...TRANSCRIPT_TOOL_DEFINITIONS);
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
  [...knowlToolDefinitions(null), ...TRANSCRIPT_TOOL_DEFINITIONS].map(tool => [tool.name, tool.inputSchema]),
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

/**
 * Every id a write is about to touch, checked before any of it happens.
 *
 * `supersedes`/`supersedeId` retires an item, which is a write to that item, and it was
 * unguarded on all four write tools while the item being *updated* was checked. Sequential
 * calls rather than one array call so this holds against either signature of
 * `assertOwnedItem`; the checks still all precede the first write, which is the property
 * that matters. Resolving the workspace is skipped entirely when no retire is requested,
 * so an ordinary write pays nothing for this.
 */
async function assertOwnedTargets(
  ids: Array<string | undefined | null>,
  projectRoot: string | null,
  config: ProjectConfig | null,
): Promise<void> {
  const present = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (present.length === 0 || !projectRoot) return;
  const owner = await resolveWorkspace(projectRoot, config ?? undefined);
  if (!owner) return;
  for (const id of present) await assertOwnedItem(id, owner);
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
        try { await assertOwnedTargets([supersedes], projectRoot, config); }
        catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }

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
        // Every atom's retire target, before the first atom is written. A batch that fails
        // partway leaves the earlier atoms behind, so this cannot be checked per atom.
        try { await assertOwnedTargets(atoms.map((atom: any) => atom.supersedes), projectRoot, config); }
        catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }

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
        try { await assertOwnedTargets([supersedes], projectRoot, config); }
        catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
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
          // No provenance argument, so the foreign-repo guard further down never runs here and
          // `affectedPaths` always ships. Safe only because `queryKnowledgeBase` resolves
          // against one project id, so this branch cannot return a foreign item. Pinned by
          // tests/mcp/query-pointer-surface.test.ts — federate this path and that test fails.
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
            relevanceFloor: embedder.relevanceFloor,
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
          // Explained on both branches now. `explain` decides what is REPORTED, never what is
          // computed: the ranker produced a score either way, and the non-explain path threw
          // it away one line before the response was built.
          : await queryKnowledgeForAgentExplained(projectId!, queryOptions);

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
        //
        // `score` goes the same way, and it is NOT gated on `explain`: the agent reading this
        // is deciding whether to trust memory or go read the files, and a rank cannot separate
        // "this is the answer" from "this is the best of a bad lot".
        //
        // A *number* is published only when the semantic half is present, which is the
        // condition under which it means anything across queries. Cosine is absolute and
        // carries 0.8 of the fused relevance; a lexical-only ranking divides each candidate by
        // its own corpus's best hit, so its top result scores near 1 whatever it is and the
        // number would say "rank 1" in more digits. That is also why the layered namespace
        // path publishes none: each namespace is scored against its own corpus, so two 1.0s
        // from two stores are not comparable to each other, and two numbers that invite a
        // comparison they cannot support are worse than no number.
        //
        // But withholding used to be silence, and 907 of 924 archived results were that
        // silence (docs/evals/agent-surface.md §10) -- indistinguishable from the field having
        // been forgotten. So the gate now speaks: where no calibrated number exists, `score`
        // is the string `uncalibrated (<reason>)`, the ranker's explicit "no opinion on
        // strength, only an order". Per-row reasons (`lexical-only`, `not embedded`) come up
        // from the ranker as `explanation.uncalibrated`; the layered reason is this caller's,
        // because only it knows it interleaved per-namespace rankings -- and only when
        // federation did not replace that result, which it does whenever a workspace is active.
        const scored = Boolean(vector?.enabled && vector.embedding);
        const scoreOf = (item: any): number | UncalibratedScore | undefined => {
          if (layered && !active) return uncalibratedScore('layered namespaces');
          const explanation = item.explanation as
            | { finalScore?: number; uncalibrated?: 'lexical-only' | 'not embedded' }
            | undefined;
          if (explanation?.uncalibrated) return uncalibratedScore(explanation.uncalibrated);
          return scored && typeof explanation?.finalScore === 'number' ? explanation.finalScore : undefined;
        };
        // Evidence and staleness resolve against THIS repo's filesystem and database, so a
        // foreign item would be judged against the wrong checkout -- reporting "stale" for a
        // file that is simply somewhere else. Omitting it beats answering wrongly.
        const isForeign = (item: any) => Boolean(active) && item.repo && item.repo !== active!.repo;
        const compact = (item: any) => {
          const score = scoreOf(item);
          const { affectedPaths, ...rest } = compactItemResponse(item, {
            ...(item.repo ? { repo: item.repo } : {}),
            ...(score === undefined ? {} : { score }),
          });
          return {
            ...rest,
            // Paths are repository-relative, so a foreign item's are relative to a checkout
            // that is not this one. Handing them over unqualified invites a reader to open a
            // same-named file here and treat it as the evidence -- and the repos most likely
            // to be linked are fork siblings, where the same path exists in both and means
            // different things. Same reasoning as the evidence omission directly above.
            ...(affectedPaths && !isForeign(item) ? { affectedPaths } : {}),
            ...(explain && item.explanation ? { explanation: item.explanation } : {}),
          };
        };
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
        // The floor's verdict, in words. It used to be delivered by returning nothing at all,
        // which the caller could not tell apart from an empty store or a missing index -- and
        // which deleted the answer on every query where the verdict was wrong. The rows now
        // stand and the verdict rides beside them, so a caller can act on it or overrule it.
        if (resolvedItems.some(item => (item.explanation as { abstained?: boolean } | undefined)?.abstained)) {
          blocks.push({
            type: 'text',
            text: 'NO CONFIDENT MATCH: every result above scored below the relevance floor, so this store probably does not hold the answer. They are returned rather than withheld because the floor is a fixed threshold on a corpus-dependent scale and is wrong often enough to matter — read `score` and judge. If none of them answers the question, treat this as a miss and go to the files.',
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
        // Both ids, not just the one being edited. Retiring an item is a write to that item,
        // and `supersedeId` reached `supersedeKnowledgeItem` with no ownership check at all
        // while the item named by `id` was guarded on the line above.
        try { await assertOwnedItem(id, owner); if (supersedeId) await assertOwnedItem(supersedeId, owner); }
        catch (error) { return { content: [{ type: 'text', text: (error as Error).message }] }; }
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
          content: [{ type: 'text', text: compactMcpJson({ manifest: skill.manifest, markdown: truncateText(skill.markdown, MAX_PREVIEW_CHARS), truncated: skill.markdown.length > MAX_PREVIEW_CHARS }) }],
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
        return { content: [{ type: 'text', text: compactMcpJson({ ...result, stdout: truncateText(result.stdout, MAX_PREVIEW_CHARS), stderr: truncateText(result.stderr, MAX_PREVIEW_CHARS), attempts: result.attempts.map(attempt => ({ entrypoint: attempt.entrypoint, exitCode: attempt.exitCode })) }) }] };
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
