import { KNOWLEDGE_CATEGORIES, KnowledgeCommit, KnowledgeItem, Project, ProjectConfig } from '../core/types.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import type { CaptureHealth } from '../store/capture-outcome.js';
import { SHADOW_GATE_PRECISION_BAR, SHADOW_GATE_SAMPLE_BAR, type ShadowGateReport } from '../store/gate-shadow.js';
import type { RecallGapReport } from '../store/recall-gap.js';
import type { UnrestatedReport } from '../store/unrestated.js';
import type { CloudStatus } from '../cloud/status.js';
import { truncateText } from '../core/token-budget.js';
import { formatWorkspaceBlock } from './workspace-report.js';

/** Titles run to MAX_TITLE_CHARS (200); a status block is read at a glance, not studied. */
const TITLE_CHARS = 64;

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
  /** Absent, or a store that has observed no tool touches, renders no section at all. */
  recall?: RecallGapReport;
  /** Absent, or a store whose shadow gate has withheld nothing, renders no section at all. */
  shadowGate?: ShadowGateReport;
  /** Absent, or a store where no active item carries an open assertion, renders no section. */
  unrestated?: UnrestatedReport;
  /** Absent or disconnected renders nothing, so an offline repo gains no noise. */
  cloud?: CloudStatus | null;
  /**
   * How many features are on, and where to read them. One line, because `knowl init` points
   * every new user here and at nowhere else -- and because this is already the longest screen
   * the CLI prints, so the catalog itself belongs behind the command this names.
   *
   * Absent renders no section, keeping a caller that has not gathered it byte-identical.
   */
  features?: string;
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
    ...(input.features ? [STATUS_LINE, '⚙️  FEATURES', `  ${input.features}`] : []),
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
  lines.push(...formatShadowGateBlock(input.shadowGate));
  lines.push(...formatRecallGapBlock(input.recall));
  lines.push(...formatUnrestatedBlock(input.unrestated));
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
/**
 * The read side's twin of capture health: how often the agent acted on a file this store already
 * knew something about, without having retrieved it.
 *
 * The share is taken over `held`, not over `touches`, and the difference is the whole point. A
 * miss is only possible where there was something to miss, so dividing by every tool call would
 * report a number that falls as the agent works in files the store says nothing about -- which is
 * activity, not improvement.
 *
 * The undercount is printed rather than left in a doc comment. Only knowledge carrying
 * `affectedPaths` can be matched to a file, so this is a floor on the real gap, and a floor read
 * as a total is the way a measurement like this gets quietly dismissed.
 */
function formatRecallGapBlock(recall?: RecallGapReport): string[] {
  if (!recall || recall.touches === 0) return [];

  const lines = [
    STATUS_LINE,
    '📌 RECALL GAP',
    `  Tool touches observed: ${recall.touches}`,
    `  Store held something:  ${recall.held}`,
  ];
  if (recall.held > 0) {
    lines.push(`  ...already retrieved:  ${recall.retrieved}`);
    lines.push(`  ...missed:             ${recall.missed} (${Math.round((recall.missed / recall.held) * 100)}%)`);
    lines.push('  Lower bound — only knowledge citing a file path can be counted here.');
  }
  // Printed only when both populations exist, so the comparison is never against one side.
  // Subagents are the interesting half: they receive no prompt reminder and no MCP server
  // instructions, so their share is the closest thing to a controlled read on whether the
  // bootstrap card alone carries the habit.
  if (recall.byActor) {
    const share = (side: { held: number; retrieved: number }) =>
      side.held === 0 ? 'n/a' : `${Math.round((side.retrieved / side.held) * 100)}%`;
    lines.push(`  Retrieved when held — main thread: ${share(recall.byActor.main)} (${recall.byActor.main.held} held)`);
    lines.push(`                        subagents:   ${share(recall.byActor.subagent)} (${recall.byActor.subagent.held} held)`);
  }
  return lines;
}

/**
 * The knowledge no drift check can reach, dated by when anyone last restated it.
 *
 * Report only, and that is the whole of it. For prose there is no evidence a claim became false,
 * only the absence of anyone reaffirming it -- flagging would assert a defect nothing observed,
 * and the failure mode of over-eager staleness here is losing knowledge nobody can recover.
 *
 * The named list is what makes this worth printing before the corpus is old enough to flag
 * anything: ranking needs no threshold, so it is correct at any store age and sharpens on its own.
 * It ranks on the ratio to a category median, not on age -- see `UnrestatedItem`, where the
 * measurement that ruled out plain age is recorded.
 *
 * Categories are printed in measured order rather than a fixed one. On a real 962-item store the
 * longest un-restated were goal, skill, constraint and decision, and `state` was among the
 * best-maintained -- the opposite of the intuition that state rots fastest, because a state atom
 * gets rewritten as the state changes, which is the one case where the write path already forces
 * a restatement.
 */
function formatUnrestatedBlock(unrestated?: UnrestatedReport): string[] {
  if (!unrestated || unrestated.rows.length === 0) return [];

  const width = Math.max(...unrestated.rows.map(row => row.category.length));
  const lines = [
    STATUS_LINE,
    '🕰️  UN-RESTATED CLAIMS',
    `  Prose (cites no code): ${unrestated.proseCount} of ${unrestated.proseCount + unrestated.codeCount}`,
    '  Days since anyone restated the claim, by category:',
  ];
  for (const row of unrestated.rows) {
    lines.push(`    ${row.category.padEnd(width)}  n=${String(row.count).padStart(4)}  p50 ${String(row.medianDays).padStart(6)}d`);
  }
  // No per-category `oldest` column, and the list below is not ranked on age either. Both were
  // measured printing the same non-finding: the store's own age, seven times in the column's
  // case, five times in an age-ranked list's, because a store is seeded in one batch and that
  // batch stays its oldest cohort forever. Ranking each claim against its own category's median
  // asks the question the column was reaching for -- is this one unusual for its kind.
  if (unrestated.outliers.length > 0) {
    lines.push("  Furthest past its own category's cadence:");
    const categoryWidth = Math.max(...unrestated.outliers.map(entry => entry.category.length));
    for (const entry of unrestated.outliers) {
      lines.push(`    ${String(entry.ratio).padStart(5)}x p50  ${String(entry.days).padStart(6)}d  ${entry.category.padEnd(categoryWidth)}  ${truncateText(entry.title, TITLE_CHARS, '...')}`);
    }
  }
  // Both caveats are printed, not filed. The first is why the table is not a staleness verdict;
  // the second is why its tail cannot be read as one either.
  lines.push('  Not a staleness signal: nothing here observed a claim becoming false.');
  lines.push(`  Store history is ${unrestated.storeHistoryDays}d, so ages beyond that cannot be distinguished from absence.`);
  if (unrestated.prosePathOnly > 0) {
    lines.push(`  ${unrestated.prosePathOnly} counted as prose despite citing paths, because every path is a prose file.`);
  }
  return lines;
}

/**
 * What an enforcing write gate would have refused, and whether that is yet good enough to enforce.
 *
 * `shadowGatePrecision` has existed since the gate did, computing exactly the number plan §9's
 * bar is written against -- and nothing imported it. So shadow mode was recording withheld
 * refusals into a table whose verdict no command could print, which is the same defect as not
 * measuring at all: a measurement nobody can read cannot promote or retire the thing it measures.
 *
 * THE BAR IS PRINTED BESIDE THE NUMBER, always. A precision figure alone invites the reading
 * "91% sounds fine"; against ">=95% over >=40 adjudicated" it reads as what it is. Both halves
 * of the bar are shown because they fail differently -- a store can sit at 100% over three
 * findings, which is not evidence, and this block has to say so rather than look like a pass.
 *
 * Absent until shadow mode has actually withheld something, following every other block here: a
 * repo whose gate has never run has not measured 0%, it has measured nothing.
 */
function formatShadowGateBlock(gate?: ShadowGateReport): string[] {
  if (!gate || gate.withheld === 0) return [];

  const lines = [
    STATUS_LINE,
    '🛡️  WRITE GATE (shadow)',
    `  Refusals withheld:     ${gate.withheld}`,
    `  Adjudicated:           ${gate.adjudicated} of ${gate.withheld}`,
  ];

  if (gate.precision === null) {
    // Null is not zero and must never render as a percentage. Nothing forces adjudication, so
    // this is the ordinary early state, and it names the command that moves it.
    lines.push('  Precision:             not yet measured — resolve findings with `knowl_impact({resolve})`.');
    return lines;
  }

  const percent = (gate.precision * 100).toFixed(1);
  const clears = gate.precision >= SHADOW_GATE_PRECISION_BAR && gate.adjudicated >= SHADOW_GATE_SAMPLE_BAR;
  lines.push(
    `  Precision:             ${percent}% (${gate.falsePositives} false positive(s))`,
    `  Bar to enforce:        ≥${(SHADOW_GATE_PRECISION_BAR * 100).toFixed(0)}% over ≥${SHADOW_GATE_SAMPLE_BAR} adjudicated — ${clears ? 'cleared' : 'not cleared'}`,
  );
  // Said only when the sample is the thing standing in the way, so a repo below the precision
  // bar is not told to go and adjudicate more of something already known to be wrong.
  if (!clears && gate.adjudicated < SHADOW_GATE_SAMPLE_BAR && gate.precision >= SHADOW_GATE_PRECISION_BAR) {
    lines.push(`  ${SHADOW_GATE_SAMPLE_BAR - gate.adjudicated} more adjudicated finding(s) would decide it.`);
  }
  return lines;
}

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
