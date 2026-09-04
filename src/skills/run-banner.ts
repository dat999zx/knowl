/**
 * Run banner shown before executing a skill package entrypoint.
 *
 * NOTE: Capabilities are declarations of intent, NOT a sandbox. They inform the operator
 * what the skill intends to do before it runs, and do not confine or isolate the process.
 *
 * The banner prints on every run, not only the first: the person running a shared playbook
 * did not write it, so the fully resolved command and declared capabilities must be visible.
 */
export interface RunBannerInput {
  name: string;
  layer?: 'project' | 'global';
  version?: number;
  approvedAt?: string;
  command: string;
  cwd: string;
  capabilities?: string[];
  preconditions?: string[];
}

export function formatRunBanner(input: RunBannerInput): string {
  const layer = input.layer ?? 'project';
  const version = input.version !== undefined ? `, v${input.version}` : '';
  const approved = input.approvedAt ? `, approved ${input.approvedAt}` : '';
  const skillDetails = `${input.name} (${layer}${version}${approved})`;

  const caps = input.capabilities && input.capabilities.length > 0
    ? input.capabilities.join(', ')
    : 'none';

  const preconds = input.preconditions && input.preconditions.length > 0
    ? input.preconditions.map(p => `${p} \u2713`).join(', ')
    : 'none';

  return [
    `knowl skill run ${input.name}`,
    `  skill:        ${skillDetails}`,
    `  command:      ${input.command}`,
    `  cwd:          ${input.cwd}`,
    `  capabilities: ${caps}`,
    `  preconditions: ${preconds}`,
  ].join('\n');
}
