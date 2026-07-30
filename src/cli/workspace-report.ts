import type { ProjectConfig } from '../core/types.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import {
  embeddingIdentityFromConfig, formatEmbeddingIdentity, sameEmbeddingIdentity,
} from '../store/embedding-identity.js';

export type WorkspaceDoctorCheck = { status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string };

const LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Empty for an unlinked project, so existing status output stays byte-identical. */
export function formatWorkspaceBlock(active: ActiveWorkspace | null, options: { verbose?: boolean } = {}): string[] {
  if (!active) return [];
  const lines = [LINE, '🔗 WORKSPACE', `  Workspace:      ${active.name}`, `  This repo:      ${active.repo}`];
  if (active.peers.length === 0) {
    lines.push('  Linked repos:   none yet');
    return lines;
  }
  lines.push('  Linked repos:');
  for (const peer of active.peers) {
    const state = peer.present ? 'present' : 'missing from this machine';
    // Names by default; resolved roots stay out of routine output.
    lines.push(`    ${peer.name.padEnd(16)} ${state}${options.verbose ? ` (${peer.root})` : ''}`);

    // Appended as their own line rather than widened into the row above, so a repo with
    // nothing recorded produces byte-identical output to before this feature.
    const nature: string[] = [];
    if (peer.role) nature.push(peer.role);
    if (peer.kin) nature.push(`kin: ${peer.kin}`);
    if (peer.defaultVisibility === 'workspace') nature.push('new writes are workspace-visible');
    if (nature.length) lines.push(`      ${nature.join(' — ')}`);
  }
  return lines;
}

/**
 * Every failure mode of query-time fan-out is silent: a peer whose path is gone, a manifest
 * that moved, a repo whose vector config drifted. These checks are the answer to "why did my
 * cross-repo query return nothing".
 */
export function workspaceDoctorChecks(active: ActiveWorkspace | null, config: ProjectConfig): WorkspaceDoctorCheck[] {
  if (!active) return [];

  const checks: WorkspaceDoctorCheck[] = [
    { status: 'OK', message: `Workspace "${active.name}" reachable; this repo is "${active.repo}"` },
  ];

  for (const peer of active.peers) {
    checks.push(peer.present
      ? { status: 'OK', message: `Linked repo "${peer.name}" present` }
      : {
        status: 'WARN',
        message: `Linked repo "${peer.name}" is missing from this machine; its knowledge is skipped`,
        fix: `re-add it with \`knowl workspace add <path> --name ${peer.name}\`, or remove it`,
      });
  }

  const local = embeddingIdentityFromConfig(config);
  if (!sameEmbeddingIdentity(local, active.manifest.embedding)) {
    checks.push({
      status: 'WARN',
      message: `This repo embeds with ${formatEmbeddingIdentity(local)} but the workspace uses ${formatEmbeddingIdentity(active.manifest.embedding)}; vector search filters on provider and model, so the two sets of items are invisible to each other`,
      fix: 'align `search.vector` with the workspace, then run `knowl reindex --vectors`',
    });
  }

  return checks;
}
