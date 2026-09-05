import path from 'node:path';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { normalizeHostHook, readLifecyclePayloadObject } from '@dat999zx/knowl/plugin';
import { OpenClawEngineManager, safely, withDeadline } from './engine.js';

export { OpenClawEngineManager, safely, withDeadline };

const MAX_IMPACT_SEEN = 512;
const impactSeen = new Map<string, true>();

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
        const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
          ?? ctx?.workspaceDir
          ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
          ?? process.cwd();

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
          const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
            ?? ctx?.workspaceDir
            ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
            ?? process.cwd();

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

            const writtenPaths = extractWrittenPaths(event.toolName, event.args);
            if (writtenPaths.length === 0) return undefined;

            const sessionId = ctx?.sessionId
              ?? ctx?.sessionKey
              ?? (event as Record<string, unknown>)?.sessionId as string | undefined
              ?? (event as Record<string, unknown>)?.sessionKey as string | undefined
              ?? 'openclaw-session';

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

              const existingContent = Array.isArray(event.result?.content) ? event.result.content : [];
              return {
                result: {
                  ...event.result,
                  content: [
                    ...existingContent,
                    { type: 'text', text: cardText },
                  ],
                },
              };
            }

            return undefined;
          }, api.logger);
        },
        {
          matcher: ['exec', 'apply_patch', 'spawn_agent'] as const,
          runtimes: ['openclaw', 'codex'],
        },
      );
    }

    // Capture observer: maps after_tool_call -> session-event.
    // Return value is ignored by host, but handler must await inside safely without floating promises.
    api.on('after_tool_call', async (event, ctx) => {
      await safely(async () => {
        const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
          ?? ctx?.workspaceDir
          ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
          ?? process.cwd();

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

        await withDeadline(
          manager.getObserverDeadlineMs(),
          () => handle.lifecycle(normalized),
          null,
        );
      }, api.logger);
    });

    // Compaction checkpoint: maps before_compaction -> checkpoint.
    // Bounded under 10s (host has 30s timeout, runs on serialized notification queue in Codex harness).
    api.on('before_compaction', async (event, ctx) => {
      await safely(async () => {
        const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
          ?? ctx?.workspaceDir
          ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
          ?? process.cwd();

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

    // Session start: maps session_start -> session-start.
    // Warms workspace handle in memory so initial write gate avoids cold open latency.
    api.on('session_start', async (event, ctx) => {
      await safely(async () => {
        const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
          ?? ctx?.workspaceDir
          ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
          ?? process.cwd();

        const handle = await manager.warmWorkspace(cwd);
        if (!handle) return;

        const raw: Record<string, unknown> = {
          cwd,
          sessionId: ctx?.sessionId ?? ctx?.sessionKey ?? (event as Record<string, unknown>)?.sessionId ?? (event as Record<string, unknown>)?.sessionKey ?? 'openclaw-session',
          agentId: ctx?.agentId ?? (event as Record<string, unknown>)?.agentId,
          agentType: (event as Record<string, unknown>)?.agentType,
        };

        const payload = readLifecyclePayloadObject(raw);
        const normalized = normalizeHostHook('openclaw', 'session_start', payload as Record<string, unknown>);

        await withDeadline(
          manager.getObserverDeadlineMs(),
          () => handle.lifecycle(normalized),
          null,
        );
      }, api.logger);
    });

    // Session / agent shutdown: maps session_end & agent_end -> turn-stop.
    // Bound by 1.5s under OpenClaw's 2-second total shutdown drain budget.
    for (const hookName of ['session_end', 'agent_end'] as const) {
      api.on(hookName, async (event, ctx) => {
        await safely(async () => {
          const cwd = (event as Record<string, unknown>)?.cwd as string | undefined
            ?? ctx?.workspaceDir
            ?? (ctx as Record<string, unknown>)?.cwd as string | undefined
            ?? process.cwd();

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

