import type { SkillManifest } from './registry.js';

export interface SkillBinding {
  inputs?: Record<string, string>;
  version?: number;
}

const REFERENCE = /\$\{([^}]*)\}/g;

/**
 * The values an entrypoint will actually run with: the project's bindings, with declared defaults
 * filling the gaps.
 *
 * A missing input is reported rather than defaulted to empty. An unbound playbook is listed and
 * readable but not runnable, which is the point of sharing one: discovery without running it in a
 * repository nobody bound it to.
 */
export function resolveBinding(
  manifest: SkillManifest,
  binding: SkillBinding | undefined,
): { values: Record<string, string> } | { missing: string[] } {
  const declared = manifest.requires?.inputs ?? {};
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    const bound = binding?.inputs?.[name];
    if (typeof bound === 'string' && bound.length > 0) {
      values[name] = bound;
    } else if (typeof spec.default === 'string') {
      values[name] = spec.default;
    } else {
      missing.push(name);
    }
  }
  return missing.length > 0 ? { missing } : { values };
}

/**
 * Substitute `${inputs.NAME}` and refuse everything else.
 *
 * This is the whole injection surface of a shared playbook, so it stays as small as it can be:
 * no environment, no expressions, no shell. An unknown reference throws rather than resolving to
 * an empty string, because a hole spliced into a command line is how a harmless-looking template
 * becomes a different command.
 */
export function interpolate(args: string[], values: Record<string, string>): string[] {
  return args.map(arg => {
    if (/\$\([^)]*\)/.test(arg)) {
      throw new Error(`Command substitution $(...) is not allowed in skill arguments: ${arg}`);
    }
    return arg.replace(REFERENCE, (whole, reference: string) => {
      const name = reference.startsWith('inputs.') ? reference.slice('inputs.'.length) : null;
      if (!name || !(name in values)) {
        throw new Error(
          `Skill entrypoint references ${whole}, which is not a bound input. Only \${inputs.<name>} `
          + 'is substituted, and every referenced input must be bound or have a default.',
        );
      }
      return values[name];
    });
  });
}

/**
 * Refuse execution when a project binding is pinned to a specific version and the playbook
 * has moved on.
 */
export function assertPinned(manifest: SkillManifest, binding: SkillBinding): void {
  if (binding.version !== undefined && binding.version !== manifest.version) {
    throw new Error(
      `Skill "${manifest.name}" is pinned to ${binding.version}, but is now ${manifest.version}. `
      + `Update the pin in project configuration or re-align the playbook before running.`,
    );
  }
}
