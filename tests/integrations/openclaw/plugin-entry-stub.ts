/**
 * A stand-in for `openclaw/plugin-sdk/plugin-entry` under vitest.
 *
 * The real module is a **peer dependency** of `integrations/openclaw` and is deliberately not
 * installed in this repository: OpenClaw refuses to let npm place a second registry copy of the
 * host inside a managed plugin project, and relinks its own `node_modules/openclaw` after
 * install. So the specifier resolves on a machine that happens to have OpenClaw installed and
 * fails everywhere else — which is exactly what happened on CI, where the suite passed locally
 * and died with `Cannot find package 'openclaw/plugin-sdk/plugin-entry'` on ubuntu and macOS.
 *
 * `definePluginEntry` is an identity-shaped registrar: it takes the plugin definition and hands
 * back something the gateway can load. Nothing in these tests exercises the host's side of that
 * contract — they drive `register(api)` directly with a fake `api` — so returning the definition
 * unchanged is a faithful stub rather than a simplification that hides a behaviour.
 *
 * Typed against the real shape loosely on purpose: tightening it here would duplicate OpenClaw's
 * declarations into this repo, and they are already the authority (`npm view openclaw`).
 */
export function definePluginEntry<T>(definition: T): T {
  return definition;
}
