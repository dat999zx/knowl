import path from 'node:path';
import { knowlHome } from '../core/paths.js';

/** Playbooks shared across every project on this machine. */
export function globalSkillsRoot(): string {
  return path.join(knowlHome(), 'skills');
}

/**
 * Approvals for those playbooks, mirroring a project's `.knowl/skill-trust.json`.
 *
 * Separate from the project file on purpose: one approval here applies wherever the skill is
 * bound, so it is a bigger decision than approving a skill in one repository, and it must not be
 * writable by a checkout.
 */
export function globalTrustPath(): string {
  return path.join(knowlHome(), 'skill-trust.json');
}
