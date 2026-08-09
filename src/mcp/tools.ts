import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureChangeWatermark, consumeChangeNotice } from './change-notice.js';
import { KNOWLEDGE_CATEGORIES, ProjectConfig, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { assertOwnedItem } from '../workspace/ownership.js';
import { flattenGroups, queryFederated, type FederatedResult } from '../workspace/federated-query.js';
import { recordDemandEventBestEffort } from '../workspace/demand-ledger.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { formatHierarchyToMarkdown, formatRecentContextToMarkdown } from '../core/format.js';
import { inlineUntrusted } from '../core/untrusted.js';
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
import { finishMemorySession, listActiveMemorySessions } from '../store/session-repository.js';
import { isImpactEnabled } from '../store/impact-config.js';
import { openFindingsForSession, resolveFinding, type ImpactFinding, type ImpactTier } from '../session/impact.js';
import { activeReadSetForSession } from '../store/read-set.js';
import { formatPendingHandoffContext, recordDeliberateHandoff } from '../session/session-handoff.js';
import { createResumePoint, formatResumeBrief, listResumePoints, readResumePoint } from '../session/resume-points.js';
import { resumeInstruction } from '../session/resume-keys.js';
import { finalizeMemorySession } from '../store/session-finalizer.js';
import { configuredNamespaces, namespaceDescriptor, queryLayeredKnowledge, withNamespaceDatabase } from '../store/namespaces.js';
import { isTranscriptSearchEnabled } from '../transcripts/config.js';
import { handleSessionList, handleTranscriptRead, handleTranscriptSearch } from '../transcripts/mcp-handlers.js';
import { sanitizeToolErrorMessage, ToolInputError, validateToolArguments } from './tool-schema.js';
import { CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS, type ToolDefinition } from './tool-definitions.js';
import { teamUpdateNotice } from '../cloud/team-update.js';
import { maybeAutoSync } from '../cloud/auto-sync.js';

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

/**
 * The team watermark this process has already told the agent about.
 *
 * Per-process rather than persisted: the notice is about what changed during THIS session, and
 * a value surviving a restart would make the first query of every session silent about a
 * replica that had moved while the agent was away.
 */
let seenTeamSeq: string | null = null;


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


/** Resolutions `knowl_impact` accepts, matching `ImpactResolution` in the store. */
const IMPACT_RESOLUTIONS = ['repaired', 'dismissed', 'expired', 'false_positive'];

/**
 * The default tier set: everything measured, and nothing that is not.
 *
 * `possible` is path- and title-matching -- the tier `drift-auto.ts:17-40` already measured at
 * one commit window matching 36 of 301 atoms, and already refused to act on. Returning it by
 * default would spend the agent's context on the one tier this repo has on record as mostly
 * noise, so it is reachable only by asking for it by name.
 */
const DEFAULT_IMPACT_TIERS: ImpactTier[] = ['certain', 'likely'];

/**
 * Ceilings on a reply the agent did not size. A signature is one line of code, not a file, and
 * fifteen findings each carrying two of them lands around 8,000 characters -- inside the 12,000
 * every other bounded reply on this surface is held to, with room for the wrapper.
 */
const MAX_IMPACT_FINDINGS = 15;
const MAX_IMPACT_SIGNATURE_CHARS = 200;

const IMPACT_DISABLED_MESSAGE =
  'Change-impact detection is not enabled for this repository. Enable impact.enabled with `knowl config`.';

// Registered only when the repo turned change impact on. One tool, not two: `types.ts:267-271`
// records that every registered tool costs guidance-card space in every session of every user,
// so reading findings and adjudicating one share a surface rather than splitting into a pull
// tool and a resolve tool.
const IMPACT_TOOLS: ToolDefinition[] = [
        {
          name: 'knowl_impact',
          description: 'Change-impact findings: code a live session read that has since moved underneath it. Pass resolve to adjudicate one. A certain-tier finding also refuses the next edit to that file until you re-read it, so listing them here is how you see what is about to be blocked and why.',
          inputSchema: {
            type: 'object',
            properties: {
              scope: {
                type: 'string', enum: ['mine', 'all'],
                description: 'mine (default): findings against reads still held open -- the work someone can still act on. all: every open finding, including ones whose read was released when its session ended and which nobody has adjudicated yet.',
              },
              tier: {
                type: 'string', enum: ['certain', 'likely', 'possible'],
                description: 'One tier. Omit for certain + likely; `possible` is unmeasured path matching and is returned only when asked for by name.',
              },
              resolve: {
                type: 'object',
                description: 'Adjudicate one finding. This is the only way a finding is ever closed -- the write gate deliberately leaves them open -- and the resolutions are the measurement: false_positive is what makes a precision number possible, so use it when it is the true answer.',
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 64, description: 'The finding id, exactly as it was returned.' },
                  resolution: {
                    type: 'string', enum: IMPACT_RESOLUTIONS,
                    description: 'repaired: you reconciled your work with the change. false_positive: the change does not affect what you were doing. dismissed: it does affect you and you are proceeding anyway. expired: the work it concerned is gone.',
                  },
                },
                required: ['id', 'resolution'],
                additionalProperties: false,
              },
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
/**
 * The tools a caller reaches for most, first.
 *
 * Models bias toward tools listed earlier, and this list led with `knowl_ingest` purely because
 * it was written first -- a tool that requires an AI provider, unconfigured on most installs, so
 * the first thing the surface advertised was the one thing it usually cannot do. `knowl_query`,
 * which the documented workflow says to call before anything else, sat seventh.
 *
 * Order is data rather than a sort key on the definitions, so it stays byte-stable across builds:
 * a tool list whose order changes between runs breaks prompt-prefix caching for every client that
 * holds the catalog in context. Anything unnamed keeps its existing relative position after the
 * named ones, so adding a tool needs no change here.
 */
const SELECTION_ORDER = [
  'knowl_query',
  'knowl_store',
  'knowl_update',
  'knowl_recent',
  'knowl_state',
  'knowl_decide',
  'knowl_context',
];

function orderForSelection(tools: ToolDefinition[]): ToolDefinition[] {
  const rank = (tool: ToolDefinition) => {
    const index = SELECTION_ORDER.indexOf(tool.name);
    return index === -1 ? SELECTION_ORDER.length : index;
  };
  // Stable: equal ranks keep source order, so only the named few move.
  return tools.map((tool, index) => ({ tool, index }))
    .sort((a, b) => rank(a.tool) - rank(b.tool) || a.index - b.index)
    .map(entry => entry.tool);
}

export function knowlToolDefinitions(config: ProjectConfig | null): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    ...CORE_TOOL_DEFINITIONS,
  ];

  if (config && isTranscriptSearchEnabled(config)) {
    tools.push(...TRANSCRIPT_TOOL_DEFINITIONS);
  }

  if (config && isImpactEnabled(config)) {
    tools.push(...IMPACT_TOOLS);
  }

  return orderForSelection(tools);
}

/**
 * Every schema by tool name, including the gated tools whether or not they are listed.
 *
 * Dispatch answers gated tools with their own disabled message rather than "unknown tool",
 * because a client that cached an older tool list can still call them -- so validation has
 * to know their shape even when listing does not offer them.
 */
const SCHEMA_BY_TOOL = new Map<string, Record<string, unknown>>(
  [...knowlToolDefinitions(null), ...TRANSCRIPT_TOOL_DEFINITIONS, ...IMPACT_TOOLS].map(tool => [tool.name, tool.inputSchema]),
);

/** What a shortened result keeps of its body: enough to judge relevance, not to answer from. */
const QUERY_EXCERPT_CHARS = 240;

/**
 * Shrink the lowest-ranked results until the serialized array fits the response ceiling.
 *
 * `MAX_RESPONSE_CHARS` is declared as the ceiling for this half of the surface and was wired
 * into `boundContextResponse` only -- so `knowl_context` was bounded and `knowl_query`, the
 * most-called tool on the server, had none. Measured at 45,147 characters for a 25-result
 * query over 2,000-character atoms, and 59,990 with `includeEvidence` and `explain`; raising
 * `MAX_ITEM_CONTENT_CHARS` from 600 to 2,000 tripled that floor on the one path nothing
 * watched.
 *
 * Bodies go before results do. Dropping a result hides that the item exists at all, which is
 * indistinguishable from a retrieval miss; shortening one costs the body and keeps the id,
 * title and score -- and `knowl_query { id }` now reads any of them whole, so the information
 * is deferred rather than lost. Measured against dropping: a `limit: 25` query over 2 KB atoms
 * returned 5 of 25, where shortening returns all 25 with the weakest bodies excerpted.
 *
 * Results arrive ranked, so the tail gives up its body first. Dropping remains the last
 * resort, for when every body is already an excerpt and the count itself is the cost. At least
 * one result is always kept: a single oversized atom should come back truncated-but-present
 * rather than as an empty array that reads like a miss. The counts are returned rather than
 * folded into the payload, because the first block must stay parseable for callers that read it.
 *
 * **Grouped payloads use the same walk over a flattened view.** Groups arrive with an empty
 * local group pinned first and the rest in relevance order, so laying them end to end puts the
 * weakest rows of the least relevant repo last -- "trim peers before local" is what the existing
 * tail-first rule already does once the rows are in one sequence, and needs no separate rule.
 * An empty group keeps its key with an empty array: that key IS the "your repo has nothing on
 * this" signal, and a serializer that dropped it would delete the message the shape carries.
 */
export function boundQueryPayload(
  groups: Array<{ repo: string; rows: Record<string, unknown>[] }>,
  shape: 'flat' | 'grouped',
): { text: string; shortened: number; omitted: number } {
  // One flat view for the shrink walk, one grouped view for serialization. `repo` rides along
  // so a row replaced during the walk lands back under the right key.
  const kept = groups.flatMap(group =>
    group.rows.map(value => ({ repo: group.repo, value, shortened: false })));
  const serialize = () => {
    if (shape === 'flat') return compactMcpJson(kept.map(entry => entry.value));
    const byRepo: Record<string, Record<string, unknown>[]> = {};
    for (const group of groups) byRepo[group.repo] = [];
    for (const entry of kept) byRepo[entry.repo].push(entry.value);
    return compactMcpJson(byRepo);
  };

  let text = serialize();
  if (text.length <= MAX_RESPONSE_CHARS) return { text, shortened: 0, omitted: 0 };

  for (let index = kept.length - 1; index >= 0 && text.length > MAX_RESPONSE_CHARS; index--) {
    const content = kept[index].value.content;
    if (typeof content !== 'string' || content.length <= QUERY_EXCERPT_CHARS) continue;
    // `truncated` is the same flag a content-ceiling cut sets, so the instruction the tool
    // description already gives -- call again with `id` to read the rest -- covers this too.
    kept[index] = {
      repo: kept[index].repo,
      value: { ...kept[index].value, content: truncateText(content, QUERY_EXCERPT_CHARS), truncated: true },
      shortened: true,
    };
    text = serialize();
  }

  // Dropping must never empty a group that had rows.
  //
  // The keys are rebuilt from `groups` on every serialize, so a group whose last row is popped
  // comes back as `[]` -- and an empty array under a repo's name is exactly how this surface
  // says "that repo holds nothing on this". Trimming for size would forge that sentence, and
  // most easily against the local repo: when a peer outscores it, the local group sorts last and
  // its rows are the first to go. The reader would be told their own repo knows nothing about a
  // subject it had just answered on.
  //
  // So a group's final row is never dropped, only shortened. At most one row per group survives
  // beyond the ceiling, which is a bounded overrun and the honest one: a short page is visible,
  // a fabricated miss is not.
  let omitted = 0;
  const isLastOfGroup = (index: number) =>
    kept.filter(entry => entry.repo === kept[index].repo).length === 1;
  for (let index = kept.length - 1; index >= 0 && text.length > MAX_RESPONSE_CHARS; index--) {
    if (kept.length <= 1 || isLastOfGroup(index)) continue;
    kept.splice(index, 1);
    omitted += 1;
    text = serialize();
  }

  return { text, shortened: kept.filter(entry => entry.shortened).length, omitted };
}

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

/** One open finding, with the session whose work it is against. */
type OpenImpact = { sessionId: string; finding: ImpactFinding };

/**
 * The evidence a certain finding carries, parsed, or null when it is not that shape.
 *
 * `path_json` is written at detection time because the "was:" side cannot be recomputed later
 * (`impact.ts:71-87`) -- so this is the only place the old signature still exists, and a finding
 * whose payload will not parse is still worth reporting without it. Never throws: a malformed
 * payload must cost a rendering detail, never the finding.
 */
function impactEvidence(finding: ImpactFinding): Record<string, unknown> | null {
  if (!finding.pathJson) return null;
  try {
    const parsed = JSON.parse(finding.pathJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const impactText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? truncateText(value, MAX_IMPACT_SIGNATURE_CHARS) : null;

/**
 * Open findings across the sessions still running in this repo.
 *
 * `scope: 'mine'` is served as "against a read still held open" rather than "against the calling
 * session", because MCP has no session identity to compare against: the 2026-07-28 revision made
 * the protocol stateless and removed `Mcp-Session-Id`, so a tool call carries nothing that names
 * its caller. A held read is the closest honest proxy -- it is work somebody is still standing on,
 * which is the set an agent can act on -- and `all` widens it to include findings whose read was
 * released when its session ended and which nobody has adjudicated, since an unadjudicated finding
 * is exactly what the precision denominator is missing (plan §9).
 *
 * Session end, not task finish: `releaseSessionReadSet` is called from the stop and failure
 * branches of `host-lifecycle.ts` and nowhere else. The task-scoped release was removed in #33
 * because nothing on the capture path knows a task id.
 *
 * The read-set query runs only for a session that actually has findings, so the common case --
 * every session clean -- costs one query per live session and nothing else.
 */
async function openImpactFindings(scope: 'mine' | 'all', tiers: ImpactTier[]): Promise<OpenImpact[]> {
  const open: OpenImpact[] = [];
  for (const session of await listActiveMemorySessions()) {
    const findings = (await openFindingsForSession(session.id)).filter(finding => tiers.includes(finding.tier));
    if (findings.length === 0) continue;
    const held = scope === 'mine'
      ? new Set((await activeReadSetForSession(session.id)).map(entry => entry.id))
      : null;
    for (const finding of findings) {
      if (held && !held.has(finding.affectedId)) continue;
      open.push({ sessionId: session.id, finding });
    }
  }
  return open;
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
    const { name } = request.params;
    // `arguments` is optional in the protocol, and a conformant client omits it for a tool whose
    // properties are all optional. `validateToolArguments` already reads undefined as `{}` -- but
    // every handler destructures `args` directly, so the four zero-required tools (knowl_query,
    // knowl_state, knowl_recent, knowl_resume) threw a raw `Cannot destructure property ... of
    // undefined` onto the wire. Normalise once here rather than in fourteen handlers.
    const args = request.params.arguments ?? {};
    await whenReady();
    const initError = getInitError();
    const projectId = getProjectId();
    const projectRoot = getProjectRoot();
    const config = getConfig();

    if (initError) {
      return {
        // `isError` is the only signal an agent has that a call did not do what it asked.
        // Without it this banner -- "the server is up but this is not a Knowl project" --
        // read as a successful write, so an agent stored nothing and carried on believing
        // memory held it.
        isError: true,
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
        catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }

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
            // The quoted title is stored text echoed back on one line, so it gets the same
            // treatment as every other stored value that reaches the agent.
            content: [{ type: 'text', text: `NOT STORED — this ${category} is already held verbatim as item ${result.item.id} ("${inlineUntrusted(result.item.title)}"), so nothing was written and nothing was lost. No action needed.` }],
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
        catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }

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
        catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
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
            content: [{ type: 'text', text: `NOT STORED — this decision is already held verbatim as item ${result.item.id} ("${inlineUntrusted(result.item.title)}"), so nothing was written and nothing was lost. No action needed.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Successfully recorded decision ${result.item.id}${describeWriteReconciliation(result)}` }],
        };
      }
      
      else if (name === 'knowl_query') {
        const { id, query, category, status, tags, limit, includeEvidence, explain, asOf, repos, scope } = args as any;
        // Fetch-by-id: the second half of progressive disclosure. Truncation with no way to read
        // the rest is not disclosure, it is loss with a warning label -- 262 of 639 atoms on a
        // real store exceed the content ceiling and no tool could return them whole. A parameter
        // rather than a 31st tool, deliberately: the tool list already costs ~6,700 tokens per
        // session. This is also the first surface that returns `reasoning` and `alternatives` --
        // `knowl_decide` REQUIRES reasoning and until now nothing could hand it back.
        if (id) {
          const { getKnowledgeItem } = await import('../store/repository.js');
          const item = await getKnowledgeItem(String(id));
          if (!item) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `No knowledge item "${id}" in this repo's store. If it belongs to a linked repo, run this from that repo -- fetch is local so a foreign atom's paths are never read against the wrong checkout.`,
              }],
            };
          }
          const full = {
            id: item.id,
            category: item.category,
            title: item.title,
            content: item.content,
            ...(item.reasoning ? { reasoning: item.reasoning } : {}),
            ...(item.alternatives?.length ? { alternatives: item.alternatives } : {}),
            status: item.status,
            freshness: item.freshness,
            confidence: item.confidence,
            ...(item.provenance ? { provenance: item.provenance } : {}),
            ...(item.tags?.length ? { tags: item.tags } : {}),
            ...(item.source ? { source: item.source } : {}),
            ...(item.sourceCommit ? { sourceCommit: item.sourceCommit } : {}),
            ...(item.affectedPaths?.length ? { affectedPaths: item.affectedPaths } : {}),
            ...(item.conflictKey ? { conflictKey: item.conflictKey } : {}),
            ...(item.supersededById ? { supersededById: item.supersededById } : {}),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          };
          const evidenceWithStale = async (itemId: string) => Promise.all(
            (await listEvidenceForItem(itemId)).map(async evidence => ({
              ...evidence,
              stale: projectRoot ? await isEvidenceStale(evidence, projectRoot) : false,
            })),
          );
          const payload = includeEvidence
            ? [{ ...full, evidence: boundedEvidence(await evidenceWithStale(item.id)) }]
            : [full];
          // An array of one, not a bare object: every existing caller parses the first block as
          // an array, and a fetch that changed the shape would break each of them.
          return { content: [{ type: 'text', text: compactMcpJson(payload) }] };
        }
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

        // Deliberately not awaited: the answer below comes from the replica already on disk,
        // and this only decides what the next query sees. Awaiting a round trip here would put
        // it back on a path queried several times a turn.
        if (projectRoot && config) maybeAutoSync({ projectRoot, config });

        let federated: FederatedResult | null = null;
        let resolvedItems: Array<KnowledgeItem & { repo?: string; explanation?: unknown }> = items as any;
        if (active) {
          // Federation selects from every repo including this one and scores the union in a
          // single pass, so the local result above is not passed in. Handing it pre-selected
          // local items would score them by different rules than the peers' -- and recency,
          // which normalizes against the candidate set it is given, would make every repo's
          // newest item equally recent.
          federated = await queryFederated({
            workspace: active,
            query: query ?? '',
            category: category as KnowledgeCategory,
            status: status as KnowledgeStatus,
            tags,
            limit: limit ?? 3,
            repos,
            scope,
            vector,
          });
          // Everything downstream of the payload -- the kin block, the abstention verdict, the
          // demand ledger -- asks questions about the result set rather than about its shape, so
          // they keep reading one flat list.
          resolvedItems = flattenGroups(federated);
        }
        const skippedRepos: FederatedResult['skipped'] = federated?.skipped ?? [];

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
        // Inside a group the key already names the repo, so the per-row field is noise. It stays
        // on a flat row, which has no key to say it.
        const compactInGroup = (item: any) => {
          const { repo: _repo, ...rest } = compact(item);
          return rest;
        };
        const rowsOf = async (rows: typeof resolvedItems, shaper: (item: any) => Record<string, unknown>) => (
          includeEvidence
            ? await Promise.all(rows.map(async item => (isForeign(item)
              ? shaper(item)
              : { ...shaper(item), evidence: boundedEvidence(await withStaleStatus(item.id)) })))
            : rows.map(shaper)
        );
        // `compactInGroup` only where there is a key to carry the name. A flat response is a bare
        // array whatever produced it, so its rows keep `repo` exactly as before.
        const shaper = federated?.shape === 'grouped' ? compactInGroup : compact;
        const payloadGroups = federated
          ? await Promise.all(federated.groups.map(async group => ({
            repo: group.repo,
            rows: await rowsOf(group.items, shaper),
          })))
          : [{ repo: '', rows: await rowsOf(resolvedItems, compact) }];
        // The notice is a separate block so the first block stays parseable on its own: a bare
        // JSON array for every existing caller, an object keyed by repo when a linked repo
        // contributed a row.
        const { text: payloadText, shortened, omitted: omittedResults } =
          boundQueryPayload(payloadGroups as Array<{ repo: string; rows: Record<string, unknown>[] }>, federated?.shape ?? 'flat');
        const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: payloadText }];
        if (shortened > 0 || omittedResults > 0) {
          const what = [
            shortened > 0 ? `the content of ${shortened} lower-ranked result(s) was cut to an excerpt` : '',
            omittedResults > 0 ? `${omittedResults} lower-ranked result(s) were dropped entirely` : '',
          ].filter(Boolean).join(', and ');
          blocks.push({
            type: 'text',
            text: `RESPONSE BOUNDED: ${what}, to keep this response under ${MAX_RESPONSE_CHARS} characters. `
              + 'These were the weakest matches, not a scoping failure. Read any result whole with '
              + '`knowl_query` and its `id`; narrow the query or lower `limit` to see more of them at once.',
          });
        }
        // This repo returned nothing and a linked one did. The shape already says so; this says
        // the one thing a shape cannot, which is that a foreign fact describes a foreign repo.
        //
        // Only on the default path. A caller who asked for `scope: 'workspace'` or named `repos`
        // requested exactly this and does not need to be told what they asked for.
        if (federated && !scope && !repos?.length
          && federated.groups[0]?.items.length === 0 && federated.groups.length > 1) {
          const answering = federated.groups.slice(1).map(group => group.repo);
          blocks.push({
            type: 'text',
            text: `LOCAL MISS: ${federated.groups[0].repo} (this repo) returned nothing for this query. `
              + `Everything above is from ${answering.join(', ')} and describes ${answering.length > 1 ? 'those repos' : 'that repo'}, not this one. `
              + 'Verify against this repo before applying it, and treat this as a miss if it does not transfer.',
          });
        }
        // A linked repo matched and won no slot. Names and counts, never content: the knowledge
        // stays findable without the response being able to substitute it for this repo's own.
        if (federated?.unshown.length) {
          const described = federated.unshown.map(entry => `${entry.repo} (${entry.matches})`).join(', ');
          const names = federated.unshown.map(entry => `"${entry.repo}"`).join(', ');
          blocks.push({
            type: 'text',
            text: `WORKSPACE: linked repos also hold matches not shown here: ${described}. `
              + `Re-query with repos: [${names}] to read them.`,
          });
        }
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
        // Lineage, once per response rather than once per row. `kin` marks repos that were the
        // same codebase and have diverged, which is the case where a foreign result is most
        // likely to look applicable and least likely to be: same concept names, different
        // meanings. The write path has warned about this since kin existed; the read path is
        // where the wrong convention actually gets applied.
        const kinRepos = [...new Set(resolvedItems
          .filter(item => (item as { kinDivergent?: boolean }).kinDivergent)
          .map(item => item.repo!))];
        if (kinRepos.length) {
          blocks.push({
            type: 'text',
            text: `SHARED LINEAGE: ${kinRepos.join(', ')} ${kinRepos.length > 1 ? 'share' : 'shares'} this repo's lineage with diverged conventions. `
              + 'Same-named concepts can mean different things here — verify against this repo before applying.',
          });
        }
        // The floor's verdict, in words. It used to be delivered by returning nothing at all,
        // which the caller could not tell apart from an empty store or a missing index -- and
        // which deleted the answer on every query where the verdict was wrong. The rows now
        // stand and the verdict rides beside them, so a caller can act on it or overrule it.
        if (resolvedItems.some(item => (item.explanation as { abstained?: boolean } | undefined)?.abstained)) {
          // Naming the next move only where it exists. An abstention is the one moment the
          // agent has decided memory is empty, and transcript search is the thing that can
          // still answer -- but it is off by default, so an unconditional mention would send
          // callers to a tool their build does not expose.
          const transcriptRoute = config && isTranscriptSearchEnabled(config)
            ? ' Before you do, try `knowl_transcript_search` with the same words: past sessions are indexed separately from knowledge items and are not searched by this tool.'
            : '';
          blocks.push({
            type: 'text',
            text: 'NO CONFIDENT MATCH: every result above scored below the relevance floor, so this store probably does not hold the answer. They are returned rather than withheld because the floor is a fixed threshold on a corpus-dependent scale and is wrong often enough to matter — read `score` and judge. If none of them answers the question, treat this as a miss and go to the files.'
              + transcriptRoute,
          });
        }
        // Last of the notices, because it is the only one that asks the agent to do something
        // rather than to interpret what it just got.
        //
        // `teamUpdateNotice` reads the replica through `withDbPath`, never `initDbPath`, so the
        // global context this server opened once at startup survives the call. A helper that
        // closed it would break the NEXT tool call rather than this one.
        if (active?.cloud && projectRoot) {
          const update = await teamUpdateNotice({
            workspaceId: active.cloud.workspaceId,
            configRoot: projectRoot,
            seenSeq: seenTeamSeq,
          });
          if (update) {
            seenTeamSeq = update.seq;
            blocks.push({ type: 'text', text: update.notice });
          }
        }

        // No provenance block here, deliberately: the block count above is a contract where an
        // extra block reports an anomaly, and the JSON payload already contains bodies
        // structurally. The declaration lives in the `knowl_query` description instead.

        // What one repo actually asks the others for, recorded after the answer is built.
        //
        // Every workspace query, not only the weak ones. The obvious design logs "queries the
        // workspace could not answer" and reads abstention as that signal -- but abstention is
        // corpus-dependent and, measured on the real 483-item store, off-topic queries top out
        // at ~0.29 against a 0.16 floor. A predicate that fires almost never would produce an
        // empty ledger and the false conclusion that there is no cross-repo demand. So the
        // score is recorded on every row and the threshold is chosen from the distribution
        // afterwards, by `knowl workspace demand`.
        //
        // `void`, never awaited: this runs after the response is assembled, so the only thing a
        // slow or failing ledger could still affect is whether the caller gets their answer.
        if (active && query) {
          const top = resolvedItems[0];
          // The raw cosine, not `finalScore`, and only where a semantic half actually ran.
          //
          // That column exists so a "weak query" threshold can be picked off the distribution
          // later, which needs a number meaning the same thing on every row. `finalScore` is
          // not one, for two independent reasons. Since 4152c34 the semantic half is min-max
          // scaled across the candidate page, so the best row's semantic term is ~1.0 whether
          // its cosine was 0.9 or 0.2 -- the rescale exists to amplify small gaps, which is
          // exactly what destroys cross-query comparability. And with vector off, the lexical
          // half is normalised against each corpus's own best hit, so the top row scores ~1.0
          // whatever it is. A column mixing those scales still has a distribution; no threshold
          // read off it would mean anything. `scoreOf` already refuses to publish that number
          // to the caller for the same reason -- this must not record what that gate rejects.
          //
          // Cosine is the quantity the relevance floor is measured against, so a threshold
          // chosen from this column is comparable to `MODEL_RELEVANCE_FLOORS`. It is the best
          // cosine on the RETURNED page, not over the whole candidate set -- the ranker does
          // not surface the latter -- so it is a lower bound on the `bestCosine` the floor
          // actually judged. `abstained` in `detail` carries that verdict exactly, so the two
          // together say more than either alone.
          //
          // Uncalibrated rows are excluded rather than counted as 0, and no row left means no
          // number at all. An unembedded row's semantic half is 0 by ABSENCE, not by verdict --
          // vector never saw it -- and a store with no embeddings yet would otherwise fill this
          // column with zeroes indistinguishable from real misses, which is the same mistake as
          // recording the fused score, made at the other end of the range. Same predicate
          // `scoreOf` withholds a published number on, for the same reason.
          const judged = scored
            ? resolvedItems.filter(item =>
              !(item.explanation as { uncalibrated?: string } | undefined)?.uncalibrated)
            : [];
          const bestCosine = judged.length
            ? judged.reduce((best, item) => {
              const semantic = (item.explanation as { contributions?: { semantic?: number } } | undefined)
                ?.contributions?.semantic;
              return typeof semantic === 'number' && semantic > best ? semantic : best;
            }, 0)
            : null;
          void recordDemandEventBestEffort(active.name, {
            queryingRepo: active.repo,
            kind: 'federated_query',
            query,
            topScore: bestCosine,
            servedRepo: top?.repo ?? null,
            servedItemId: top?.id ?? null,
            detail: {
              results: resolvedItems.length,
              // Per-repo contribution, so a repo that is asked constantly and answers nothing
              // is distinguishable from one that is never reached at all.
              contributed: resolvedItems.reduce<Record<string, number>>((counts, item) => {
                const repoName = item.repo ?? active.repo;
                counts[repoName] = (counts[repoName] ?? 0) + 1;
                return counts;
              }, {}),
              ...(skippedRepos.length ? { skipped: skippedRepos.map(skip => skip.repo) } : {}),
              ...(resolvedItems.some(item => (item.explanation as { abstained?: boolean } | undefined)?.abstained)
                ? { abstained: true }
                : {}),
              // Whether this repo put anything on the page at all -- the quantity grouping
              // actually changes, and nothing measured it before. Read from the local group's
              // occupancy rather than from a score, for the same reason the grouping decision
              // is: no threshold can separate a weak local answer from no local answer, but
              // "did it contribute a row" is a count and counts do not need calibrating.
              //
              // Only where the local repo was searched. Under `repos: ['b']` it was not, and
              // recording `false` would say this repo failed to answer a question it was never
              // asked -- the same absent-versus-unsearched conflation `skipped` exists to avoid.
              ...(federated?.groups.some(group => group.repo === active.repo)
                ? { localAnswered: (federated.groups.find(group => group.repo === active.repo)?.items.length ?? 0) > 0 }
                : {}),
              // A narrowed read, marked so it is not counted as an open one. The event is
              // recorded either way -- the guard above is `active && query`, which a local scope
              // still satisfies -- so the ledger's volume is unaffected and only its
              // interpretation needed the flag.
              ...(scope ? { scope } : {}),
              ...(repos?.length ? { repos } : {}),
            },
          }, config);
        }
        return { content: blocks };
      }

      else if (name === 'knowl_timeline') {
        const { itemId } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
        const { listAssertions } = await import('../store/assertions.js');
        // The bare array stays the first block -- callers and a test parse it as one. But a
        // short complete history looked identical to the opening five of a long one, so a
        // second block names the overflow, the way gc_preview reports its candidateCount.
        const assertions = await listAssertions(itemId);
        const timelineBlocks: { type: 'text'; text: string }[] = [
          { type: 'text', text: compactMcpJson(assertions.slice(0, 5).map(compactAssertionResponse)) },
        ];
        if (assertions.length > 5) {
          timelineBlocks.push({ type: 'text', text: `TIMELINE TRUNCATED: showing the 5 most recent of ${assertions.length} assertions.` });
        }
        return { content: timelineBlocks };
      }

      else if (name === 'knowl_conflicts') {
        const { listActiveConflictKeys } = await import('../store/conflicts.js');
        const items = await listActiveConflictKeys();
        const conflictBlocks: { type: 'text'; text: string }[] = [
          { type: 'text', text: compactMcpJson(items.slice(0, 3).map(item => ({ id: item.id, title: item.title, conflictKey: item.conflictKey, conflictScope: item.conflictScope, freshness: item.freshness }))) },
        ];
        if (items.length > 3) {
          conflictBlocks.push({ type: 'text', text: `CONFLICTS TRUNCATED: showing 3 of ${items.length} conflicting items.` });
        }
        return { content: conflictBlocks };
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
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
        const evidence = await Promise.all((await listEvidenceForItem(itemId)).map(async item => ({
          ...item,
          stale: projectRoot ? await isEvidenceStale(item, projectRoot) : false,
        })));
        return { content: [{ type: 'text', text: compactMcpJson(boundedEvidence(evidence)) }] };
      }

      else if (name === 'knowl_feedback') {
        const { itemId, used, useful, causedCorrection } = args as any;
        const owner = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try { await assertOwnedItem(itemId, owner); } catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
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
        catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
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

        // Change impact deliberately does NOT gate here, and the reason is worth keeping: it
        // was built to and could not reach. Reads are captured only by the hook path, under the
        // *host* session (`host-lifecycle.ts`, the one non-test caller of `recordRead`);
        // `startWorkLoop` mints its own session (`work-loop.ts:114`) and tags the task with
        // that instead, and `openFindingsForSession` joins `work_read_sets.session_id` -- so a
        // gate resolved through the task's tag queries an id under which no read exists. The
        // loose repair (any recent session) is the one thing this must not do: it would block
        // one agent's finish over another agent's stale read. The write gate
        // (`session/write-gate.ts`) is the chokepoint instead, and it needs no such join because
        // it runs inside the session that holds the read. Plan §15.
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
        const { handoff, replacedPrevious } = await recordDeliberateHandoff(projectId!, {
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
            // One baton per project. Parking again overwrites, and the previous baton's goal, next
            // action and blocker are gone -- the schema comment calls that "the destruction of
            // the real one", so the response no longer stays silent about it.
            text: `${replacedPrevious ? 'Replaced the previous unconsumed handoff for this project — its goal, next action and blocker are gone. ' : ''}Parked. The next session in this project will receive this once.\n\n${formatPendingHandoffContext(handoff)}`,
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
              // The same free-text goal `formatResumeBrief` contains twelve lines up. Containing
              // it there and not here would mean a poisoned goal is inert when it is read in full
              // and live when it is merely listed, which is the wrong way round.
              ...points.map(point => `- ${point.key}: ${inlineUntrusted(point.goal)} (${point.createdAt})`),
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

      // Re-checks its own gate rather than trusting the listing, for the reason above: a
      // cached tool list keeps this callable after the flag goes off.
      else if (name === 'knowl_impact') {
        if (!isImpactEnabled(config ?? undefined)) {
          return { content: [{ type: 'text', text: IMPACT_DISABLED_MESSAGE }] };
        }

        const { scope, tier, resolve } = args as any;
        const tiers: ImpactTier[] = tier ? [tier as ImpactTier] : DEFAULT_IMPACT_TIERS;

        let adjudicated: Record<string, unknown> | undefined;
        if (resolve) {
          // Every tier and the widest scope, because the id being adjudicated came from a gate
          // message or an earlier listing that may have used either -- refusing to resolve a
          // `possible` finding because this call asked for `certain` would make the adjudication
          // path narrower than the reporting path, and the resolutions are the measurement.
          const before = await openImpactFindings('all', ['certain', 'likely', 'possible']);
          const wasOpen = before.some(entry => entry.finding.id === resolve.id);
          await resolveFinding(String(resolve.id), resolve.resolution);
          adjudicated = {
            id: resolve.id,
            resolution: resolve.resolution,
            wasOpen,
            // Said plainly rather than reported as success: an agent told "resolved" after a
            // mistyped id would call knowl_task_finish and meet the same gate with no idea why.
            ...(wasOpen ? {} : { note: 'That id was not among the open findings visible here -- already resolved, or not a finding id. Nothing was changed if it does not exist.' }),
          };
        }

        const open = await openImpactFindings(scope === 'all' ? 'all' : 'mine', tiers);
        const listed = open.slice(0, MAX_IMPACT_FINDINGS).map(({ sessionId, finding }) => {
          const evidence = impactEvidence(finding);
          return {
            id: finding.id,
            tier: finding.tier,
            session: sessionId,
            locator: finding.causeLocator,
            detectedAt: finding.detectedAt,
            // The evidence chain as detection wrote it, with only the free text bounded: an
            // agent reconciling a change needs the before and after, not a count of them.
            evidence: evidence && {
              ...evidence,
              observedSignature: impactText(evidence.observedSignature),
              currentSignature: impactText(evidence.currentSignature),
            },
          };
        });

        return {
          content: [{
            type: 'text',
            text: compactMcpJson({
              scope: scope === 'all' ? 'all' : 'mine',
              tiers,
              open: open.length,
              findings: listed,
              ...(open.length > listed.length ? { omitted: open.length - listed.length } : {}),
              ...(adjudicated ? { resolved: adjudicated } : {}),
            }),
          }],
        };
      }

      // A name the server does not serve is a malformed request, which the spec groups with
      // unknown methods as a protocol error (-32602). Thrown as a plain Error it fell into the
      // catch below and came back as `isError` on a SUCCESSFUL response. The ToolInputError
      // branch beneath is the deliberate opposite case and stays: SEP-1303 asks for argument
      // validation to surface as a tool execution error so the model can self-correct.
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      if (error instanceof ToolInputError) {
        // Refused, not executed. Named separately so the caller can tell "I sent this wrong"
        // from "the store failed", and so the message is the argument rather than a statement.
        return { isError: true, content: [{ type: 'text', text: `Invalid arguments for "${name}": ${error.message}` }] };
      }
      let message: string;
      if (error instanceof KnowledgeValidationError) {
        message = `${error.code}: ${error.message}`;
      } else {
        message = sanitizeToolErrorMessage(String(error?.message ?? error));
        // Drizzle's message BEGINS with "Failed query:", so the sanitizer's keep-the-prefix
        // rule kept nothing and a failed write carried zero diagnosis -- while the actual
        // SQLite verdict sat unread in `error.cause`. Sanitized through the same gate, so
        // statement text and bound parameters still never leave the process; what does is
        // the one line saying WHY it failed.
        const cause = (error as { cause?: { message?: unknown } })?.cause?.message;
        if (cause) {
          const causeText = sanitizeToolErrorMessage(String(cause));
          if (causeText && !message.includes(causeText)) message += ` Cause: ${causeText}`;
        }
      }
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
