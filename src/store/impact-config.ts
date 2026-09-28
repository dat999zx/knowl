import type { ProjectConfig } from '../core/types.js';

/**
 * Whether this repository has asked for change-impact detection.
 *
 * On unless the literal `false` says otherwise, as `search.pathsChanged` is: detection records
 * read sets and writes findings, and the part that can get in the way -- the write gate -- has
 * its own switch below, which rests in `shadow`. The key stays out of DEFAULT_CONFIG so an
 * upgrade does not stamp it into every config on the machine.
 *
 * The argument is optional rather than required because the callers are on the hook and
 * lifecycle paths, where the config is only present once a project root resolved. Making
 * them each write `config ? isImpactEnabled(config) : false` is how one of them eventually
 * writes `!config || isImpactEnabled(config)`. `hasAiConfigured` takes the same shape, for
 * the same reason.
 */
export function isImpactEnabled(config?: ProjectConfig): boolean {
  return config?.impact?.enabled !== false;
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
 * Unset is `shadow`; anything unrecognised is `off`. A malformed value here can take away
 * somebody's ability to write a file, and a `config.json` is a file people edit by hand.
 *
 * `shadow` is the default and where this is expected to sit for a while: it computes the real verdict and
 * withholds the refusal, which is how plan §9's ≥95%-over-≥40-findings bar gets measured before
 * anything is allowed to block.
 */
export function impactGateMode(config?: ProjectConfig): ImpactGateMode {
  if (!isImpactEnabled(config)) return 'off';
  const mode = config?.impact?.gate;
  if (mode === undefined) return 'shadow';
  return GATE_MODES.includes(mode as ImpactGateMode) ? mode as ImpactGateMode : 'off';
}
