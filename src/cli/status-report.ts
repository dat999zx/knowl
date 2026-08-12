import { KNOWLEDGE_CATEGORIES, KnowledgeCommit, KnowledgeItem, Project, ProjectConfig } from '../core/types.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import type { CaptureHealth } from '../store/capture-outcome.js';
import type { CloudStatus } from '../cloud/status.js';
import { formatWorkspaceBlock } from './workspace-report.js';

const STATUS_LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/**
 * Two lines and a pointer, deliberately.
 *
 * `knowl status` was already long and the cloud has its own command with the full picture. What
 * this fixes is that cloud state was reachable from nowhere in the report a developer actually
 * runs -- so a repo could be connected, with atoms queued, and `knowl status` said nothing.
 *
 * Rendered only when connected. A repo that never touched the cloud gains no section at all.
 */
function formatCloudBlock(cloud: CloudStatus | null): string[] {
  if (!cloud?.connected) return [];
  return [
    STATUS_LINE,
    '☁️  CLOUD',
    `  Workspace:     ${cloud.workspace}`,
    `  Staged:        ${cloud.staged} (${cloud.stagedNew} new, ${cloud.stagedCorrections} correction(s))`,
    '  Run `knowl cloud status` for the full picture.',
  ];
}

export function formatStatusReport(input: {
  project: Project;
  config: ProjectConfig;
  activeItems: KnowledgeItem[];
  supersededItems: KnowledgeItem[];
  deprecatedItems: KnowledgeItem[];
  commits: KnowledgeCommit[];
  /** Absent for an unlinked project, which keeps its output byte-identical. */
  workspace?: ActiveWorkspace | null;
  /** Absent on a store with no recorded sessions, which renders no section at all. */
  capture?: CaptureHealth;
  captureNudgeMode?: string;
  /** Absent or disconnected renders nothing, so an offline repo gains no noise. */
  cloud?: CloudStatus | null;
}): string {
  const countsByCategory = input.activeItems.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const lines: string[] = [
    STATUS_LINE,
    '🧠 KNOWL REPOSITORY STATUS',
    STATUS_LINE,
    `Repository:     ${input.project.rootPath}`,
    `AI Config:      ${input.config.ai ? `${input.config.ai.provider} (${input.config.ai.model})` : 'not configured'}`,
    STATUS_LINE,
    '📝 KNOWLEDGE ITEMS',
    `  Active:        ${input.activeItems.length}`,
    `  Superseded:    ${input.supersededItems.length}`,
    `  Deprecated:    ${input.deprecatedItems.length}`,
    STATUS_LINE,
    '📊 ACTIVE ITEMS BY CATEGORY',
  ];

  for (const category of KNOWLEDGE_CATEGORIES) {
    lines.push(`  ${category.padEnd(14)}: ${countsByCategory[category] || 0}`);
  }

  lines.push(STATUS_LINE, '🪵  RECENT COMMITS');
  if (input.commits.length === 0) {
    lines.push('  No commits recorded yet.');
  } else {
    for (const commit of input.commits) {
      lines.push(`  [${commit.id}] ${new Date(commit.createdAt).toLocaleString()} - ${commit.message}`);
    }
  }
  lines.push(...formatCaptureHealthBlock(input.capture, input.captureNudgeMode));
  lines.push(...formatWorkspaceBlock(input.workspace ?? null));
  lines.push(...formatCloudBlock(input.cloud ?? null));
  lines.push(STATUS_LINE);

  return lines.join('\n');
}

/**
 * What this repo failed to store, beside what it stored.
 *
 * The knowledge counts above answer "what got in". This is the other half of that sentence: how
 * often a session talked for a while and put nothing durable in the store. It is reported whether
 * or not `capture.nudge` is armed, because the number has to exist before anyone can sensibly
 * decide whether they want something done about it.
 *
 * Absent until a session has been recorded, rather than printed as a row of zeros: a repo whose
 * hooks have never run has not measured 0%, it has measured nothing, and a confident zero is the
 * wrong thing to tell someone whose capture is simply not wired up.
 */
function formatCaptureHealthBlock(capture?: CaptureHealth, mode?: string): string[] {
  if (!capture || capture.sessions === 0) return [];

  const share = Math.round((capture.substantiveSilent / capture.sessions) * 100);
  const lines = [
    STATUS_LINE,
    '🔍 CAPTURE HEALTH',
    `  Sessions recorded:     ${capture.sessions}`,
    `  Stored nothing:        ${capture.silent}`,
    `  ...and ran long enough to count: ${capture.substantiveSilent} (${share}%)`,
  ];
  // Only once something has fired, and named by mode: "12 recorded" and "12 delivered" are very
  // different facts about a repository, and a single count that means either is worth nothing.
  if (capture.nudged > 0) {
    lines.push(`  Nudges ${mode === 'enforce' ? 'delivered' : 'recorded (shadow)'}:  ${capture.nudged}`);
  }
  if (mode === 'off') lines.push('  Nudge: off — measuring only. Arm with capture.nudge=shadow.');
  return lines;
}
