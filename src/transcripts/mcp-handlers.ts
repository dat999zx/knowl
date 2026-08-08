import type { ProjectConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { fenceUntrusted } from '../core/untrusted.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { recordDemandEventBestEffort } from '../workspace/demand-ledger.js';
import { catchUpTranscripts } from './catch-up.js';
import { isTranscriptSearchEnabled, isTranscriptSharingEnabled } from './config.js';
import { openTranscriptDb, TranscriptIndexMissingError } from './database.js';
import { searchTranscriptsFederated } from './federate.js';
import { formatLocator, parseLocator } from './locator.js';
import { readWithContext } from './read.js';
import { resolveSessionScope } from './search.js';
import { listSessionDirectory } from './session-directory.js';

export const DISABLED_MESSAGE =
  'Transcript search is not enabled for this repository. Enable search.transcripts.enabled with `knowl config`, then run `knowl reindex --transcripts`.';

/**
 * Bounds on agent-supplied input.
 *
 * An MCP argument is whatever the model emitted; nothing upstream validates it. Unbounded
 * `limit` scans and returns arbitrarily much, unbounded `context` allocates a line range of any
 * size, and a negative `context` silently produces an empty read rather than an error.
 */
export const MAX_LIMIT = 25;
export const MAX_CONTEXT = 10;
export const MAX_QUERY_CHARS = 500;
/** Cap on the rendered reply, so one search cannot flood the agent's context window. */
export const MAX_RESPONSE_CHARS = 12_000;

/** Coerce to a finite integer inside [min, max], falling back for NaN/Infinity/undefined. */
export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated at ${max} characters -- narrow the query or lower limit]`;
}

/** The search-time top-up budget. Small enough that a search still feels immediate. */
const SEARCH_TOPUP_MS = 1_000;

/**
 * The config as it is on disk *now*, not as it was when the server started.
 *
 * `createMcpServer` captures `config` once and `registerTools` closes over that snapshot, so a
 * long-lived server answers from startup state forever. For most tools that is a staleness
 * annoyance; for this one it defeats the feature's central promise. Someone who runs
 * `knowl config set search.transcripts.enabled false` -- which also deletes the index -- would
 * still be served by an already-running session, and a local read would recreate the database
 * they just deleted.
 *
 * Re-reading costs one small file read per call, against a tool that then opens a database and
 * searches it. Falls back to the captured config so an unreadable config file degrades to the
 * old behaviour instead of breaking the tool.
 */
async function currentConfig(
  projectRoot: string,
  fallback: ProjectConfig,
): Promise<ProjectConfig> {
  return loadConfig(projectRoot).catch(() => fallback);
}

/**
 * The live config, or null if the feature is off according to *either* source.
 *
 * Fail-closed on both deliberately. The captured config must still be able to disable -- that is
 * the server's own view, and a caller that constructed one with the feature off means it. And
 * the on-disk config must be able to disable, or turning the feature off would not take effect
 * until every running server restarted. Requiring both to agree is the only reading where "off"
 * always means off.
 *
 * The returned config is the fresh one, so everything downstream (vector settings, sharing)
 * reads current values rather than startup values.
 */
async function enabledConfig(
  projectRoot: string,
  captured: ProjectConfig,
): Promise<ProjectConfig | null> {
  if (!isTranscriptSearchEnabled(captured)) return null;
  const live = await currentConfig(projectRoot, captured);
  return isTranscriptSearchEnabled(live) ? live : null;
}

/** The embedder, or null when vectors are off or the model is unavailable. Never throws. */
async function optionalEmbedder(config: ProjectConfig, projectRoot: string) {
  if (!isVectorSearchEnabled(config)) return null;
  try {
    return await createLocalEmbeddingProvider(config, projectRoot);
  } catch {
    return null;
  }
}

export async function handleTranscriptSearch(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  query: string;
  sessionId?: string;
  repos?: string[];
  limit?: number;
}): Promise<string> {
  const { projectRoot } = input;
  if (!input.config || !projectRoot) return DISABLED_MESSAGE;

  // Re-read rather than trusting the startup snapshot alone: disabling the feature must take
  // effect for an already-running server, not only for the next one.
  const config = await enabledConfig(projectRoot, input.config);
  if (!config) return DISABLED_MESSAGE;

  const query = String(input.query ?? '').slice(0, MAX_QUERY_CHARS).trim();
  if (!query) return 'Empty query. Give knowl_transcript_search a few words to look for.';

  const limit = clampInteger(input.limit, 5, 1, MAX_LIMIT);

  // The third indexing trigger from the design: a short top-up so a search reflects the turn
  // that just happened. Best-effort and bounded -- a stale index is a worse answer, but a slow
  // search is a worse tool. `closeWhenDone: false` keeps the connections this search is about
  // to use.
  await catchUpTranscripts(projectRoot, { budgetMs: SEARCH_TOPUP_MS, closeWhenDone: false })
    .catch(() => null);

  const embedder = await optionalEmbedder(config, projectRoot);
  const workspace = await resolveWorkspace(projectRoot, config).catch(() => null);

  const { hits, skipped, coverage, ambiguous, localRepo } = await searchTranscriptsFederated({
    projectRoot, workspace, query, limit,
    sessionId: input.sessionId, repos: input.repos,
    embedder: embedder ?? undefined,
  });

  // Answered the way the reader answers it. A prefix naming several sessions is an unfinished
  // question, and searching all of them is not the narrower search that was asked for.
  if (ambiguous.length > 0 && hits.length === 0) {
    return ambiguous
      .map(entry =>
        `Session prefix "${input.sessionId}" is ambiguous in [${entry.repo}]: `
        + `${entry.candidates.slice(0, 10).join(', ')}. Use a longer prefix.`)
      .join('\n');
  }

  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(`No transcript matches for "${query}".`);
  } else {
    for (const hit of hits) {
      const parent = hit.parentSessionId ? ` (subagent of ${hit.parentSessionId})` : '';
      // The local repo is omitted from the locator. Including it would produce
      // `transcript://local/...`, which the reader resolves against the workspace peer list
      // and rejects as an unknown repo -- a search result that cannot be read.
      const locator = formatLocator({
        repo: hit.repo === localRepo ? null : hit.repo,
        sessionId: hit.sessionId,
        line: hit.line,
      });
      lines.push(`${locator}  [${hit.role}]${parent}`);
      // A transcript message is the least reviewed text knowl holds: it is whatever a past
      // session said, including tool output, file contents and fetched pages, replayed verbatim.
      // Verbatim is the point, so this fences rather than collapses -- the body keeps its shape
      // inside a container it cannot close.
      //
      // The container also has to hold because of what comes AFTER these hits. The coverage
      // lines and the `knowl_store` reminder below are knowl speaking in its own voice, and an
      // uncontained body could sit above them emitting `## ...` structure of its own. The
      // fallback string is knowl's, not a hit's, so it stays outside.
      lines.push(hit.text === undefined || hit.text === null
        ? '(message body unavailable -- the transcript file was removed)'
        : fenceUntrusted(hit.text));
      lines.push('');
    }
  }

  // Required, not decorative. "BM25 + semantic" over 8% of an archive is a different claim
  // from the same words over all of it, and only one justifies trusting a near-miss.
  //
  // Both halves are reported, because they fail independently and only one of them used to be
  // visible: `embedded/indexed` is computed over the rows that exist, so an index still missing
  // whole transcripts reports full coverage of the part it has.
  for (const entry of coverage) {
    const semantic = entry.embedded === 0 && !embedder
      ? ' (semantic off: search.vector.enabled is false)'
      : '';
    const indexing = entry.indexComplete
      ? ''
      : ' INDEXING INCOMPLETE - transcripts are still missing from this index; run `knowl reindex --transcripts`.';
    lines.push(`Coverage [${entry.repo}]: ${entry.embedded}/${entry.indexed} messages embedded${semantic}.${indexing}`);
  }
  for (const entry of skipped) {
    lines.push(`Skipped [${entry.repo}]: ${entry.reason}.`);
  }

  lines.push('If you used any of this, store it with knowl_store so the next session does not have to dig for it again.');

  // The other half of the demand signal, and the more interesting one.
  //
  // A knowledge query that misses and a transcript search that then hits is the exact shape of
  // "this repo holds the answer and has not shared it": the fact is here, written down, and
  // only reachable as prose in a past session. Recorded per serving repo rather than per hit,
  // so one search returning six messages from one repo is one piece of evidence about that
  // repo, not six.
  //
  // Foreign repos only. A local transcript hit says nothing about scoping -- the caller could
  // already reach it.
  if (workspace) {
    const foreign = new Map<string, number>();
    for (const hit of hits) {
      if (!hit.repo || hit.repo === localRepo) continue;
      foreign.set(hit.repo, (foreign.get(hit.repo) ?? 0) + 1);
    }
    for (const [repoName, count] of foreign) {
      void recordDemandEventBestEffort(workspace.name, {
        queryingRepo: workspace.repo,
        kind: 'transcript_hit',
        query,
        servedRepo: repoName,
        detail: { hits: count },
      }, config);
    }
  }

  return truncate(lines.join('\n'), MAX_RESPONSE_CHARS);
}

/** Default and ceiling for how many sessions one listing renders. */
const SESSION_LIST_DEFAULT = 30;
const SESSION_LIST_MAX = 200;

/**
 * Browse the project's sessions as an inventory.
 *
 * Gated exactly like the other two: the tool is not registered when the feature is off, and this
 * re-checks per call so disabling takes effect for an already-running server.
 */
export async function handleSessionList(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  projectId: string | null;
  query?: string;
  limit?: number;
}): Promise<string> {
  const { projectRoot, projectId } = input;
  if (!input.config || !projectRoot || !projectId) return DISABLED_MESSAGE;

  const config = await enabledConfig(projectRoot, input.config);
  if (!config) return DISABLED_MESSAGE;

  const limit = clampInteger(input.limit, SESSION_LIST_DEFAULT, 1, SESSION_LIST_MAX);
  const { sessions, indexComplete } = await listSessionDirectory({
    projectId,
    projectRoot,
    query: input.query ? String(input.query).slice(0, MAX_QUERY_CHARS) : undefined,
    limit,
  });

  if (sessions.length === 0) {
    return indexComplete
      ? 'No sessions match. Run `knowl reindex --transcripts` if the index looks stale.'
      : 'No sessions yet. INDEX STILL WARMING - run again once it has caught up.';
  }

  const lines = sessions.map(session => {
    const name = session.name ?? '(unnamed)';
    const parent = session.parentSessionId ? ` (subagent of ${session.parentSessionId})` : '';
    const parts = [`${session.sessionId}  ${name}  [${session.status}]${parent}`];
    if (session.card) parts.push(`  card: ${session.card}`);
    if (session.opening) parts.push(`  opened: ${session.opening}`);
    if (session.promoted.length) parts.push(`  promoted: ${session.promoted.slice(0, 5).join('; ')}`);
    parts.push(`  ${session.messages} messages, last active ${session.lastActiveAt ?? 'unknown'}`);
    return parts.join('\n');
  });

  // A caller told nothing reads "no matches" as proof of absence. A partial index has to say so.
  if (!indexComplete) {
    lines.push('INDEX STILL WARMING - names and openings fill in as it catches up; run again for fuller coverage.');
  }
  lines.push('Read into a session with knowl_transcript_search using its sessionId.');

  return truncate(lines.join('\n\n'), MAX_RESPONSE_CHARS);
}

export async function handleTranscriptRead(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  locator: string;
  context?: number;
}): Promise<string> {
  const { projectRoot } = input;
  if (!input.config || !projectRoot) return DISABLED_MESSAGE;

  const config = await enabledConfig(projectRoot, input.config);
  if (!config) return DISABLED_MESSAGE;

  const parsed = parseLocator(input.locator);
  if (!parsed) {
    return `Malformed locator "${input.locator}". Expected transcript://<repo>/<session>#L<line>, exactly as knowl_transcript_search returned it.`;
  }

  const context = clampInteger(input.context, 2, 0, MAX_CONTEXT);
  const workspace = await resolveWorkspace(projectRoot, config).catch(() => null);
  const localRepo = workspace?.repo ?? 'local';

  // Resolve the owning repo's root before resolving the session's file. A locator from another
  // repo must not be looked up against this one's transcripts.
  let root = projectRoot;
  const isPeer = parsed.repo !== null && parsed.repo !== localRepo;

  if (isPeer) {
    const peer = workspace?.peers.find(candidate => candidate.name === parsed.repo);
    if (!peer) return `Unknown repo "${parsed.repo}" in locator. It is not a linked workspace repo.`;
    if (!peer.root) return `Cannot locate repo "${parsed.repo}" on disk.`;

    // Re-check sharing here, not only at search time. A locator is a durable string: it can be
    // cached from an earlier turn, pasted, or fabricated. Trusting "it is a linked repo" would
    // mean revoking `share` stops new searches while old locators keep working, which is not
    // revocation at all.
    const peerConfig = await loadConfig(peer.root).catch(() => null);
    if (!peerConfig || !isTranscriptSharingEnabled(peerConfig)) {
      return `Repo "${parsed.repo}" is not sharing its transcripts. Nothing to read.`;
    }
    root = peer.root;
  }

  // Opened read-only for a peer, and -- for the local repo too -- only if the index already
  // exists. A writable open creates the file, so reading after `knowl config set
  // search.transcripts.enabled false` deleted it would recreate the database the user just
  // removed, from a tool that is supposed to only read.
  const dbPath = resolveStorage(root).transcripts;
  let client;
  try {
    client = await openTranscriptDb(dbPath, { readOnly: true });
  } catch (error) {
    if (error instanceof TranscriptIndexMissingError) {
      return isPeer
        ? `Repo "${parsed.repo}" has no transcript index.`
        : 'No transcript index yet. Run `knowl reindex --transcripts` to build one.';
    }
    throw error;
  }

  // The same resolver the search uses. Two implementations of "which session is this" is what
  // let one tool refuse an ambiguous prefix while the other quietly searched everything it
  // matched -- and `%` and `_` are LIKE wildcards in an agent-supplied string, so the escaping
  // has to be the same in both places too.
  const scope = await resolveSessionScope(client, parsed.sessionId);
  if (scope.kind === 'none') return `No indexed session matches "${parsed.sessionId}".`;
  if (scope.kind === 'ambiguous') {
    return `Session prefix "${parsed.sessionId}" is ambiguous: ${scope.candidates.slice(0, 10).join(', ')}. Use a longer prefix.`;
  }
  if (scope.kind === 'all') return `No indexed session matches "${parsed.sessionId}".`;

  const excerpts = await readWithContext(scope.paths[0], parsed.line, context);
  if (excerpts.length === 0) {
    return `Nothing readable at ${input.locator}. The transcript file has probably been deleted; its rows are dropped on the next index pass.`;
  }

  // Same containment as the search hits, and for the same reason -- this is the other half of
  // the same round trip, so containing one and not the other would mean a body is inert when it
  // is found and live when it is opened.
  //
  // The marker moves onto its own line because a fence has to start at one. That also retires an
  // accident in the old shape: the focused excerpt was prefixed `> `, which is a live blockquote
  // marker, so the text an agent was told to read most carefully was the one wrapped in markdown
  // structure knowl did not intend.
  return truncate(
    excerpts
      .map(excerpt => `${excerpt.line === parsed.line ? '>' : ' '} [${excerpt.role}]\n${fenceUntrusted(excerpt.text)}`)
      .join('\n\n'),
    MAX_RESPONSE_CHARS,
  );
}
