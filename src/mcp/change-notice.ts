import { renderChangeCard } from '../session/change-card.js';
import {
  ChangeSummary,
  loadForeignChanges,
  loadForeignPeerChanges,
  mergeChangeSummaries,
  readCommitHead,
  readPeerCommitHeads,
} from '../store/change-watermark.js';
import { listLiveHostBindings } from '../session/host-session-bindings.js';
import { recordMcpCallCommits } from '../store/mcp-call-commits.js';
import { hostProfile, isHookHost } from '../session/hosts/index.js';
import { resolveWorkspace, type ActiveWorkspace } from '../workspace/resolve.js';
import { captureNudgeMode } from '../store/capture-config.js';
import { isDurableWriteTool, renderSilenceNudge } from '../store/capture-outcome.js';
import type { ProjectConfig } from '../core/types.js';

/**
 * Change notification for MCP clients, independent of hooks.
 *
 * The hook path can only reach hosts that expose a mid-turn channel. `claude-desktop` and
 * `generic` expose none, so their change cards were computed and dropped; a client with no
 * hooks installed at all never got one either. This path needs nothing from the host: the
 * card rides back on the tool result, which every MCP client already renders.
 *
 * State is per process, deliberately. A stdio MCP server is spawned per connected host
 * session, so process lifetime is exactly the scope a watermark wants -- which also means
 * this needs no session id, and sidesteps the identity problem that forces the hook path
 * to attribute writes by matching titles.
 */
type Watermark = { local: number; peers: Record<string, number> };
type RootState = {
  seen: Watermark | null;
  workspace?: Promise<ActiveWorkspace | null>;
  /** Knowl reads this process has served, and durable writes it has accepted. See `consumeCaptureNudge`. */
  reads: number;
  durableWrites: number;
  nudged: boolean;
};

/**
 * Keyed by project root rather than held in a bare module variable.
 *
 * A served process only ever has one root, so this map has one entry in production. It is
 * keyed anyway because a function that accepts a root and then answers for a different one
 * is wrong regardless of whether today's callers can trigger it -- and the in-process test
 * harness, which drives several roots through one module instance, can.
 */
const byRoot = new Map<string, RootState>();

const stateFor = (projectRoot: string): RootState => {
  const existing = byRoot.get(projectRoot);
  if (existing) return existing;
  const created: RootState = { seen: null, reads: 0, durableWrites: 0, nudged: false };
  byRoot.set(projectRoot, created);
  return created;
};

/**
 * Tools that can commit knowledge.
 *
 * Used to decide which end of the call to leave the watermark at, not to gate anything.
 * A read-only tool leaves it at the head observed *before* the call, so a foreign write
 * that lands while the call runs is reported next time rather than swallowed. A write tool
 * leaves it at the head after, which is what keeps a caller's own writes from being read
 * back to it as news.
 */
const WRITE_TOOLS = new Set([
  'knowl_store', 'knowl_ingest', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update',
  'knowl_synthesize', 'knowl_session_finish', 'knowl_task_start', 'knowl_task_checkpoint',
  'knowl_task_finish', 'knowl_gc_apply', 'knowl_feedback', 'knowl_skill_create', 'knowl_skill_run',
  // Parking a baton commits a knowledge item, so leaving the watermark behind read the
  // session its own handoff back as somebody else's news on the very next call. `knowl_park`
  // writes to the resume store rather than the commit log and moves nothing here, but it is
  // listed for the same reason: what belongs in this set is "tools that write", not "tools
  // that happen to write to this table today".
  'knowl_handoff', 'knowl_park',
]);

/**
 * How recently a lifecycle binding must have been touched to count as delivering.
 *
 * Generous on purpose: the cost of guessing "live" when the session is gone is one missed
 * card, and the cost of guessing "dead" when it is running is the duplicate this exists to
 * prevent. A hooked session touches its row on every tool call, so a live one is never
 * close to this bound.
 */
const HOOK_LIVENESS_MS = 10 * 60_000;

/**
 * Whether some host is already delivering change cards for this project root.
 *
 * Both channels watch the same commit log with independent watermarks, so on a host that
 * has hooks *and* an MCP server -- Claude Code and Codex, the common case -- an unsuppressed
 * notice reports every foreign change twice: once from PostToolUse, once appended to the
 * next knowl_* result. The hook path is the better of the two to keep, because it fires on
 * any tool call rather than only on Knowl ones.
 *
 * The test is `midTurnDeliveryVerified`, not whether an envelope exists. Cursor emits one
 * that upstream does not surface, so inferring delivery from the envelope would mute this
 * path for the very host that has no other way to hear about a change. `generic` likewise
 * can hold a live binding and still be unable to show anything.
 */
async function anotherChannelIsDelivering(projectRoot: string): Promise<boolean> {
  const since = new Date(Date.now() - HOOK_LIVENESS_MS).toISOString();
  const hosts = await listLiveHostBindings(projectRoot, since);
  // An unrecognised host string cannot be assumed to deliver anything.
  return hosts.some(host => isHookHost(host) && hostProfile(host).midTurnDeliveryVerified);
}

/**
 * Resolved once per process.
 *
 * Linking a workspace mid-session is rare and the server restarts with the host, so paying
 * a config read and a manifest read on every tool call would buy nothing.
 */
async function activeWorkspace(projectRoot: string): Promise<ActiveWorkspace | null> {
  const state = stateFor(projectRoot);
  if (!state.workspace) state.workspace = resolveWorkspace(projectRoot).catch(() => null);
  return state.workspace;
}

async function readHeads(projectRoot: string): Promise<Watermark> {
  const workspace = await activeWorkspace(projectRoot);
  const peers = workspace ? await readPeerCommitHeads(workspace.peers) : {};
  return { local: await readCommitHead(), peers };
}

/** Heads as of just before a tool runs. Anything committed after this is the tool's own. */
export async function captureChangeWatermark(projectRoot: string | null): Promise<Watermark | null> {
  if (!projectRoot) return null;
  try {
    return await readHeads(projectRoot);
  } catch {
    return null; // notification is never worth failing a tool call over
  }
}

/**
 * The card to append to a tool result, or undefined when there is nothing to report.
 *
 * `before` is the state the caller had already been shown up to; everything between the
 * stored watermark and `before` was committed by somebody else while this session was
 * doing something other than looking.
 */
export async function consumeChangeNotice(
  projectRoot: string | null,
  toolName: string,
  before: Watermark | null,
): Promise<string | undefined> {
  if (!projectRoot || !before) return undefined;
  try {
    const state = stateFor(projectRoot);
    const previous = state.seen;
    // First tool call of the process adopts the current head instead of replaying every
    // commit the repo has ever had.
    if (WRITE_TOOLS.has(toolName)) {
      const head = await readCommitHead();
      state.seen = { local: head, peers: before.peers };
      // Publish the range for the hook path, which has no way of its own to tell this
      // call's commits from a sibling session's. Best effort: an unrecorded range only
      // costs the hook its old key-matching guess.
      if (head > before.local) {
        await recordMcpCallCommits({ projectRoot, toolName, range: { from: before.local, to: head } })
          .catch(() => undefined);
      }
    } else {
      state.seen = before;
    }
    if (!previous) return undefined;

    const summaries: ChangeSummary[] = [];
    if (before.local > previous.local) {
      // No attribution keys: the window closes at `before.local`, which is the head as of
      // just before this call ran, so anything this call committed is outside it. Own
      // writes are excluded by construction rather than by matching titles.
      summaries.push(await loadForeignChanges(previous.local, undefined, before.local));
    }

    const workspace = await activeWorkspace(projectRoot);
    for (const peer of workspace?.peers ?? []) {
      const head = before.peers[peer.name];
      const previousHead = previous.peers[peer.name];
      if (head === undefined || previousHead === undefined || head <= previousHead) continue;
      try {
        summaries.push(await loadForeignPeerChanges(peer, previousHead, head));
      } catch {
        // Unreadable now: retry this window on the next call rather than skipping it.
        state.seen = { ...state.seen, peers: { ...state.seen.peers, [peer.name]: previousHead } };
      }
    }

    const merged = mergeChangeSummaries(summaries);
    if (!merged) return undefined;
    // Checked last, and after the watermark has already moved: when the hook path is
    // delivering, this change has been shown, so consuming it silently is right. Leaving
    // the watermark behind instead would replay the backlog the moment hooks went quiet.
    return await anotherChannelIsDelivering(projectRoot) ? undefined : renderChangeCard(merged);
  } catch {
    return undefined;
  }
}

/**
 * Knowl calls a process must have served before its silence means anything.
 *
 * The hook path counts assistant *turns* (`MIN_SUBSTANTIVE_TURNS`, 3) because the sessions worth
 * catching are long on turns and short on tool calls. That signal does not exist here -- an MCP
 * server sees only its own tool calls -- so this counts those instead, and sets the bar higher
 * to compensate. Five reads with nothing stored is an agent that has been consulting memory
 * steadily and contributing nothing back, which is exactly the shape being looked for.
 */
const MIN_MCP_READS = 5;

/**
 * Whether the hook path already owns this project's capture nudge.
 *
 * Same shape as `anotherChannelIsDelivering` and the same reason, one member over: a host with a
 * live binding and a `stopContext` gets the nudge at stop time, where it can actually withhold
 * something. Sending a second copy here would spend the message twice and read, to the agent,
 * as memory nagging it.
 *
 * Absence of any live binding is the normal case for the hosts this path exists for -- they have
 * no hooks to bind with.
 */
async function hookChannelOwnsTheNudge(projectRoot: string): Promise<boolean> {
  const since = new Date(Date.now() - HOOK_LIVENESS_MS).toISOString();
  const hosts = await listLiveHostBindings(projectRoot, since);
  return hosts.some(host => isHookHost(host) && typeof hostProfile(host).stopContext === 'function');
}

/**
 * The capture nudge, for hosts that have no stop hook to carry it.
 *
 * `evaluateSilenceNudge` on the hook path is the real one: it fires at a turn boundary and
 * withholds the stop. Neither is available here -- an MCP server has no turn signal and nothing
 * to withhold -- so this is the weaker twin, and deliberately so. It rides a tool result, which
 * the agent may read and ignore. That is a worse guarantee than blocking and an infinitely
 * better one than the alternative, which for `claude-desktop`, `opencode`, Zed and every other
 * MCP-only client was nothing at all.
 *
 * **Per process, not per stored conversation.** The first attempt at this reused
 * `capture_outcomes`, and it could never fire: those rows are keyed on a `conversationKey` built
 * from a host session id this path does not have, and their `turns` counter is incremented only
 * from the hook path -- so on a genuinely hookless host the row never existed and the threshold
 * was never met. A stdio server is spawned per connected client, so the process *is* the
 * conversation, which is the same reasoning the watermark above already relies on.
 *
 * Spent once per process, like the stop-path claim: "you stored nothing" is a condition an agent
 * may rightly decline to clear, and without a one-shot it would repeat on every call forever.
 */
export async function consumeCaptureNudge(
  projectRoot: string | null,
  toolName: string,
  config: ProjectConfig | null,
): Promise<string | undefined> {
  if (!projectRoot) return undefined;
  try {
    if (captureNudgeMode(config ?? undefined) !== 'enforce') return undefined;
    const state = stateFor(projectRoot);
    if (isDurableWriteTool(toolName)) {
      state.durableWrites += 1;
      return undefined;
    }
    state.reads += 1;
    if (state.nudged || state.durableWrites > 0 || state.reads < MIN_MCP_READS) return undefined;
    if (await hookChannelOwnsTheNudge(projectRoot)) return undefined;
    state.nudged = true;
    return renderSilenceNudge();
  } catch {
    return undefined; // never worth failing a tool call over
  }
}

/** Test seam. Process-global state would otherwise leak between test files. */
export function resetChangeNotice(): void {
  byRoot.clear();
}
