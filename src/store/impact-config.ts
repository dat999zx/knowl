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

export type ImpactGateMode = 'off' | 'shadow' | 'enforce';

const GATE_MODES: readonly ImpactGateMode[] = ['off', 'shadow', 'enforce'];

/**
 * How the `PreToolUse` write gate should behave, resolved in one place so no call site re-derives
 * it.
 *
 * **Detection off means gate off, whatever the key says.** The gate's entire input is the open
 * findings `detectCertainImpact` writes and the read-set rows the capture path records, so an
 * armed gate over a disabled detector is not a stricter configuration -- it is one that can never
 * fire while reporting that it can. Answering that here rather than at each call site means one
 * place can be wrong about it instead of three.
 *
 * Anything unrecognised is `off`, following `isImpactEnabled`'s rule and for a sharper reason. A
 * malformed value there switches on machinery nobody asked for; a malformed value here can take
 * away somebody's ability to write a file, and a `config.json` is a file people edit by hand.
 *
 * `shadow` is where this is expected to sit for a while: it computes the real verdict and
 * withholds the refusal, which is how plan §9's ≥95%-over-≥40-findings bar gets measured before
 * anything is allowed to block.
 */
export function impactGateMode(config?: ProjectConfig): ImpactGateMode {
  if (!isImpactEnabled(config)) return 'off';
  const mode = config?.impact?.gate;
  return GATE_MODES.includes(mode as ImpactGateMode) ? mode as ImpactGateMode : 'off';
}
