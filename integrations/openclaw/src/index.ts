import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

/**
 * OpenClaw in-process plugin for Knowl.
 *
 * Runs inside OpenClaw's gateway process to evaluate write gates in sub-millisecond
 * latency and supply turn orientation and tool-result impact cards in the turn that earned them.
 *
 * All handlers register through synchronous `register(api)` using `api.on(...)`.
 * `api.registerHook` is avoided because it is a legacy internal system that warns and never fires
 * for typed host event names.
 */
export default definePluginEntry({
  id: 'knowl',
  name: 'Knowl',
  description: 'Persistent repository memory and write gate for OpenClaw.',
  register(api: OpenClawPluginApi) {
    const _config = api.pluginConfig ?? {};
    // Hook registrations (before_prompt_build, before_tool_call, etc.) will be wired
    // in subsequent tasks via the engine manager.
  },
});
