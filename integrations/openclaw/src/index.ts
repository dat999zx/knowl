import path from 'node:path';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { normalizeHostHook, readLifecyclePayloadObject } from '@dat999zx/knowl/plugin';
import { OpenClawEngineManager, safely, withDeadline } from './engine.js';

export { OpenClawEngineManager, safely, withDeadline };

/**
 * The workspace a hook event belongs to.
 *
 * OpenClaw's hook contexts do not all carry a directory: `PluginHookGatewayContext` and
 * `PluginHookAgentContext` declare `workspaceDir`, but `PluginHookToolContext` and
 * `PluginHookSessionContext` do not -- they identify a run by `sessionKey`/`agentId` and
 * nothing else. Reading `ctx.workspaceDir` unconditionally therefore type-errors on half
 * the hooks and, worse, silently falls through to `process.cwd()` at runtime, which in a
 * gateway holding several workspaces is whichever directory the gateway happens to be in.
 *
 * So the event is asked first (it carries `cwd` on the hooks that know one), the context
 * second, and `process.cwd()` last -- and the caller decides what an unresolvable workspace
 * means. `getHandle` answers `null` for a directory that is not a Knowl project, so a wrong
 * guess degrades to "no memory this turn" rather than to another project's database.
 */
function resolveWorkspace(event: unknown, ctx: unknown): string {
  const fromEvent = (event as { cwd?: unknown } | undefined)?.cwd;
  if (typeof fromEvent === 'string' && fromEvent) return fromEvent;
  const c = ctx as { workspaceDir?: unknown; cwd?: unknown } | undefined;
  if (typeof c?.workspaceDir === 'string' && c.workspaceDir) return c.workspaceDir;
  if (typeof c?.cwd === 'string' && c.cwd) return c.cwd;
  return process.cwd();
}

const MAX_IMPACT_SEEN = 512;
const impactSeen = new Map<string, true>();

/**
 * The engine's mid-turn card, parked by `after_tool_call` for the middleware to deliver.
 *
 * Session-keyed and insertion-ordered, so the oldest entry is evicted first. Bounded because a
 * gateway is a long-lived process serving many sessions and an unbounded map here is a slow
 * leak in a plugin whose whole promise is that it costs the host nothing.
 */
const MIDTURN_PENDING_MAX = 256;
const MIDTURN_CARD_MAX = 1500;
const midturnPending = new Map<string, string>();

/** Test seam: the pending cards do not survive a run, and a leaked one would cross tests. */
export function resetMidturnPendingForTest(): void {
  midturnPending.clear();
}

/**
 * A tool result with `text` appended to its `content`.
 *
 * `content`, never only `details`: OpenClaw strips `details` before provider replay and
 * compaction, so a card written there is one the model reads once and then loses.
 */
function appendCard(event: { result?: { content?: unknown } }, text: string) {
  const existingContent = Array.isArray(event.result?.content) ? event.result.content : [];
  return {
    result: {
      ...event.result,
      content: [...existingContent, { type: 'text', text }],
    },
  };
}

export function markImpactSeen(key: string): void {
  if (impactSeen.size >= MAX_IMPACT_SEEN) {
    const firstKey = impactSeen.keys().next().value;
    if (firstKey !== undefined) impactSeen.delete(firstKey);
  }
  impactSeen.set(key, true);
}

export function resetImpactSeenForTest(): void {
  impactSeen.clear();
}

function normalizeForCompare(p: string): string {
  let norm = p.replace(/\\/g, '/');
  while (norm.startsWith('./')) {
    norm = norm.slice(2);
  }
  return norm.toLowerCase();
}

export function coversAffectedPath(affected: unknown, rel: string): boolean {
  if (!Array.isArray(affected) || !rel) return false;
  const target = normalizeForCompare(rel);
  for (const entry of affected) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const e = normalizeForCompare(entry);
    if (e === target || target.endsWith('/' + e) || e.endsWith('/' + target)) {
      return true;
    }
    if (target.startsWith(e.replace(/\/+$/, '') + '/')) {
      return true;
    }
  }
  return false;
}

export function toRepoRelativePath(rawPath: string, root: string): string {
  let normalized = rawPath.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (path.isAbsolute(rawPath)) {
    try {
      const rel = path.relative(root, rawPath);
      if (!rel.startsWith('..')) {
        return rel.replace(/\\/g, '/');
      }
    } catch {
      // ignore
    }
  }
  return normalized;
}

export function extractWrittenPaths(toolName: string, args?: Record<string, unknown>): string[] {
  if (!args) return [];
  const paths: string[] = [];

  // Direct path fields
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'destination']) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      paths.push(val.trim());
    }
  }

  // Changes array (e.g. codex changes: [{ path: '...' }])
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      if (change && typeof change === 'object') {
        const p = (change as Record<string, unknown>).path
          ?? (change as Record<string, unknown>).filePath
          ?? (change as Record<string, unknown>).file;
        if (typeof p === 'string' && p.trim()) {
          paths.push(p.trim());
        }
      }
    }
  }

  // Patch content strings (e.g. apply_patch { patch: '...' } or { input: '...' })
  for (const patchKey of ['patch', 'input', 'diff']) {
    const content = args[patchKey];
    if (typeof content === 'string') {
      const starMatches = content.matchAll(/\*\*\*\s+(?:Update|Add)\s+File:\s*([^\r\n]+)/g);
      for (const m of starMatches) {
        if (m[1]?.trim()) paths.push(m[1].trim());
      }
      const diffMatches = content.matchAll(/^\+{3}\s+(?:[ab]\/)?([^\r\n\t]+)/gm);
      for (const m of diffMatches) {
        const p = m[1]?.trim();
        if (p && p !== '/dev/null') paths.push(p);
      }
    }
  }

  return Array.from(new Set(paths));
}

const DRAIN_BUDGET_MS = 1_500;

/**
 * OpenClaw in-process plugin for Knowl.
 *
 * Runs inside OpenClaw's gateway process to evaluate write gates in sub-millisecond
 * latency and supply turn orientation and tool-result impact cards in the turn that earned them.
 *
 * All handlers register through synchronous `register(api)` using `api.on(...)`.
 * `api.registerHook` is avoided because it is a legacy internal system that warns and never fires
 * for typed host event names.
 *
 * Exactly one hook publishes prompt context: `before_prompt_build`.
 * `agent_turn_prepare` and `heartbeat_prompt_contribution` are deliberately not registered
 * because prompt contributions concatenate and multiple publishers would duplicate cards.
 */
export default definePluginEntry({
  id: 'knowl',
  name: 'Knowl',
  description: 'Persistent repository memory and write gate for OpenClaw.',
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const gateDeadlineMs = typeof config.gateDeadlineMs === 'number'
      ? config.gateDeadlineMs
      : undefined;
    const observerDeadlineMs = typeof config.observerDeadlineMs === 'number'
      ? config.observerDeadlineMs
      : undefined;

    const manager = new OpenClawEngineManager({
      logger: api.logger,
      gateDeadlineMs,
      observerDeadlineMs,
    });

    // Exactly one prompt contribution hook: maps before_prompt_build -> turn-start.
    // Fixed orientation card is prepended to context. Never derives queries from prompt prose.
    api.on('before_prompt_build', async (event, ctx) => {
      return await safely(async () => {
        const cwd = resolveWorkspace(event, ctx);

        const handle = await manager.getHandle(cwd);
        if (!handle) return undefined;

        const raw: Record<string, unknown> = {
          cwd,
          sessionId: ctx?.sessionId ?? ctx?.sessionKey ?? (event as Record<string, unknown>)?.sessionId ?? (event as Record<string, unknown>)?.sessionKey ?? 'openclaw-session',
          turnId: (event as Record<string, unknown>)?.turnId ?? (event as Record<string, unknown>)?.runId ?? ctx?.runId ?? ctx?.jobId,
          agentId: ctx?.agentId ?? (event as Record<string, unknown>)?.agentId,
          agentType: (event as Record<string, unknown>)?.agentType,
          prompt: event.prompt,
        };

        const payload = readLifecyclePayloadObject(raw);
        const normalized = normalizeHostHook('openclaw', 'before_prompt_build', payload as Record<string, unknown>);

        const result = await withDeadline(
          manager.getGateDeadlineMs(),
          () => handle.lifecycle(normalized),
          null,
        );

        if (!result) return undefined;

        const card = (result.hostOutput?.prependContext as string | undefined) ?? result.context;
        if (card) {
          return { prependContext: card };
        }
        return undefined;
      }, api.logger);
    });

    // Write gate: maps before_tool_call -> tool-precheck for canonical write tools.
    // Answers { block: true, blockReason } on refusal.
    // Abstains (returns undefined) on allow, never returns params (Codex rejects rewrites).
    // Uses internal deadline under OpenClaw's 15s fail-closed budget so a stalled engine
    // allows the write instead of denying it.
    api.on(
      'before_tool_call',
      async (event, ctx) => {
        return await safely(async () => {
          const cwd = resolveWorkspace(event, ctx);

          const handle = await manager.getHandle(cwd);
          if (!handle) return undefined;

          const raw: Record<string, unknown> = {
            cwd,
            sessionId: ctx?.sessionId ?? ctx?.sessionKey ?? (event as Record<string, unknown>)?.sessionId ?? (event as Record<string, unknown>)?.sessionKey ?? 'openclaw-session',
            turnId: (event as Record<string, unknown>)?.turnId ?? (event as Record<string, unknown>)?.runId ?? ctx?.runId,
            agentId: ctx?.agentId ?? (event as Record<string, unknown>)?.agentId,
            agentType: (event as Record<string, unknown>)?.agentType,
            tool_name: event.toolName,
            tool_input: event.params,
            ...(Array.isArray(event.derivedPaths) ? { changed_paths: event.derivedPaths } : {}),
          };

          const payload = readLifecyclePayloadObject(raw);
          const normalized = normalizeHostHook('openclaw', 'before_tool_call', payload as Record<string, unknown>);

          const result = await withDeadline(
            manager.getGateDeadlineMs(),
            () => handle.lifecycle(normalized),
            null,
          );

          if (result?.hostOutput?.block === true && typeof result.hostOutput.blockReason === 'string') {
            return { block: true, blockReason: result.hostOutput.blockReason };
          }
          return undefined;
        }, api.logger);
      },
      { matcher: ['exec', 'apply_patch', 'spawn_agent'] as const },
    );

    // Impact card middleware: runs before output is fed back to the model.
    // Not tool_result_persist (which only rewrites the transcript copy).
    // Appends dependent atom notice into `content` (never only `details`, which OpenClaw
    // strips before provider replay and compaction).
    if (typeof api.registerAgentToolResultMiddleware === 'function') {
      api.registerAgentToolResultMiddleware(
        async (event, ctx) => {
          return await safely(async () => {
            if (event.isError) return undefined;

            const cwd = event.cwd
              ?? (ctx as Record<string, unknown>)?.workspaceDir as string | undefined
              ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
              ?? process.cwd();

            const handle = await manager.getHandle(cwd);
            if (!handle) return undefined;

            const sessionId = ctx?.sessionId
              ?? ctx?.sessionKey
              ?? (event as Record<string, unknown>)?.sessionId as string | undefined
              ?? (event as Record<string, unknown>)?.sessionKey as string | undefined
              ?? 'openclaw-session';

            // The engine's card, parked by `after_tool_call` on an earlier call. Read before
            // the impact lookup and on EVERY tool, not just writes: the drift reminder counts
            // consecutive non-Knowl calls of any kind, so a write-only path would drop it
            // during exactly the read-and-shell runs it exists to interrupt.
            const engineCard = midturnPending.get(String(sessionId));
            if (engineCard) midturnPending.delete(String(sessionId));

            const writtenPaths = extractWrittenPaths(event.toolName, event.args);
            if (writtenPaths.length === 0) {
              return engineCard ? appendCard(event, engineCard) : undefined;
            }

            for (const rawPath of writtenPaths) {
              const rel = toRepoRelativePath(rawPath, handle.projectRoot || cwd);
              if (!rel) continue;

              const cacheKey = `${sessionId}:${rel.toLowerCase()}`;
              if (impactSeen.has(cacheKey)) continue;

              const stem = path.basename(rel, path.extname(rel)).replace(/[-_]/g, ' ');
              const items = await withDeadline(
                manager.getGateDeadlineMs(),
                () => handle.query(`${rel} ${stem}`, { limit: 8 }),
                [],
              );

              const hits = items.filter((item) => coversAffectedPath(item.affectedPaths, rel));
              if (hits.length === 0) continue;

              markImpactSeen(cacheKey);

              const lines = [
                `[Knowl] ${hits.length} stored item(s) depend on ${rel}. Check them before you move on:`,
                ...hits.slice(0, 5).map((item) => `- ${item.title} (${item.category} ${item.id})`),
                'Read one in full with knowl_query and its id.',
              ];
              const cardText = lines.join('\n').slice(0, 1500);

              // Impact card first: it names a file the model just wrote, which decays fastest.
              return appendCard(event, engineCard ? `${cardText}\n\n${engineCard}` : cardText);
            }

            // Every written path was already carded this session, so the impact half has
            // nothing to say -- but a parked engine card still has to be delivered, or it is
            // dropped and the next one overwrites it.
            return engineCard ? appendCard(event, engineCard) : undefined;
          }, api.logger);
        },
        {
          // Every tool, not just the writers. The impact card is write-only by nature and
          // still gates itself on `extractWrittenPaths`, but the engine's mid-turn cards --
          // the drift reminder above all -- ride any tool call, and a write-only matcher never
          // sees the read-and-shell runs those exist to interrupt.
          runtimes: ['openclaw', 'codex'],
        },
      );
    }

    // Capture observer: maps after_tool_call -> session-event.
    // Return value is ignored by host, but handler must await inside safely without floating promises.
    api.on('after_tool_call', async (event, ctx) => {
      await safely(async () => {
        const cwd = resolveWorkspace(event, ctx);

        const handle = await manager.getHandle(cwd);
        if (!handle) return;

        const raw: Record<string, unknown> = {
          cwd,
          sessionId: ctx?.sessionId ?? ctx?.sessionKey ?? (event as Record<string, unknown>)?.sessionId ?? (event as Record<string, unknown>)?.sessionKey ?? 'openclaw-session',
          turnId: (event as Record<string, unknown>)?.turnId ?? (event as Record<string, unknown>)?.runId ?? ctx?.runId,
          agentId: ctx?.agentId ?? (event as Record<string, unknown>)?.agentId,
          agentType: (event as Record<string, unknown>)?.agentType,
          tool_name: event.toolName,
          tool_input: event.params,
          status: event.error ? 'failed' : 'finished',
          duration_ms: event.durationMs,
          exit_code: event.error ? 1 : 0,
          ...(event.error ? { error: event.error } : {}),
        };

        const payload = readLifecyclePayloadObject(raw);
        const normalized = normalizeHostHook('openclaw', 'after_tool_call', payload as Record<string, unknown>);

        const result = await withDeadline(
          manager.getObserverDeadlineMs(),
          () => handle.lifecycle(normalized),
          null,
        );

        // Park the engine's mid-turn card for the middleware to deliver.
        //
        // Keyed by SESSION, not (session, tool). This observer is not on the path that
        // rewrites the current tool result -- by the time it resolves, that result has been
        // transformed and sent -- so the reader is always a LATER call and usually a different
        // tool. A tool-keyed slot would strand the card until that same tool happened to run
        // again, which for a drift reminder counting consecutive non-Knowl calls could be
        // never.
        //
        // One tool call late is affordable because every card in this slot is advisory: "you
        // have not touched memory in 12 calls" is as true on the next call as on this one. The
        // write gate on `before_tool_call` keeps its synchronous fail-closed path precisely
        // because a refusal does NOT have that property. Same trade as the Hermes plugin, for
        // the same reason -- collecting it inline would put the engine's latency in front of
        // every tool call, including the overwhelming majority carrying no card at all.
        const card = result?.hostOutput?.appendContent;
        if (typeof card === 'string' && card.trim()) {
          const key = String(raw.sessionId);
          midturnPending.delete(key);
          midturnPending.set(key, card.slice(0, MIDTURN_CARD_MAX));
          while (midturnPending.size > MIDTURN_PENDING_MAX) {
            const oldest = midturnPending.keys().next().value;
            if (oldest === undefined) break;
            midturnPending.delete(oldest);
          }
        }
      }, api.logger);
    });

    // Compaction checkpoint: maps before_compaction -> checkpoint.
    // Bounded under 10s (host has 30s timeout, runs on serialized notification queue in Codex harness).
    api.on('before_compaction', async (event, ctx) => {
      await safely(async () => {
        const cwd = resolveWorkspace(event, ctx);

        const handle = await manager.getHandle(cwd);
        if (!handle) return;

        const raw: Record<string, unknown> = {
          cwd,
          sessionId: ctx?.sessionId ?? ctx?.sessionKey ?? (event as Record<string, unknown>)?.sessionId ?? (event as Record<string, unknown>)?.sessionKey ?? 'openclaw-session',
          turnId: (event as Record<string, unknown>)?.turnId ?? (event as Record<string, unknown>)?.runId ?? ctx?.runId,
          agentId: ctx?.agentId ?? (event as Record<string, unknown>)?.agentId,
          agentType: (event as Record<string, unknown>)?.agentType,
        };

        const payload = readLifecyclePayloadObject(raw);
        const normalized = normalizeHostHook('openclaw', 'before_compaction', payload as Record<string, unknown>);

        await withDeadline(
          manager.getObserverDeadlineMs(),
          () => handle.lifecycle(normalized),
          null,
        );
      }, api.logger);
    });

    // Session start: warms the handle so the first gate is not a cold open; does NOT
    // touch the lifecycle because OpenClaw discards this hook's return and the card would
    // be lost -- the first before_prompt_build binds the session and carries it.
    api.on('session_start', async (event, ctx) => {
      await safely(async () => {
        const cwd = resolveWorkspace(event, ctx);
        await manager.warmWorkspace(cwd);
      }, api.logger);
    });

    // Session / agent shutdown: maps session_end & agent_end -> turn-stop.
    // Bound by 1.5s under OpenClaw's 2-second total shutdown drain budget.
    for (const hookName of ['session_end', 'agent_end'] as const) {
      // Typed per hook name, so the loop variable does not collapse the handler's
      // parameters to `any`: `api.on` is overloaded per event and a union of names
      // widens both arguments. The bodies only read what `resolveWorkspace` accepts.
      api.on(hookName, async (event: unknown, ctx: unknown) => {
        await safely(async () => {
          const cwd = resolveWorkspace(event, ctx);

          const handle = await manager.getHandle(cwd);
          if (!handle) return;

          const c = ctx as Record<string, unknown> | undefined;
          const e = event as Record<string, unknown> | undefined;
          const raw: Record<string, unknown> = {
            cwd,
            sessionId: c?.sessionId ?? c?.sessionKey ?? e?.sessionId ?? e?.sessionKey ?? 'openclaw-session',
            turnId: e?.turnId ?? e?.runId ?? c?.runId,
            agentId: c?.agentId ?? e?.agentId,
            agentType: e?.agentType,
          };

          const payload = readLifecyclePayloadObject(raw);
          const normalized = normalizeHostHook('openclaw', hookName, payload as Record<string, unknown>);

          await withDeadline(
            DRAIN_BUDGET_MS,
            () => handle.lifecycle(normalized),
            null,
          );
        }, api.logger);
      });
    }

    // Gateway stop: releases all handles cleanly on full gateway shutdown.
    api.on('gateway_stop', async () => {
      await safely(async () => {
        await manager.releaseAll();
      }, api.logger);
    });
  },
});

