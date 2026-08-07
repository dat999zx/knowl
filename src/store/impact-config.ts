import type { ProjectConfig } from '../core/types.js';

/**
 * Whether this repository has asked for change-impact detection.
 *
 * Only the literal `true` counts. Everything else -- the key absent, the block absent, a
 * hand-edited `"yes"` or `1` or `null`, or no config loaded at all -- reads as off, because
 * every failure mode of this subsystem is a failure of turning it on. It captures read sets,
 * writes findings, and declines to record a clean `task_finish` while a certain-tier finding
 * is unresolved; a repository that switched all of that on because a config was malformed
 * would find its work loop gated by machinery nobody in it opted into, and the gate is
 * designed to be hard for an agent to ignore.
 *
 * The argument is optional rather than required because the callers are on the hook and
 * lifecycle paths, where the config is only present once a project root resolved. Making
 * them each write `config ? isImpactEnabled(config) : false` is how one of them eventually
 * writes `!config || isImpactEnabled(config)`. `hasAiConfigured` takes the same shape, for
 * the same reason.
 */
export function isImpactEnabled(config?: ProjectConfig): boolean {
  return config?.impact?.enabled === true;
}
