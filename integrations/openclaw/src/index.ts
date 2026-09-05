import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { normalizeHostHook, readLifecyclePayloadObject } from '@dat999zx/knowl/plugin';
import { OpenClawEngineManager, safely, withDeadline } from './engine.js';

export { OpenClawEngineManager, safely, withDeadline };

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
    const manager = new OpenClawEngineManager({
      logger: api.logger,
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
  },
});

