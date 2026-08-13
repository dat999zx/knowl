import { Command } from 'commander';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { spawnWorkLoopCommand } from './windows-spawn.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import { checkForUpdate, formatUpdateNotice, isUpdateCheckEnabled } from '../core/version-check.js';
import { NEW_PROJECT_CONFIG, findProjectRoot, isProjectRoot, loadConfig, saveConfig, hasAiConfigured } from '../core/config.js';
import {
  installKnowlProjectGuidance,
  KnowlProjectGuidanceInstallResult,
} from '../core/agents-guidance.js';
import { installKnowlGitignoreEntry } from '../core/gitignore.js';
import { initDb, closeDb } from '../store/database.js';
import * as repo from '../store/repository.js';
import { recordDecisionDirect } from '../store/knowledge-actions.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from '../store/queries.js';
import { formatHierarchyToMarkdown } from '../core/format.js';
import { formatStatusReport } from './status-report.js';
import { captureHealth } from '../store/capture-outcome.js';
import { captureNudgeMode } from '../store/capture-config.js';
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '../core/types.js';
import { createManifest, isValidRepoName, readManifest, writeManifest } from '../workspace/manifest.js';
import { knowlHome, listKnownWorkspaces, workspaceManifestPath } from '../workspace/paths.js';
import { assertSafeToLink, backfillOriginRepo, countOwnedItems, joinWorkspace, leaveWorkspace } from '../workspace/membership.js';
import { embeddingIdentityFromConfig, formatEmbeddingIdentity } from '../store/embedding-identity.js';
import { countPromotable, promoteItems } from '../workspace/promote.js';
import { closeDemandDb, summarizeDemand } from '../workspace/demand-ledger.js';
import { existingItemsNotice, visibilityGateNotice } from './workspace-visibility-notice.js';
import { repoEntry, updateRepoSettings } from '../workspace/repo-settings.js';
import { runCliQuery } from './query-command.js';
import { runCliResume } from './resume-command.js';
import { closeResumeDb } from '../session/resume-store.js';
import { createResumePoint } from '../session/resume-points.js';
import { formatPendingHandoffContext, recordDeliberateHandoff } from '../session/session-handoff.js';
import { formatCrossRepoNotice } from './cross-repo-notice.js';
import { formatWorkspaceBlock } from './workspace-report.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { assertOwnedItem } from '../workspace/ownership.js';
import { storeKnowledgeItemDeduped } from '../store/knowledge-writer.js';
import { formatDoctorReport, runDoctor } from './doctor-report.js';
import { upgradeExistingRepository, type UpgradeResult } from './upgrade.js';
import { readKnownRepos, recordKnownRepo } from './repo-registry.js';
import { discoverRepos } from './repo-discovery.js';
import { applyDoctorRemedies } from './doctor-fix.js';
import { formatSweepReport, sweepRepos } from './upgrade-all.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { getEffectiveConfigValue, resetAllConfig, resetConfigValue, setConfigValue, setConfigValues } from './config/service.js';
import { runConfigUi } from './config/ui.js';
import { defaultApiHost, runLogin, runLogout } from '../cloud/login.js';
import { createCloudApi } from '../cloud/api-client.js';
import { ensureAccessToken } from '../cloud/token.js';
import { excludeFromPublish } from '../cloud/exclusions.js';
import { unstagePublish } from '../cloud/ledger.js';
import { writeAutoPushConsent } from '../cloud/consent.js';
import { maybeAutoPush } from './auto-push.js';
import { pickWorkspace } from './cloud-picker.js';
import { formatProfileMismatch } from './profile-mismatch.js';
import { pickCategories } from './sharing-picker.js';
import { recommendedTotal, WITHHELD_BY_DEFAULT } from '../core/sharing-defaults.js';
import { runConnect } from '../cloud/connect.js';
import { runPull } from '../cloud/pull.js';
import { computePushSnapshot, countStageable, pushStaged, stagePublish } from '../cloud/publish.js';
import { reportDrift } from '../cloud/drift-report.js';
import { retractItem } from '../cloud/retract.js';
import { cloudStatus, formatCloudStatus } from '../cloud/status.js';
import { cloudPointer } from '../core/cloud-pointer.js';
import { verifyCustomModel } from '../ai/model-probe.js';
import { announceProfileChange, shadowedByPresetNotice } from './config/profile-change.js';
import { DEFAULT_DIVERGENCE_POLICY, DIVERGENCE_POLICIES } from '../store/import-policy.js';
import { formatAgentInitSummary, runAgentInitFlow } from './init-flow.js';
import { formatWarmResult, warmEmbeddingModel } from './warm-embeddings.js';
import { parseAgentNames } from './agents/registry.js';
import { reindexKnowledgeEmbeddings } from '../store/vector-index.js';
import { applyKnowledgeGc, previewKnowledgeGc, isHot } from '../store/gc.js';
import { listForgetLog, pruneForgetLog } from '../store/forget-log.js';
import { truncateText } from '../core/token-budget.js';
import { getAccessSummary } from '../store/access-feedback.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop, WorkLoopMemoryHit } from '../store/work-loop.js';
import { checkKnowledgeDrift, DriftCheckResult, getCurrentGitCommit, listChangedFilesSince, listRenamedPathsSince } from '../store/drift.js';
import { indexSkillPackage, recordSkillRun } from '../skills/knowledge-index.js';
import { createSkillPackage, listSkillPackages, readSkillPackage, runSkillPackage, SkillEntrypoint } from '../skills/registry.js';
import { approveSkill, listTrust, revokeSkill } from '../skills/trust.js';
import { auditKnowledgeStore } from '../store/integrity.js';
import { createSnapshot, restoreSnapshot } from '../store/snapshots.js';
import { isEvidenceStale, listEvidenceForItem, resolveSymbolEvidence } from '../store/evidence-repository.js';
import { rankKnowledge } from '../store/agent-query.js';
import { evaluateRetrieval, RetrievalEvaluationCase } from '../store/retrieval-evaluation.js';
import { getKnowledgeAccessReport } from '../store/access-feedback.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions, startMemorySession } from '../store/session-repository.js';
import { captureMemorySessionEvent } from '../store/session-capture.js';
import { finalizeMemorySession } from '../store/session-finalizer.js';
import { isLifecycleEvent, isSessionEventType, readLifecyclePayload, stringPayloadValue } from './agents/lifecycle.js';
import { runAgentHook } from './agent-hook.js';
import { assertDatabasePresentForCommand } from './database-presence.js';
import { bootstrapAgentSession } from '../store/context-bootstrap.js';
import { listAssertions } from '../store/assertions.js';
import { listActiveConflictKeys } from '../store/conflicts.js';
import { composeContext } from '../store/context-composer.js';
import { indexCode, listCodeSymbols } from '../code/symbol-index.js';
import { exportKnowledge, importKnowledge } from '../store/portability.js';
import { importOwnershipNotice } from './import-ownership-notice.js';
import { synthesizeKnowledge } from '../store/synthesis.js';
import { startViewer } from '../viewer/server.js';
import { createAgentReminderOutput } from './agents/reminder.js';
import { rebuildTranscriptIndex } from '../transcripts/backfill.js';
import { closeTranscriptDbs, openTranscriptDb } from '../transcripts/database.js';
import { isTranscriptSearchEnabled } from '../transcripts/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import {
  countCandidates,
  DEFAULT_EXTRACT_LIMIT,
  extractCandidates,
  listCandidates,
  planExtraction,
} from '../transcripts/extract-candidates.js';
import { APPROVE_ALL_LIMIT, approveCandidates, discardCandidates } from '../transcripts/approve-candidates.js';
import { applyTranscriptConfigTransition, describeTranscriptTeardown } from '../transcripts/teardown.js';

// Load environment variables (.env file)
// See the note in src/index.ts: dotenv 17 writes a banner to stdout unless told not to, and
// stdout here is a machine-readable channel.
dotenv.config({ quiet: true });

/**
 * Build the whole command tree, fresh.
 *
 * A factory rather than module-scope construction because three test files need to assert the
 * shape of the tree, and a module is a singleton — a second import returns the first instance,
 * already parsed. The body below is unchanged and deliberately not re-indented: this wrapper was
 * introduced as a pure move, and re-indenting three thousand lines would bury that in noise.
 */
export function buildProgram(): Command {

const program = new Command();

/**
 * One guard for every command, rather than one per call site.
 *
 * ~30 actions follow the same two lines -- resolve the root, open the store -- and opening
 * the store is what recreates a database that has gone missing. Checking inside each of them
 * means the next command added is the one that forgets. A `preAction` hook runs before any
 * of them, and the exemptions are named in `database-presence.ts` beside the reasoning.
 *
 * Synchronous so the entry can keep `program.parse`; commander only awaits hooks under
 * `parseAsync`, and moving the whole CLI onto it for one `stat` would be a larger change
 * than the check.
 */
program.hook('preAction', (_thisCommand, actionCommand) => {
  // The full path, top-level first, because exemption has to be able to name a single
  // subcommand: `snapshot restore` must run when the database is gone -- the guard's own
  // message prescribes it -- while `snapshot create` must not, since it opens the database
  // and opening one creates it. Collapsing to the top-level name exempted the whole group.
  const names: string[] = [];
  for (let node = actionCommand; node?.parent; node = node.parent) names.unshift(node.name());
  try {
    assertDatabasePresentForCommand(names.join(' '));
  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  }
});

function printProjectGuidanceStatus(status: KnowlProjectGuidanceInstallResult) {
  console.log(`KNOWL.md: ${status.knowl}`);
  console.log(`AGENTS.md: ${status.agents}`);
}

function printRelevantMemory(items: WorkLoopMemoryHit[]) {
  console.log(`Relevant memory:`);
  if (items.length === 0) {
    console.log(`- none`);
    return;
  }

  for (const item of items) {
    console.log(`- ${item.title} (${item.category}, ${item.id})`);
  }
}

function printPrCheckResult(result: DriftCheckResult) {
  console.log('KNOWL PR CHECK');
  console.log(`Since: ${result.sinceCommit}`);
  console.log(`Current: ${result.currentCommit || 'working tree'}`);
  console.log(`Changed files: ${result.changedFiles.length}`);
  console.log(`Review candidates: ${result.candidates.length}`);
  console.log(`Marked: ${result.updatedCount}`);

  for (const candidate of result.candidates) {
    console.log(`- NEEDS_REVIEW ${candidate.itemId} ${candidate.title}`);
    console.log(`  Paths: ${candidate.matchedPaths.join(', ')}`);
  }
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(' ');
}

function collectOption(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}

function parseSkillFiles(values: string[]): { path: string; content: string }[] {
  return values.map(value => {
    const index = value.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid --file value "${value}". Use path=content.`);
    }
    return {
      path: value.slice(0, index),
      content: value.slice(index + 1),
    };
  });
}

function createSkillEntrypoints(options: {
  script?: string;
  fallbackShell?: string;
}): Record<string, SkillEntrypoint> {
  const entrypoints: Record<string, SkillEntrypoint> = {};
  if (options.script) {
    entrypoints.default = {
      type: 'script',
      path: options.script,
      autoRun: true,
    };
  }
  if (options.fallbackShell) {
    entrypoints.fallback = {
      type: 'shell',
      command: options.fallbackShell,
      autoRun: true,
    };
  }
  return entrypoints;
}

function printUpgradeStatus(result: UpgradeResult) {
  console.log(`KNOWL repository upgrade complete.`);
  console.log(`Repository: ${result.project.rootPath}`);
  console.log(`Config: ${result.configStatus}`);
  printProjectGuidanceStatus(result.guidanceStatus);
  console.log(`.gitignore: ${result.gitignoreStatus}`);
  // Only when it did something: a line reading "claimed 0" on every upgrade of every
  // unlinked repo is noise, and this sweep is a one-time repair of older databases.
  if (result.claimedItems > 0) {
    console.log(`Ownership: claimed ${result.claimedItems} previously unowned item(s) for this repo`);
  }
  // Same rule, for the same reason: silent only when it did nothing. A store that gets
  // smaller must always be able to say why, and the first upgrade after this release is
  // where years of accumulation goes.
  const { commits, commitBytesFreed, sessions, claims } = result.retention;
  if (commits > 0) {
    console.log(`Retention: compacted ${commits} commit record(s) older than 90 days, freeing ${Math.round(commitBytesFreed / 1024)} KB of before/after snapshots`);
  }
  if (sessions > 0) console.log(`Retention: removed ${sessions} expired memory session(s)`);
  if (claims > 0) console.log(`Retention: removed ${claims} stale hook debounce file(s)`);

  // Gigabytes move here on the first upgrade after this release, so it says so in megabytes
  // and names anything it declined to decide about.
  const models = result.retention.models;
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (models.adopted > 0 || models.deduplicated > 0) {
    console.log(
      `Models: moved ${models.adopted} file(s) to the shared cache and dropped ` +
      `${models.deduplicated} already-shared duplicate(s), freeing ${mb(models.bytesFreed)} in this repo`,
    );
  }
  for (const conflict of models.conflicts) {
    console.log(`Models: kept both copies of ${conflict} -- the repo copy and the shared one differ in size`);
  }
  if (models.pruned.length > 0) {
    console.log(`Models: removed ${models.pruned.length} cached model(s) no repository names, freeing ${mb(models.prunedBytes)}`);
    for (const pruned of models.pruned) console.log(`        ${pruned}`);
  }
}

program
  .name('knowl')
  .description('KNOWL — A Knowledge Operating System for AI Agents')
  .version(PACKAGE_VERSION);

// --- 1. INIT COMMAND ---
program
  .command('init')
  .description('Initialize (or re-run on an existing repo to upgrade) and register agent integrations. On an existing project this performs `knowl upgrade` first, then agent setup.')
  .argument('[agents...]', 'Agent integrations to configure')
  .option('-y, --yes', 'Accept global configuration confirmations')
  .action(async (agents: string[], options) => {
    const cwd = process.cwd();
    const knowlDir = path.join(cwd, '.knowl');
    const name = path.basename(cwd) || 'My Project';

    try {
      parseAgentNames(agents);

      // The marker is `.knowl/config.json`, not the `.knowl` directory -- the rule
      // `isProjectRoot` already enforces everywhere else (K-51). Init was the last command
      // asking only whether the directory existed, and that made a repository whose
      // config.json is missing unrepairable: it routed to the upgrade path, which opens that
      // file first, so the user got a bare `ENOENT ... .knowl/config.json` naming a file they
      // never had -- identically on every re-run of the one command meant to fix it.
      //
      // A `.knowl` with no config.json is not exotic. An interrupted first init leaves one,
      // and so does a partly-completed removal: on Windows `fs.rm(recursive)` rejects on a
      // held libSQL file *after* unlinking that file's siblings, config.json among them.
      // Finishing the initialization is what the person typing `knowl init` is asking for.
      //
      // Reading the marker this way is also what makes init willing to write into a `.knowl`
      // it did not create, so the one directory that must never become a repository is now
      // refused by name, rather than by the accident of that same ENOENT.
      if (path.resolve(knowlDir) === knowlHome()) {
        throw new Error(
          `${knowlDir} is this machine's Knowl home, not a project. Run "knowl init" inside a repository.`
        );
      }
      // Existence is tested on `cwd` only, and `findProjectRoot` -- which walks ancestors --
      // was never consulted on the create path. So `knowl init` in a subpackage of an
      // initialized repository printed "Successfully initialized" and built a second store
      // inside it. Every later command run under that subtree then resolved to the shadow:
      // writes landed there, queries from the subtree returned nothing, and nothing anywhere
      // reported the split. Re-running init at the *root* already detects and upgrades; this
      // is that same question asked one directory further up.
      const enclosing = await findProjectRoot(cwd).catch(() => null);
      if (enclosing && path.resolve(enclosing) !== path.resolve(cwd)) {
        throw new Error(
          `${cwd} is inside the Knowl repository at ${enclosing}.\n` +
          'Initializing here would create a second store, and every command run below this ' +
          'directory would then read and write that one instead of the repository\'s -- ' +
          'silently, because both are valid.\n' +
          `  - to use the existing memory: run knowl commands from anywhere under ${enclosing}\n` +
          `  - to upgrade that repository: cd ${enclosing} && knowl init\n` +
          '  - if this really is a separate project, move it outside that repository first',
        );
      }

      const isExisting = await isProjectRoot(cwd);

      if (isExisting) {
        const result = await upgradeExistingRepository(cwd, name);
        console.log(`↻ Existing KNOWL project detected — upgrading, then checking agent setup: ${knowlDir}`);
        printUpgradeStatus(result);
        const flow = await runAgentInitFlow(cwd, {
          agentNames: agents,
          yes: options.yes,
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        });
        console.log(formatAgentInitSummary(flow.results));
        process.exitCode = flow.exitCode;
        return;
      }

      await fs.mkdir(knowlDir, { recursive: true });
      await fs.mkdir(path.join(knowlDir, 'skills'), { recursive: true });

      // Create default config.json. NEW_PROJECT_CONFIG, not DEFAULT_CONFIG: only a
      // brand-new repository gets a `preset`, because DEFAULT_CONFIG is also the
      // merge baseline that `knowl upgrade` applies to every existing one.
      const defaultConfig = NEW_PROJECT_CONFIG;

      await fs.writeFile(
        path.join(knowlDir, 'config.json'),
        JSON.stringify(defaultConfig, null, 2),
        'utf-8'
      );

      // Bootstrap SQLite database
      await initDb(cwd);
      await repo.createProject(cwd, name);
      await closeDb();
      // Recorded here as well as in `upgrade`, so a repository is reachable by a machine-wide
      // sweep from the moment it exists rather than only after its first upgrade.
      await recordKnownRepo(cwd);
      const guidanceStatus = await installKnowlProjectGuidance(cwd);
      const gitignoreStatus = await installKnowlGitignoreEntry(cwd);

      console.log(`🎉 Successfully initialized KNOWL repository!`);
      console.log(`📂 Created: ${knowlDir}`);
      printProjectGuidanceStatus(guidanceStatus);
      if (gitignoreStatus === 'created') {
        console.log(`Created .gitignore with .knowl/ entry.`);
      } else if (gitignoreStatus === 'updated') {
        console.log(`Updated .gitignore with .knowl/ entry.`);
      }
      console.log(`⚙️  Local project store ready.`);

      // Fetch the embedding model now. Write-time embedding never downloads, so without
      // this every item written before the first query stays invisible to semantic search.
      const warm = await warmEmbeddingModel(cwd, defaultConfig, { log: message => console.log(message) });
      const warmMessage = formatWarmResult(warm);
      if (warmMessage) console.log(warmMessage);

      console.log(`👉 Run "knowl status" to see repository status.`);
      const flow = await runAgentInitFlow(cwd, {
        agentNames: agents,
        yes: options.yes,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      });
      console.log(formatAgentInitSummary(flow.results));
      process.exitCode = flow.exitCode;
    } catch (error: any) {
      console.error(`❌ Error initializing KNOWL: ${error.message}`);
      process.exit(1);
    }
  });

// --- 2. STATUS COMMAND ---
program
  .command('status')
  .description('Show the status of the current KNOWL repository')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);

      // Before this command opens its own context, deliberately. `cloudStatus` owns a
      // process-wide one -- it opens and closes -- so calling it inside the block below would
      // close the database out from under everything after it. Constraint `defde27f6f234535` is
      // about the MCP path; this is the same hazard on the CLI path.
      const cloud = cloudPointer(config) ? await cloudStatus(root, config) : null;

      await initDb(root);

      const project = await repo.getProjectByRootPath(root);
      if (!project) {
        throw new Error('Project not registered in the database.');
      }

      const activeItems = await queryKnowledgeBase(project.id, { status: 'active' });
      const supersededItems = await queryKnowledgeBase(project.id, { status: 'superseded' });
      const deprecatedItems = await queryKnowledgeBase(project.id, { status: 'deprecated' });
      const commits = await repo.getKnowledgeCommits(project.id, 5);

      console.log(formatStatusReport({
        project,
        config,
        workspace: await resolveWorkspace(root, config),
        activeItems,
        supersededItems,
        deprecatedItems,
        commits,
        capture: await captureHealth(),
        captureNudgeMode: captureNudgeMode(config),
        cloud,
      }));

      if (isUpdateCheckEnabled(config)) {
        const update = await checkForUpdate({ packageName: PACKAGE_NAME, currentVersion: PACKAGE_VERSION, projectRoot: root });
        if (update?.updateAvailable) console.log(formatUpdateNotice(update, PACKAGE_NAME));
      }

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Error reading status: ${error.message}`);
      process.exit(1);
    }
  });

// --- 3. STATE COMMAND ---
program
  .command('state')
  .description('Print the full hierarchical active knowledge state of the project')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);

      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const hierarchy = await getHierarchicalKnowledge(project.id);
      const md = formatHierarchyToMarkdown(hierarchy, { maxChars: Number.MAX_SAFE_INTEGER, maxItemChars: Number.MAX_SAFE_INTEGER });
      console.log(md);

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Error fetching project state: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('resume')
  .argument('[key]', 'The key you were given when the work was parked')
  .description('Resume a parked workstream, or list what is parked here')
  .action(async (key?: string) => {
    try {
      // Resuming by key must work from anywhere, including a directory that is not a Knowl
      // project at all -- parked work lives in the Knowl home, not in any repo. Only the
      // "what did I leave here" listing needs a project, so only it resolves one.
      const root = key ? undefined : await findProjectRoot(process.cwd()).catch(() => undefined);
      const result = await runCliResume({ projectRoot: root, key });
      if (result.kind === 'unknown-key') {
        console.error(result.text);
        process.exitCode = 1;
      } else {
        console.log(result.text);
      }
      await closeResumeDb();
    } catch (error: any) {
      console.error(`Error resuming: ${error.message}`);
      process.exit(1);
    }
  });

/** Shared by `park` and `handoff`: both take the same optional brief around a required goal. */
const briefOptions = (command: Command): Command => command
  .option('--completed <item...>', 'What is already done')
  .option('--blocker <blocker>', 'What is in the way, if anything')
  .option('--artifact <path...>', 'Files the returning session should look at')
  .option('--verified', 'The work so far was checked')
  .option('--unverified', 'The work so far was not checked');

const verificationOf = (options: { verified?: boolean; unverified?: boolean }): 'verified' | 'unverified' | undefined =>
  options.verified ? 'verified' : options.unverified ? 'unverified' : undefined;

briefOptions(
  program
    .command('park')
    .description('Park a workstream you mean to return to, and get a key back')
    .requiredOption('--goal <goal>', 'What this workstream is trying to achieve')
    .option('--next-action <action>', 'The next step as it stands now'),
).action(async options => {
  try {
    const root = await findProjectRoot(process.cwd());
    const point = await createResumePoint(root, {
      goal: options.goal,
      completed: options.completed,
      nextAction: options.nextAction,
      blocker: options.blocker,
      artifactRefs: options.artifact,
      verificationStatus: verificationOf(options),
    });
    // Printed verbatim and unwrapped: a key reworded is a key lost, and handing it back is the
    // whole point of the command.
    console.log(`Parked. To pick this up later, from anywhere:\n\n    knowl resume ${point.key}\n`);
    await closeResumeDb();
  } catch (error: any) {
    console.error(`Error parking work: ${error.message}`);
    process.exit(1);
  }
});

briefOptions(
  program
    .command('handoff')
    .description('Leave a baton for the next session in this project')
    .requiredOption('--goal <goal>', 'What this workstream is trying to achieve')
    .requiredOption('--next-action <action>', 'The single next thing to do'),
).action(async options => {
  try {
    const root = await findProjectRoot(process.cwd());
    await initDb(root);
    try {
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const { handoff, replacedPrevious } = await recordDeliberateHandoff(project.id, {
        // Filed under the host whose hooks deliver a baton on session start, matching the MCP
        // path: a CLI invocation has no host session of its own to name.
        host: 'claude',
        projectRoot: root,
        externalSessionId: 'cli',
        taskState: {
          goal: options.goal,
          nextAction: options.nextAction,
          completed: options.completed,
          blocker: options.blocker,
          artifactRefs: options.artifact,
          verificationStatus: verificationOf(options) ?? 'unverified',
        },
      });

      // One baton per project. Said out loud, because the previous one's goal, next action and
      // blocker are gone and nothing else would mention it.
      if (replacedPrevious) {
        console.log('Replaced the previous unconsumed handoff — its goal, next action and blocker are gone.');
      }
      console.log('Handed off. The next session in this project receives this once, then it is archived.');
      console.log(`\n${formatPendingHandoffContext(handoff)}`);
    } finally {
      await closeDb();
    }
  } catch (error: any) {
    console.error(`Error handing off: ${error.message}`);
    process.exit(1);
  }
});

program.command('timeline').argument('<itemId>').description('Show the recorded history of one knowledge item').action(async itemId => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listAssertions(itemId), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading timeline: ${error.message}`); process.exit(1); }
});

/**
 * How a `--json` command reports failure: an envelope on stdout, still exit 1.
 *
 * These flags exist for agent host hooks, and a hook parses stdout. Every failure used to be
 * a plain-text line on stderr with stdout left empty, so the machine contract held on success
 * and vanished exactly when the caller most needed to know what happened -- `JSON.parse('')`
 * in the hook, on top of whatever went wrong here. One case (`agent-event session-event`)
 * already returned a structured `{"accepted":false,...}`, proving the envelope was the intent;
 * this makes it the rule.
 */
function reportCommandFailure(json: boolean | undefined, label: string, error: { message?: unknown }): never {
  const message = `${label}: ${String(error?.message ?? error)}`;
  // stderr always carries the human line -- that is where a person and the existing tests look.
  // Under --json, stdout ALSO gets a parseable envelope, because these commands are host hooks
  // and a hook parses stdout; before, failure left it empty and the hook got `JSON.parse('')`.
  // Both streams, not one or the other: the message is identical and safe to repeat (the secret
  // scanner has already stripped any secret from it before it reaches here).
  console.error(message);
  if (json) console.log(JSON.stringify({ error: { message } }));
  process.exit(1);
}

/**
 * A numeric option is either a number or a refusal -- never `NaN`.
 *
 * `Number(options.limit)` on a typo produced `NaN`, which flowed straight into a bound
 * parameter: `knowl query x --limit abc` printed the raw FTS statement and `params: ...,NaN`.
 * The `gc` flags were worse than noisy -- every comparison against `NaN` is false, so a
 * mistyped `--stale-days` made `knowl gc --apply` a silent no-op that reported success.
 * `context --token-budget` already validated; this is that rule applied everywhere else.
 */
function numericOption(raw: unknown, flag: string, { min = 1 }: { min?: number } = {}): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${flag} must be a number >= ${min}; received "${String(raw)}".`);
  }
  return value;
}

/**
 * An unparseable `--as-of` used to mean "now", which is the one answer it must never give.
 *
 * Assertion validity is compared as SQLite *strings*, so `'banana'` sorts above every ISO
 * timestamp and matched every row -- the feature whose entire purpose is "what did we believe
 * on date X" answered with today's state and said nothing. An empty string fell off the
 * temporal path altogether and silently took the ranker branch instead, returning a different
 * shape and a different count.
 */
function timestampOption(raw: unknown, flag: string): string | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text || Number.isNaN(Date.parse(text))) {
    throw new Error(`${flag} must be an ISO-8601 timestamp; received "${String(raw)}".`);
  }
  return text;
}

program.command('query').argument('[query]').description('Search project memory by keywords').option('--as-of <timestamp>').option('--limit <count>').action(async (query, options) => {
  try {
    const root = await findProjectRoot(process.cwd());
    await initDb(root);
    const project = await repo.getProjectByRootPath(root);
    if (!project) throw new Error('Project not found in database.');
    const limit = numericOption(options.limit, '--limit');
    const asOf = timestampOption(options.asOf, '--as-of');

    // One engine, whether or not this repo is linked and whether an agent or a human asked.
    // The ranking used to differ on both axes: this command read queryKnowledgeBase directly
    // while knowl_query used the shared ranker, and the workspace branch used the ranker while
    // the solo branch did not -- the same command disagreeing with itself.
    const { items, groups, unshown, shape, skipped } = await runCliQuery({
      projectRoot: root, projectId: project.id, query, limit, asOf,
    });

    // Keyed by repo the moment a linked repo contributes a row, and a bare array otherwise --
    // the same rule the MCP surface follows, so a human and an agent are told the same thing in
    // the same way. An empty group under this repo's own name is what says it holds nothing.
    if (shape === 'grouped') {
      console.log(JSON.stringify(Object.fromEntries(groups.map(group => [group.repo, group.items])), null, 2));
      const mine = groups.find(group => group.items.length === 0);
      if (mine) {
        console.error(`Note: "${mine.repo}" (this repo) returned nothing. The results above belong to `
          + `${groups.filter(group => group.items.length).map(group => `"${group.repo}"`).join(', ')} `
          + 'and describe those repos, not this one.');
      }
    } else {
      console.log(JSON.stringify(items, null, 2));
    }
    // The floor's verdict, said out loud. Results below it are printed rather than withheld,
    // so without this line a weak page looks exactly like a strong one.
    if (items.some((item: { abstained?: boolean }) => item.abstained)) {
      console.error('Note: every result scored below the relevance floor — this store probably does not hold the answer. Read "score" and judge.');
    }
    // Names and counts, never content: the knowledge stays findable without this line being
    // able to stand in for it.
    if (unshown.length) {
      const described = unshown.map(entry => `"${entry.repo}" (${entry.matches})`).join(', ');
      console.error(`Note: linked repos also hold matches not shown here: ${described}. Re-run with --limit raised to see more.`);
    }
    for (const skip of skipped) {
      console.error(`Note: linked repo "${skip.repo}" was not searched (${skip.reason}).`);
    }
    await closeDb();
  } catch (error: any) { console.error(`Error querying knowledge: ${error.message}`); process.exit(1); }
});

program.command('conflicts').description('List knowledge items that contradict each other').action(async () => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify((await listActiveConflictKeys()).map(item => ({ id: item.id, title: item.title, conflictKey: item.conflictKey, conflictScope: item.conflictScope, freshness: item.freshness })), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error listing conflicts: ${error.message}`); process.exit(1); }
});

program.command('supersede').argument('<itemId>').argument('<replacementId>').description('Retire one item and point it at its replacement').action(async (itemId, replacementId) => {
  try {
    const root = await findProjectRoot(process.cwd());
    await initDb(root);
    // Only the first id was ever checked -- `supersedeKnowledgeItem` verifies the item being
    // retired and takes the replacement on trust. So `supersede <id> <id>` pointed an item at
    // itself, and a typo'd replacement stored a dangling `superseded_by_id`. Both retire the
    // item out of every query, and `knowl audit` reports neither: integrity only walks
    // dependent tables keyed by `knowledge_item_id` and never looks at `superseded_by_id`.
    if (itemId === replacementId) {
      throw new Error('An item cannot supersede itself; name the replacement that takes its place.');
    }
    if (!(await repo.getKnowledgeItem(replacementId))) {
      throw new Error(`No knowledge item "${replacementId}" to supersede with. Nothing was retired.`);
    }
    console.log(JSON.stringify(await repo.supersedeKnowledgeItem(itemId, replacementId), null, 2));
    await closeDb();
  } catch (error: any) { console.error(`Error superseding knowledge: ${error.message}`); process.exit(1); }
});

program.command('context').description('Print a token-budgeted context pack for an agent').option('--query <query>').option('--task <task>').requiredOption('--token-budget <budget>').action(async options => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await composeContext(project.id, { query: options.query, task: options.task, tokenBudget: Number(options.tokenBudget), namespaceRoot: root }), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error composing context: ${error.message}`); process.exit(1); }
});

/**
 * Rejected rather than coerced. A misspelled `--default-visibility` that fell back to `repo`
 * would look like it worked and quietly keep publishing nothing; one that fell back to
 * `workspace` would publish without being asked. Neither default is safe, so there is none.
 */
function parseDefaultVisibility(value: string | undefined): 'workspace' | 'repo' | undefined {
  if (value === undefined) return undefined;
  if (value === 'workspace' || value === 'repo') return value;
  throw new Error(`--default-visibility must be "repo" or "workspace", not "${value}".`);
}

/**
 * Names 5.0 removed, kept only so they can say where they went.
 *
 * These are NOT aliases: each exits non-zero and runs nothing. The whole cost of a hard break is
 * that a familiar command stops working, and the difference between "unknown command" and
 * "moved to `knowl cloud stage`" is the difference between a dead end and a redirect.
 *
 * Hidden, so they are absent from help — the surface is the new one. Commander still keeps them
 * in `.commands`, which is why the tree test asserts help output rather than that array.
 */
for (const [gone, replacement] of [
  ['login', 'knowl cloud login'],
  ['logout', 'knowl cloud logout'],
  ['publish', 'knowl cloud stage'],
] as const) {
  program
    .command(gone, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(`\`knowl ${gone}\` moved to \`${replacement}\`.`);
      process.exit(1);
    });
}

/**
 * Every failure in this group sets `process.exitCode` and returns. None of them calls
 * `process.exit`, and that is deliberate.
 *
 * A cloud verb can have loaded the embedder before it fails: staging and pushing build vectors,
 * connect compares profiles, pull decides what still needs embedding. Calling `process.exit(1)`
 * there tears the process down while the runtime's async handle is mid-close, and libuv aborts on
 * the way out:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *
 * The abort wins the race, so the shell sees **127** rather than 1. That is worse than an
 * arbitrary wrong number, because 127 conventionally means "command not found" — so the first
 * thing anyone debugging it checks is their PATH and their install, neither of which is the
 * problem. Measured, not guessed: 3/3 aborts on `cloud push` against a mismatched workspace,
 * while the same command on its success path exits 0 clean, which is what pins it to the exit
 * and not to the command. `cloud retract`'s failure exits 1 clean because that path never loads
 * the embedder, and a bare `cloud stage` refuses before loading it too.
 *
 * Setting `exitCode` lets the loop drain and the handles close on their own, and the process ends
 * with 1 the way every other error path in this file already does.
 *
 * **The `return` is load-bearing.** `process.exit` stopped the command as a side effect; setting
 * a code does not. Every conversion here is a guard with code after it, so dropping the return
 * would carry on past a refusal — a worse bug than the one being fixed.
 * `tests/cli/cloud-exit-codes.test.ts` holds that invariant.
 *
 * Scoped to this group on purpose. The other command groups exit from paths that never touch the
 * embedder, and rewriting sixty-odd call sites to fix two would be a diff nobody can review.
 */
const cloudCommand = program.command('cloud').description('Publish to and read from a Knowl Cloud workspace');

cloudCommand
  .command('login')
  .description('Sign in to Knowl Cloud')
  .option('--api <host>', 'API host (defaults to $KNOWL_API_HOST, else the hosted service)', defaultApiHost())
  .option('--force', 'Re-authenticate even if this machine is already signed in')
  .action(async options => {
    try {
      const result = await runLogin({
        apiHost: options.api,
        force: options.force,
        onPrompt: authorization => {
          // The server does not send `verificationUri` yet. Naming the API host is a worse
          // instruction than a real approval URL and a far better one than "Open undefined",
          // which is what printing the absent field produced.
          const where = authorization.verificationUri ?? `${options.api} (approve in the web console)`;
          console.log(`\nOpen ${where} and enter this code:\n`);
          console.log(`    ${authorization.userCode}\n`);
          console.log('Waiting for approval...');
        },
      });
      if (result.status === 'already-signed-in') {
        console.log(result.identity
          ? `Already signed in as ${result.identity.displayName} <${result.identity.email}> at ${options.api}.`
          : `Already signed in at ${options.api}. Run with --force to re-authenticate.`);
        return;
      }
      if (result.status === 'expired') {
        console.error('The code expired before it was approved. Run knowl cloud login again.');
        process.exitCode = 1;
        return;
      }
      console.log(`Signed in to ${options.api}.`);
    } catch (error: any) {
      console.error(`Login failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('logout')
  .description('Clear stored Knowl Cloud credentials')
  .option('--api <host>', 'API host (defaults to $KNOWL_API_HOST, else the hosted service)', defaultApiHost())
  .action(async options => {
    const { wasLoggedIn } = await runLogout(options.api);
    console.log(wasLoggedIn ? `Signed out of ${options.api}.` : `Not signed in to ${options.api}.`);
  });

cloudCommand
  .command('workspaces')
  .description('List the cloud workspaces this machine can reach')
  .option('--api <host>', 'API host (defaults to $KNOWL_API_HOST, else the hosted service)', defaultApiHost())
  .action(async options => {
    try {
      const api = createCloudApi({ apiHost: options.api });
      // Refreshed rather than read. A stored access token lives about an hour, so reading it
      // straight sent a dead one and reported "The credential is not valid" to somebody who was
      // signed in perfectly well. Every other network path already refreshes.
      const credential = await ensureAccessToken({
        apiHost: options.api,
        refresh: refreshToken => api.refresh(refreshToken),
      });
      if (!credential) {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exitCode = 1;
        return;
      }
      const workspaces = await api.listWorkspaces(credential.accessToken);
      if (workspaces.length === 0) {
        console.log('You do not belong to any workspace yet.');
        return;
      }
      for (const workspace of workspaces) {
        console.log(`  ${workspace.id}  ${workspace.name}  (${workspace.role})`);
      }
    } catch (error: any) {
      console.error(`Listing workspaces failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('stage')
  .description('Stage knowledge for publication to the connected cloud workspace')
  .option('--id <ids...>', 'Item ids to stage')
  .option('--category <list>', 'Comma-separated categories (quote the list on Windows)')
  .option('--apply', 'Actually stage; without this the command is a dry run')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);

      // Checked before the picker rather than after, so a disconnected repo gets the one answer
      // that helps instead of a prompt about a destination it does not have.
      //
      // `exitCode` and return, never `process.exit`: a cloud verb can have loaded the embedder
      // before it fails, and exiting there aborts with UV_HANDLE_CLOSING and reports 127. Pinned
      // by `tests/cli/cloud-exit-codes.test.ts`, which reads this source.
      const pointer = cloudPointer(config);
      if (!pointer) {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exitCode = 1;
        return;
      }

      // A bare call asks instead of refusing. Flags mean the caller already knows what they want.
      let picked: KnowledgeCategory[] | undefined;
      let interactive = false;
      if (!options.category && !options.id) {
        await initDb(root);
        let counts;
        try {
          counts = await countStageable(
            pointer.workspaceId,
            config.workspace?.repo ?? pointer.repo,
          );
        } finally { await closeDb(); }

        if (recommendedTotal(counts) === 0) {
          const held = Object.values(counts).reduce((sum, n) => sum + n, 0);
          console.log('Everything worth sharing by default is already staged or sent.');
          if (held > 0) {
            console.log(`${held} item(s) remain in ${WITHHELD_BY_DEFAULT.join(' and ')}, which are held back on purpose.`);
            console.log(`Stage them anyway with --category "${WITHHELD_BY_DEFAULT.join(',')}".`);
          }
          return;
        }

        const chosen = await pickCategories({
          verb: 'stage',
          destination: pointer.workspaceName ?? pointer.workspaceId,
          counts,
        });
        if (chosen === null) {
          if (!process.stdin.isTTY) {
            const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
            throw new Error(
              'Specify what to stage with --category <list> or --id <id>. '
              + `${total} item(s) are unstaged; a bare stage would queue all of them for the team.`,
            );
          }
          console.log('Nothing staged.');
          return;
        }
        if (chosen.length === 0) {
          console.log('Nothing selected, so nothing was staged.');
          return;
        }
        picked = chosen;
        interactive = true;
      }

      const result = await stagePublish({
        projectRoot: root,
        config,
        ids: options.id,
        categories: picked ?? options.category?.split(',').map((entry: string) => entry.trim()),
        // The picker's confirmation IS the apply, as it is for promote.
        apply: interactive || options.apply,
      });

      if (result.status === 'not-connected') {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exitCode = 1;
        return;
      }
      for (const item of result.items) console.log(`  ${item.category}  ${item.title}`);
      if (result.skippedForeign > 0) {
        console.log(`${result.skippedForeign} item(s) belong to another repo and can only be published from it.`);
      }
      // Named rather than silent, for the same reason `skippedForeign` is: a sweep that stages
      // fewer atoms than the category holds looks identical to one that found nothing.
      if (result.skippedExcluded > 0) {
        console.log(`${result.skippedExcluded} item(s) are excluded from publication. Name an id to stage one anyway.`);
      }
      // `applied` is false for two different reasons -- a dry run, and a real run that matched
      // nothing -- so branching on it alone told a user who had just passed --apply to pass
      // --apply. Nothing eligible is its own outcome and says so.
      if (result.items.length === 0) {
        console.log('Nothing to stage: no eligible item matched.');
      } else {
        console.log(result.applied
          ? `Staged ${result.items.length} item(s). Run knowl cloud push to send them.`
          : `${result.items.length} item(s) would be staged. Re-run with --apply.`);
      }
      if (result.applied) console.log('Once pushed, removing it again takes knowl cloud retract, which is irreversible.');

      if (result.applied) {
        // Only with standing consent, an open gate and an unchanged snapshot. Reported when it
        // fires, because a send that happened silently is the thing consent is trusted not to be.
        const auto = await maybeAutoPush({ projectRoot: root, config });
        if (auto.status === 'pushed') {
          console.log(`Auto-push is on: sent ${auto.created} new and ${auto.updated} updated item(s).`);
        } else if (auto.status === 'failed') {
          console.error(`Auto-push did not send (${auto.detail}). Everything stays staged; run knowl cloud push.`);
        }
      }
    } catch (error: any) {
      console.error(`Staging failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('autopush')
  .argument('<state>', 'on or off')
  .description('Turn automatic pushing on or off, for this machine only')
  .action(async (state: string) => {
    if (state !== 'on' && state !== 'off') {
      console.error('Expected on or off.');
      process.exitCode = 1;
      return;
    }
    const root = await findProjectRoot(process.cwd());
    const config = await loadConfig(root);
    const pointer = cloudPointer(config);
    if (!pointer) {
      console.error('This repository is not connected to a cloud workspace.');
      process.exitCode = 1;
      return;
    }
    await writeAutoPushConsent(pointer.workspaceId, state === 'on');
    const workspace = pointer.workspaceName ?? pointer.workspaceId;
    console.log(state === 'on'
      // Said plainly because the whole design turns on it: this is not a project setting and
      // does not travel to anyone else.
      ? `Automatic push enabled for ${workspace} on this machine.\nIt applies to you only — it is not committed and no teammate inherits it.`
      : `Automatic push disabled for ${workspace}.`);
  });

cloudCommand
  .command('unstage')
  .argument('<id>', 'The item to take out of the queue')
  .description('Take an atom out of the push queue. Does not unpublish it')
  .option('--forever', 'Also exclude it, so nothing stages it again automatically')
  .action(async (id: string, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const pointer = cloudPointer(config);
      if (!pointer) {
        console.error('This repository is not connected to a cloud workspace.');
        process.exitCode = 1;
        return;
      }
      await initDb(root);
      try {
        const cleared = await unstagePublish(id, pointer.workspaceId);
        if (options.forever) await excludeFromPublish(id, 'knowl cloud unstage --forever');
        console.log(cleared ? `Unstaged ${id}.` : `${id} was not staged.`);
        if (options.forever) {
          console.log('It will not be staged again automatically. Naming its id to knowl cloud stage still stages it.');
        }
      } finally {
        await closeDb();
      }
    } catch (error: any) {
      console.error(`Unstage failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('connect')
  .description('Point this repository at a cloud workspace (publishes nothing)')
  .option('--api <host>', 'API host (defaults to $KNOWL_API_HOST, else the hosted service)', defaultApiHost())
  .option('--workspace <id>', 'Workspace id, when you belong to more than one')
  // No default value on purpose. Commander would then make `--remote origin` and no flag at all
  // indistinguishable, and they mean different things: a remote you named and haven't got is a
  // typo, while no origin on a project that was never pushed anywhere is not a problem.
  .option('--remote <name>', 'Git remote to derive the project identity from (default: origin)')
  .option('--repo <name>', 'Name this project yourself, for one with no git remote')
  .option('--no-auto-stage', 'Do not stage new knowledge automatically; stage it explicitly instead')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const connectInput = {
        projectRoot: root,
        apiHost: options.api,
        workspaceId: options.workspace as string | undefined,
        remote: options.remote,
        repo: options.repo,
      };

      // Shared by both entry paths -- the first attempt and the one that follows a pick -- so a
      // connection made through the picker reports exactly what a direct one does.
      const reportConnected = async (connected: Extract<Awaited<ReturnType<typeof runConnect>>, { status: 'connected' }>) => {
        // Written after the pointer, not before: `runConnect` writes config itself, so setting
        // this first would be overwritten by the connect it is meant to qualify.
        if (options.autoStage === false) {
          const current = await loadConfig(root);
          if (current.cloud) {
            await saveConfig(root, { ...current, cloud: { ...current.cloud, autoStage: false } });
          }
        }
        console.log(`Connected ${connected.pointer.repo} to ${connected.pointer.workspaceName} as ${connected.role}.`);
        // Only when nobody chose the name. Saying where it came from matters here because a folder
        // name is not unique across machines, and the fix is a flag the user may not know exists.
        if (!connected.pointer.remote && !options.repo) {
          console.log('That name came from the project directory, as there is no git remote to read.');
          console.log('Pass --repo <name> to publish under something else.');
        }
        console.log(options.autoStage === false
          ? 'Nothing has been published, and new knowledge will not stage itself. Use knowl cloud stage.'
          : 'Nothing has been published. New knowledge stages itself; send it with knowl cloud push.');
      };

      const result = await runConnect(connectInput);

      if (result.status === 'not-logged-in') {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'no-workspaces') {
        console.error('You are signed in but do not belong to any workspace yet.');
        console.error('Ask a workspace owner to invite you, or create one in the web console.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'unknown-workspace') {
        console.error(`No workspace with id "${result.workspaceId}". You belong to:`);
        for (const entry of result.workspaces) console.error(`  ${entry.id}  ${entry.name} (${entry.role})`);
        process.exitCode = 1;
        return;
      }
      if (result.status === 'ambiguous') {
        // The list is already in hand -- `runConnect` fetched it to discover the ambiguity -- so
        // offering it beats refusing with it.
        const chosen = await pickWorkspace(result.workspaces);
        if (!chosen) {
          // No TTY, or the user backed out. Same remedy either way, and the same one this
          // command gave before the picker existed.
          console.error('You belong to more than one workspace. Re-run with --workspace <id>:');
          for (const entry of result.workspaces) console.error(`  ${entry.id}  ${entry.name} (${entry.role})`);
          process.exitCode = 1;
          return;
        }
        // Re-entered with the choice made, rather than writing the pointer here as well.
        const confirmed = await runConnect({ ...connectInput, workspaceId: chosen });
        if (confirmed.status !== 'connected') {
          console.error(`Connect failed after choosing a workspace: ${confirmed.status}`);
          process.exitCode = 1;
          return;
        }
        await reportConnected(confirmed);
        return;
      }
      if (result.status === 'profile-mismatch') {
        // Nothing has been written: the pointer is only saved once the profiles agree, so this
        // repository is left exactly as it was rather than connected-but-unable-to-publish.
        console.error(formatProfileMismatch(result));
        // `exitCode` rather than `exit(1)`: this path has loaded the embedder, and tearing the
        // process down while its async handle is mid-close aborts with a native assertion
        // (`UV_HANDLE_CLOSING`) that reports 127 -- which conventionally means "not found" and
        // sends whoever debugs it somewhere else entirely. Letting the loop drain exits 1.
        process.exitCode = 1;
        return;
      }
      if (result.status === 'identity-changed') {
        console.error(`This project publishes as "${result.current}", but now resolves to "${result.next}".`);
        console.error('Anything already pushed stays filed under the old name, and the server will');
        console.error('refuse writes to it from a different one. To keep publishing as before:');
        console.error(`  knowl cloud connect --repo ${result.current}`);
        console.error('Re-run with the new name only if you mean to start a separate history.');
        process.exitCode = 1;
        return;
      }

      await reportConnected(result);
    } catch (error: any) {
      console.error(`Connect failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('pull')
  .description('Fetch team knowledge into this machine\'s local replica')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const result = await runPull({ projectRoot: root, config });

      if (result.status === 'not-connected') {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'not-logged-in') {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exitCode = 1;
        return;
      }

      const { sync } = result;
      console.log(
        `Pulled ${sync.upserted} update(s) and ${sync.deleted} deletion(s) over ${sync.pages} page(s).`,
      );
      if (sync.status === 'incomplete') {
        console.log('The traversal did not finish; run knowl cloud pull again to resume.');
      }
      if (sync.status === 'resynced') {
        console.log('The local replica was older than the server retains, so it was rebuilt from scratch.');
      }
    } catch (error: any) {
      console.error(`Pull failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('push')
  .description('Send staged knowledge, once its code is on the default branch')
  .option('-y, --yes', 'Skip the confirmation. Required when there is no terminal to ask')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);

      // Captured before anything is shown, and sent unchanged. A live re-read at send time is
      // the window this closes: with auto-staging on, another process writes to this queue
      // continuously.
      const snapshot = await computePushSnapshot({ projectRoot: root, config });
      const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

      // Before the prompt, not after it. `snapshot.items` omits atoms with no vector, so showing
      // the prompt first would ask a user to confirm a shorter list than they staged and then
      // refuse the push anyway. Nothing is lost either way -- they stay staged -- but being told
      // now, with the command that fixes it, is the difference between an answer and a puzzle.
      if (snapshot.unembedded.length > 0) {
        console.error(
          `${snapshot.unembedded.length} staged item(s) have no vector for this repository's `
          + 'embedding profile, so nothing was sent.\n'
          + 'Run `knowl reindex --vectors`, then push again.',
        );
        process.exitCode = 1;
        return;
      }

      if (snapshot.items.length > 0 && !options.yes) {
        if (!isTTY) {
          // A prompt that cannot be answered must not block CI, and silence must not be read
          // as consent for something irreversible.
          console.error(`${snapshot.items.length} item(s) would be sent. Re-run with --yes to confirm.`);
          process.exitCode = 1;
          return;
        }
        console.log(`About to send ${snapshot.items.length} item(s) to ${config.cloud?.workspaceName ?? 'the workspace'}:`);
        for (const entry of snapshot.items) console.log(`  ${entry.payload.category}  ${entry.payload.title}`);
        console.log('Sending is irreversible: undoing it means knowl cloud retract, a hard delete.');

        const clack = await import('@clack/prompts');
        const ok = await clack.confirm({ message: 'Send these?' });
        if (clack.isCancel(ok) || !ok) {
          console.log('Nothing sent. Everything stays staged.');
          return;
        }
      }

      const result = await pushStaged({ projectRoot: root, config, snapshot, strict: true });

      if (result.status === 'not-connected') {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'not-logged-in') {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'snapshot-stale') {
        console.error('The queue changed while you were deciding, so nothing was sent.');
        if (result.changed.length > 0) console.error(`  ${result.changed.length} listed item(s) were edited.`);
        if (result.added.length > 0) console.error(`  ${result.added.length} new item(s) were staged.`);
        console.error('Run knowl cloud push again to see the current list.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'forbidden') {
        console.error(`You are a ${result.role} in this workspace, which cannot publish.`);
        process.exitCode = 1;
        return;
      }
      if (result.status === 'needs-embedding') {
        // Nothing is lost: they stay staged and go out on the next push. Said out loud because a
        // push that quietly sent nothing would look like success.
        console.error(
          `${result.count} staged item(s) have no vector for this repository's embedding profile, `
          + 'so nothing was sent.\n'
          + `Run \`${result.remedy}\`, then push again.`,
        );
        process.exitCode = 1;
        return;
      }

      console.log(`Published ${result.created} new and ${result.updated} updated item(s).`);
      for (const outcome of result.conflicts) {
        console.log(`  conflict  ${outcome.id} -- the workspace has a newer version. Pull, re-read, and publish again.`);
      }
      for (const outcome of result.rejected) {
        console.log(`  ${outcome.status}  ${outcome.id} -- retrying will not help; these stay staged.`);
      }
    } catch (error: any) {
      console.error(`Push failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('retract <id>')
  .description('Remove a published atom from the workspace. Irreversible, and works from any branch')
  .requiredOption('--reason <text>', 'Why it is being removed; stored on the tombstone')
  .action(async (id, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const result = await retractItem({ projectRoot: root, config, itemId: id, reason: options.reason });

      if (result.status === 'not-connected') {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'not-logged-in') {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exitCode = 1;
        return;
      }
      if (result.status === 'forbidden') {
        console.error(`You are a ${result.role} in this workspace, which cannot remove knowledge.`);
        process.exitCode = 1;
        return;
      }
      if (result.status === 'not-published') {
        console.error(`${id} was never pushed from this machine, so there is nothing in the workspace to remove.`);
        process.exitCode = 1;
        return;
      }
      if (result.status === 'conflict') {
        console.error(
          `${id} changed in the workspace after this machine published it (now version ${result.currentVersion}).`,
        );
        console.error('Run knowl cloud pull, read what it says now, and retract again if it should still go.');
        process.exitCode = 1;
        return;
      }

      console.log(`Removed ${id} from the workspace. Teammates lose it on their next sync.`);
      console.log('This cannot be undone, and the id can never be published again.');
    } catch (error: any) {
      console.error(`Retract failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

cloudCommand
  .command('status')
  .description('Report the workspace, the replica and what is staged (makes no network call)')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      console.log(formatCloudStatus(await cloudStatus(root, config)));
    } catch (error: any) {
      console.error(`Status failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  });

const workspaceCommand = program.command('workspace').description('Link several repositories so agents can read across them');

workspaceCommand
  .command('init')
  .argument('<name>')
  .description('Create a workspace outside every repo')
  .action(async (name: string) => {
    try {
      if (!isValidRepoName(name)) throw new Error(`Workspace name "${name}" must be lowercase letters, digits and hyphens.`);
      const manifestPath = workspaceManifestPath(name);
      if (existsSync(manifestPath)) throw new Error(`Workspace "${name}" already exists at ${manifestPath}.`);
      await writeManifest(manifestPath, createManifest(name, null));
      console.log(`Created workspace "${name}". Link this repo with: knowl workspace add ${name}`);
    } catch (error: any) {
      console.error(`Error creating workspace: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('add')
  .argument('<workspace>')
  .description('Link this repo into a workspace')
  .option('--name <repo-name>', 'Name this repo carries inside the workspace; defaults to the directory name')
  .option('--role <text>', 'What this repo is, for agents that have only the manifest')
  .option('--default-visibility <repo|workspace>', 'Visibility stamped on new writes here (default: workspace in a linked workspace)')
  .option('--kin <group>', 'Group name shared with repos of the same lineage')
  .option('--promote-existing', 'Also share knowledge already in this repo; requires --default-visibility workspace')
  .option('--force', 'Link even though .knowl/config.json is tracked by git')
  .action(async (workspaceName: string, options: { name?: string; role?: string; defaultVisibility?: string; kin?: string; promoteExisting?: boolean; force?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const repoName = options.name ?? path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const requested = parseDefaultVisibility(options.defaultVisibility);

      /**
       * A repo joining a `linked` workspace shares by default.
       *
       * `'repo'` was the compatibility default: it preserved pre-workspace behaviour, which was
       * right when the columns landed and nothing read them. Once workspaces shipped it became a
       * policy default nobody chose, and because promotion has no inverse it only ever drifts one
       * way -- measured on a real three-repo workspace, to 95% private, with the same rule shared
       * from one repo and private in its sibling purely by where someone was standing.
       *
       * Sharing costs little and loses nothing: over 92 cases across five workspace archetypes,
       * pooled MRR moves 0.9837 -> 0.9674 while recall@3 is unchanged to four decimal places
       * (docs/evals/share-everything.md). Answers are reordered, never dropped.
       *
       * Applied ONLY on an explicit `workspace add`, and only to the entry being created. A
       * person is at the terminal, reads the notice below, and can pass `--default-visibility
       * repo`. Existing entries are untouched and absent still means `'repo'` -- changing what
       * omission resolves to would publish every linked repo's next write on account of a
       * release rather than a decision, which is the bulk publish `tests/cli/upgrade.test.ts`
       * already forbids and which no `--default-visibility repo` could undo.
       */
      const manifestMode = await readManifest(workspaceManifestPath(workspaceName))
        .then(manifest => manifest.mode)
        .catch(() => null);
      const defaultedToWorkspace = requested === undefined && manifestMode === 'linked';
      const visibility = defaultedToWorkspace ? 'workspace' : requested;

      // Rejected rather than ignored. A flag that silently does nothing is how you end up
      // believing a whole repo was shared when none of it was -- the same rule `knowl upgrade`
      // applies to its --all-only flags.
      //
      // Checked against `requested`, NOT the resolved value: the new default must not stand in
      // for saying it out loud here. Defaulting a repo's FUTURE writes to workspace is a small,
      // announced, per-command decision. Publishing everything the repo already knows is the
      // largest irreversible action this tool has, and letting a default satisfy its
      // precondition would mean `workspace add ws --promote-existing` quietly bulk-publishes an
      // entire history -- exactly the shape of unrequested publish this default was scoped to
      // avoid. The two must not be merged just because they name the same enum.
      if (options.promoteExisting && requested !== 'workspace') {
        throw new Error('--promote-existing only applies with an explicit --default-visibility workspace, because it publishes everything this repo already knows.');
      }

      await joinWorkspace({
        projectRoot: root, workspaceName, repoName, force: options.force,
        settings: { role: options.role, kin: options.kin, defaultVisibility: visibility },
      });
      console.log(`Linked this repo as "${repoName}" in workspace "${workspaceName}".`);

      if (visibility === 'workspace') {
        console.log('');
        // Said before the gate notice, not instead of it. Someone who did not pass a flag needs
        // to know a default decided this and how to decline it; someone who passed
        // `--default-visibility workspace` already knows and is not told twice.
        if (defaultedToWorkspace) {
          console.log('New writes here default to workspace visibility, because every repo in a linked');
          console.log('workspace is on this machine and read by you. Pass --default-visibility repo to');
          console.log('keep this repo\'s writes private instead.');
          // Blank line because the two say different things: one explains why this is happening
          // without a flag, the other what workspace visibility costs. Run together they read as
          // one paragraph and the irreversibility warning stops looking like a warning.
          console.log('');
        }
        for (const line of visibilityGateNotice(repoName)) console.log(line);
        console.log('');

        if (options.promoteExisting) {
          // After joinWorkspace, never before: promote selects on ownership, and the join's
          // backfill is what stamps it. Run first, it would match nothing and report success.
          const promoted = await promoteItems({
            projectRoot: root, repoName,
            categories: [...KNOWLEDGE_CATEGORIES], apply: true,
          });
          console.log(`Promoted ${promoted.items.length} existing item(s) to workspace visibility.`);
        } else {
          for (const line of existingItemsNotice(await countOwnedItems(root, repoName))) console.log(line);
        }
      } else {
        console.log('Its existing knowledge is now owned by that name and stays private until you run knowl workspace promote.');
      }
    } catch (error: any) {
      console.error(`Error linking repo: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('set')
  .description("Change this repo's recorded nature in the workspace manifest")
  .option('--role <text>', 'What this repo is; pass an empty string to clear')
  .option('--default-visibility <repo|workspace>', 'Visibility stamped on new writes here')
  .option('--kin <group>', 'Group name shared with repos of the same lineage; pass an empty string to clear')
  .action(async (options: { role?: string; defaultVisibility?: string; kin?: string }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) throw new Error('This repo is not linked to a workspace.');

      const visibility = parseDefaultVisibility(options.defaultVisibility);
      const nothingToSet = options.role === undefined && options.kin === undefined && visibility === undefined;

      // No flags reads rather than errors, so this doubles as the way to see the values.
      const entry = nothingToSet
        ? repoEntry(active.manifest, active.repo)
        : await updateRepoSettings({
          workspaceName: active.name, repoName: active.repo,
          settings: { role: options.role, kin: options.kin, defaultVisibility: visibility },
        });

      console.log(`Repo "${active.repo}" in workspace "${active.name}":`);
      console.log(`  role:               ${entry?.role ?? '(none)'}`);
      console.log(`  default visibility: ${entry?.defaultVisibility ?? 'repo'}`);
      console.log(`  kin:                ${entry?.kin ?? '(none)'}`);

      if (!nothingToSet && visibility === 'workspace') {
        console.log('');
        for (const line of visibilityGateNotice(active.repo)) console.log(line);
      }
    } catch (error: any) {
      console.error(`Error updating workspace settings: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('repin-embedding')
  .description("Repoint the workspace at this repository's embedding model")
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const identity = embeddingIdentityFromConfig(config);
      const active = await resolveWorkspace(root, config);
      if (!active) throw new Error('This repository is not in a workspace.');

      console.log(`Workspace "${active.name}" moves to ${formatEmbeddingIdentity(identity)}.`);
      console.log('Every linked repository must then run `knowl reindex --vectors`:');
      for (const peer of active.peers) console.log(`  ${peer.name}  ${peer.root}`);

      if (!options.yes) {
        const clack = await import('@clack/prompts');
        const answer = await clack.confirm({ message: 'Repin the workspace?', initialValue: false });
        if (clack.isCancel(answer) || !answer) {
          console.log('Unchanged.');
          return;
        }
      }

      active.manifest.embedding = identity;
      await writeManifest(workspaceManifestPath(active.name), active.manifest);
      console.log('Repinned. Peers keep their old vectors until each one reindexes.');
    } catch (error: any) {
      console.error(`Error repinning workspace embedding: ${error.message}`);
      process.exitCode = 1;
    }
  });

workspaceCommand
  .command('join')
  .argument('<manifest-path>')
  .description('Adopt a workspace manifest copied from another machine')
  .option('--name <repo-name>', 'Which repo in the manifest this checkout is')
  .option('--force', 'Link even though .knowl/config.json is tracked by git')
  .action(async (manifestPath: string, options: { name?: string; force?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const incoming = await readManifest(path.resolve(manifestPath));

      // Repo paths in a manifest are machine-local. A copy from another machine names
      // repos that exist here at different paths, or not at all, so joining re-points this
      // repo's entry rather than trusting the path it arrived with.
      const local = workspaceManifestPath(incoming.name);
      const existing = await readManifest(local).catch(() => null);
      const merged = existing ?? { ...incoming, repos: [], retiredNames: incoming.retiredNames };
      if (!existing) merged.repos = incoming.repos.map(entry => ({ ...entry, path: undefined }));

      const candidates = merged.repos.map(entry => entry.name);
      const repoName = options.name ?? path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (!candidates.includes(repoName)) {
        throw new Error(
          `The manifest names ${candidates.length ? candidates.map(name => `"${name}"`).join(', ') : 'no repos'}, and this checkout does not match any of them. Re-run with --name <repo-name>.`,
        );
      }

      // The same gate `workspace add` applies. Joining is the other way into a workspace, so
      // skipping it here let a second machine link under a different embedding model -- two
      // disjoint vector spaces, reported by nothing. Checked before the manifest is written
      // so a refusal leaves no local trace of a workspace this repo did not join.
      assertSafeToLink({ projectRoot: root, manifest: merged, config: await loadConfig(root), force: options.force });
      if (!existing) await writeManifest(local, merged);

      // Adopt: point the named entry at this checkout and write this repo's half.
      const adopted = await readManifest(local);
      adopted.repos = adopted.repos.map(entry =>
        entry.name === repoName ? { ...entry, path: path.resolve(root), addedAt: new Date().toISOString() } : entry);
      await writeManifest(local, adopted);
      const config = await loadConfig(root);
      await saveConfig(root, { ...config, workspace: { workspace: adopted.name, repo: repoName } });
      await backfillOriginRepo(root, repoName);

      console.log(`Joined workspace "${adopted.name}" as "${repoName}".`);
      const missing = adopted.repos.filter(entry => !entry.path).map(entry => entry.name);
      if (missing.length) {
        console.log(`Not yet on this machine: ${missing.join(', ')}. Run knowl workspace join from each checkout.`);
      }
    } catch (error: any) {
      console.error(`Error joining workspace: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('list')
  .description('List workspaces known to this machine')
  .action(async () => {
    try {
      const names = await listKnownWorkspaces();
      if (names.length === 0) {
        console.log('No workspaces on this machine. Create one with: knowl workspace init <name>');
        return;
      }
      for (const name of names) {
        const manifest = await readManifest(workspaceManifestPath(name)).catch(() => null);
        console.log(manifest ? `${name} (${manifest.repos.length} repo(s), ${manifest.mode})` : `${name} (unreadable manifest)`);
      }
    } catch (error: any) {
      console.error(`Error listing workspaces: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('status')
  .description("Show this repo's workspace membership")
  .option('--verbose', 'Include resolved repo paths')
  .action(async (options: { verbose?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) {
        console.log('This repo is not linked to a workspace.');
        return;
      }
      console.log(formatWorkspaceBlock(active, { verbose: options.verbose }).join('\n'));
    } catch (error: any) {
      console.error(`Error reading workspace status: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('remove')
  .argument('<repo-name>')
  .description('Unlink a repo from its workspace')
  .option('--export-first', 'Acknowledge this repo still owns knowledge and unlink anyway')
  .action(async (repoName: string, options: { exportFirst?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) throw new Error('This repo is not linked to a workspace.');
      if (repoName !== active.repo) {
        throw new Error(`This repo is "${active.repo}", not "${repoName}". Run remove from the repo being unlinked.`);
      }
      const owned = await countOwnedItems(root, repoName);
      if (owned > 0 && !options.exportFirst) {
        throw new Error(
          `"${repoName}" still owns ${owned} active item(s). Export them first with "knowl export <path>", then re-run with --export-first. The name is retired on removal, and only this repo can reclaim it.`,
        );
      }
      const { retired } = await leaveWorkspace(root);
      console.log(retired
        ? `Unlinked "${repoName}". Its name is retired: no other repo can take it, and only this one can reclaim it by re-linking.`
        : `Unlinked "${repoName}". It owned no knowledge, so the name stays free for any repo to use.`);
    } catch (error: any) {
      console.error(`Error removing repo: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('promote')
  .description('Share existing knowledge with the other repos in this workspace')
  // Same reason as `config`: a stray positional here is almost always a category list that
  // cmd.exe split on its commas, and the action explains exactly that. Commander's generic
  // arity error would replace the one message that tells a Windows user what went wrong.
  .allowExcessArguments()
  .option('--category <list>', 'Comma-separated categories, e.g. decision,constraint,architecture')
  .option('--id <id...>', 'Specific item ids')
  .option('--apply', 'Actually promote; without this it is a dry run')
  .action(async (options: { category?: string; id?: string[]; apply?: boolean }, command: Command) => {
    try {
      // cmd.exe splits an unquoted `--category a,b,c` on the commas, so the trailing
      // categories arrive as operands. Commander discards them by default, which promoted a
      // narrower set than the user asked for and said nothing -- and when the surviving first
      // category matched nothing, that silence was the whole of "Nothing to promote."
      // Handled here rather than with `allowExcessArguments(false)` so the message can name
      // the dropped values and their cause, which "too many arguments" does not.
      if (command.args.length > 0) {
        throw new Error(
          `Unexpected argument(s): ${command.args.map(arg => `"${arg}"`).join(', ')}. ` +
          'On Windows quote the category list -- --category "decision,constraint" -- because cmd.exe splits it on the commas.',
        );
      }
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) throw new Error('This repo is not linked to a workspace.');
      const categories = options.category
        ? options.category.split(',').map(entry => entry.trim()).filter(Boolean) as KnowledgeCategory[]
        : undefined;

      // A bare call asks instead of refusing. Flags mean the caller already knows what they
      // want, so the picker stays entirely out of their way.
      let picked: KnowledgeCategory[] | undefined;
      let interactive = false;
      if (!options.category && !options.id) {
        await initDb(root);
        let counts;
        try { counts = await countPromotable(active.repo); }
        finally { await closeDb(); }

        // Already up to date is not the same as nothing to do, and must not present as an empty
        // picker the user dismisses. Found by rendering this against a repo that had already
        // promoted once: all five recommended categories were 0 and the 279 remaining were
        // exactly the two withheld by default.
        if (recommendedTotal(counts) === 0) {
          const held = Object.values(counts).reduce((sum, n) => sum + n, 0);
          console.log('Everything worth sharing by default is already shared.');
          if (held > 0) {
            console.log(`${held} item(s) remain in ${WITHHELD_BY_DEFAULT.join(' and ')}, which are held back on purpose.`);
            console.log(`Share them anyway with --category "${WITHHELD_BY_DEFAULT.join(',')}".`);
          }
          return;
        }

        const chosen = await pickCategories({ verb: 'promote', destination: active.name, counts });
        if (chosen === null) {
          // Null is "no TTY" or "cancelled". Without a terminal, reproduce the refusal this
          // command has always given -- now able to say how much a bare call would have shared.
          if (!process.stdin.isTTY) {
            const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
            throw new Error(
              'Specify what to promote with --category <list> or --id <id>. '
              + `${total} item(s) are unpromoted; a bare promote would publish all of them.`,
            );
          }
          console.log('Nothing promoted.');
          return;
        }
        if (chosen.length === 0) {
          console.log('Nothing selected, so nothing was promoted.');
          return;
        }
        picked = chosen;
        interactive = true;
      }

      const result = await promoteItems({
        projectRoot: root,
        repoName: active.repo,
        categories: picked ?? categories,
        ids: options.id,
        // The picker's confirmation IS the apply. Requiring an interactive yes and a flag would
        // move the tedium rather than remove it.
        apply: interactive || options.apply,
      });
      if (result.items.length === 0) {
        console.log(`Nothing to promote.${result.skippedForeign ? ` ${result.skippedForeign} matching item(s) belong to another repo.` : ''}`);
        return;
      }
      console.log(`${result.applied ? 'Promoted' : 'Would promote'} ${result.items.length} item(s):`);
      for (const item of result.items) console.log(`  [${item.category}] ${item.title}`);
      if (result.skippedForeign) console.log(`${result.skippedForeign} matching item(s) belong to another repo and were skipped.`);
      if (!result.applied) console.log('Dry run. Re-run with --apply to promote.');
    } catch (error: any) {
      console.error(`Error promoting knowledge: ${error.message}`);
      process.exit(1);
    }
  });

workspaceCommand
  .command('demand')
  .description('What the repos in this workspace ask each other for')
  .option('--limit <n>', 'How many distinct questions to list', '20')
  .option('--json', 'Machine-readable output')
  .action(async (options: { limit?: string; json?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) throw new Error('This repo is not linked to a workspace.');

      const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
      const summary = await summarizeDemand(active.name, limit);
      await closeDemandDb();

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      if (summary.total === 0) {
        console.log(`No demand recorded yet for workspace "${active.name}".`);
        console.log('Every cross-repo query writes one row; this fills up as the workspace is used.');
        return;
      }

      console.log(`Workspace "${active.name}": ${summary.total} event(s) recorded on this machine.`);
      console.log(`  by kind: ${summary.byKind.map(row => `${row.kind}=${row.count}`).join(', ')}`);
      console.log(`  asked by: ${summary.byQueryingRepo.map(row => `${row.repo}=${row.count}`).join(', ')}`);
      console.log(`  answered by: ${summary.byServingRepo.length
        ? summary.byServingRepo.map(row => `${row.repo}=${row.count}`).join(', ')
        : '(nothing)'}`);

      // The number the "weak query" predicate has to be chosen from. Printed rather than
      // interpreted: nothing in this build acts on it yet, and that is the point of the phase.
      //
      // Named as the cosine it is. Calling it a "score" would invite comparison with the
      // `score` field `knowl_query` returns, which is the fused-and-prioritised number on a
      // different scale; this one is comparable to the per-model relevance floors instead.
      // Queries answered without a semantic half contribute no row here at all, which is why
      // the count is printed beside it rather than assumed to be the total.
      const { scores } = summary;
      if (scores.withScore > 0) {
        const show = (value: number | null) => (value === null ? '-' : value.toFixed(3));
        console.log(`  best cosine over ${scores.withScore} semantically-scored quer(ies): min ${show(scores.min)}, median ${show(scores.median)}, max ${show(scores.max)}`);
      }

      console.log('\nMost-repeated questions:');
      for (const question of summary.topQuestions) {
        // A question whose terms were withheld still counts. Saying so beats a blank line that
        // reads as a bug -- the secret validators refused the text, deliberately.
        const label = question.terms ?? `(terms withheld) ${question.fingerprint.slice(0, 12)}`;
        const best = question.bestScore === null ? '' : ` cos ${question.bestScore.toFixed(3)}`;
        console.log(`  ${String(question.count).padStart(4)}x  ${label}${best}`);
      }
      console.log('\nThis ledger is local to this machine and is not synced between checkouts.');
    } catch (error: any) {
      console.error(`Error reading workspace demand: ${error.message}`);
      process.exit(1);
    }
  });

program.command('index-code').description('Index the project code symbols for retrieval').action(async () => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); await indexCode(root); console.log('Code symbols indexed.'); await closeDb(); } catch (error: any) { console.error(`Error indexing code: ${error.message}`); process.exit(1); } });
program.command('symbols').description('List the indexed symbols in one file').argument('<path>').action(async filePath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listCodeSymbols(filePath), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading code symbols: ${error.message}`); process.exit(1); } });

program.command('export').argument('<path>').description('Write portable JSONL memory to a file').action(async outputPath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await exportKnowledge(project.id, path.resolve(outputPath), root), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error exporting knowledge: ${error.message}`); process.exit(1); } });

program.command('import').argument('<path>').description('Load portable JSONL memory from a file').option('--dry-run')
  .option('--on-divergence <policy>', `How to resolve items that differ locally: ${DIVERGENCE_POLICIES.join(', ')}`, DEFAULT_DIVERGENCE_POLICY)
  .option(
    '--mine',
    'Assert this export came from this same repo, so its items are owned here rather than ' +
    'marked as imported. Nothing in the file can prove that, which is why it takes a person: ' +
    'use it for your own backup or a second machine you cannot link and re-export from. It ' +
    'claims authorship only -- the items stay private until you promote them.',
  )
  .option(
    '--repair-content-hash',
    'Import a file whose items carry a contentHash that does not describe their own content, ' +
    'by recomputing it from the content. Import refuses such a file by default, because ' +
    'divergence is decided on that field and a stale hash silently discards the real body. ' +
    'For an export written by an older writer, which cannot be re-exported to fix.',
  )
  .action(async (inputPath, options) => {
    try {
      if (!DIVERGENCE_POLICIES.includes(options.onDivergence)) {
        throw new Error(`Unknown --on-divergence policy: ${options.onDivergence}. Expected one of: ${DIVERGENCE_POLICIES.join(', ')}`);
      }
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const result = await importKnowledge(path.resolve(inputPath), {
        dryRun: options.dryRun, projectRoot: root, onDivergence: options.onDivergence, claimAsMine: options.mine,
        repairContentHash: options.repairContentHash,
      });
      console.log(JSON.stringify(result, null, 2));
      // The counts alone never say whose knowledge this now is, and for `attributed` that is
      // the difference between "imported 40 items" and "imported 40 items that this repo can
      // never share". Printed to stderr so a script parsing stdout is unaffected.
      for (const line of importOwnershipNotice(result.ownership)) console.error(line);
      // Named for the same reason as the ownership notice: the file was accepted on different
      // terms than it asked for, and nothing in the counts says so.
      if (result.hashRepaired) {
        console.error(
          `Recomputed contentHash for ${result.hashRepaired} item(s) whose stated hash did not ` +
          'describe their content; divergence for those was decided on the content itself.',
        );
      }
      await closeDb();
      // An import that refused to apply must not report success. `--on-divergence fail` is the
      // safe policy, and it printed `applied: false, conflicts: 1` and exited 0 -- so
      // `knowl import x --on-divergence fail && echo synced` said synced on a refused merge.
      // Only a *thrown* error reached the catch below; a declined result returned normally.
      if (result.applied === false && !options.dryRun) {
        console.error(
          `Import did not apply${result.conflicts ? ` (${result.conflicts} conflict(s))` : ''}. ` +
          'Re-run with a different --on-divergence policy, or reconcile the source.',
        );
        process.exitCode = 1;
      }
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error importing knowledge: ${error.message}`);
      process.exit(1);
    }
  });

program.command('synthesize').description('Summarize knowledge for a path or tag into one item').requiredOption('--scope <path-or-tag>').action(async options => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await synthesizeKnowledge(project.id, options.scope), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error synthesizing knowledge: ${error.message}`); process.exit(1); } });

program
  .command('view')
  .description('Serve the local knowledge viewer in a browser')
  .option('--port <port>')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const viewer = await startViewer(root, { port: options.port === undefined ? 0 : Number(options.port) });
      console.log(`Knowl viewer: ${viewer.browseUrl}`);

      // The rejection is caught rather than left to the handler's caller, because a signal
      // handler has no caller: Node invokes it with nothing awaiting the promise, so a `close()`
      // that failed would surface as ERR_UNHANDLED_REJECTION and abort the process -- on the one
      // path that exists to shut it down in order. Ctrl-C means stop the server either way, and
      // an exit code that says "crashed" for a clean interrupt is worse than a lost close error.
      const stop = () => { void viewer.close().catch(() => {}).then(() => process.exit(0)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error: any) {
      console.error(`Error starting viewer: ${error.message}`);
      process.exit(1);
    }
  });


// --- 4. DECIDE COMMAND ---
program
  .command('decide')
  .description('Directly record a project decision (runs interactively if title/content are omitted)')
  .argument('[title]', 'The title of the decision')
  .argument('[content]', 'The core content of the decision')
  .option('-r, --reasoning <reasoning>', 'The justification or reasoning')
  .option('-a, --alternatives <alternatives...>', 'List of alternatives considered')
  .option('-t, --tags <tags...>', 'Tags for categorization')
  .action(async (titleArg, contentArg, options) => {
    let title = titleArg;
    let content = contentArg;
    let reasoning = options.reasoning;
    let alternatives = options.alternatives;
    let tags = options.tags;

    if (!title || !content) {
      console.log('📝 INTERACTIVE DECISION RECORDING');
      console.log('Fill in the fields below to record a decision:\n');
      
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        if (!title) {
          title = await rl.question('Title: ');
          if (!title.trim()) {
            console.error('❌ Title is required.');
            process.exit(1);
          }
        }
        if (!content) {
          content = await rl.question('Content: ');
          if (!content.trim()) {
            console.error('❌ Content is required.');
            process.exit(1);
          }
        }
        if (!reasoning) {
          reasoning = await rl.question('Reasoning (optional): ');
          if (!reasoning.trim()) reasoning = undefined;
        }
        if (!alternatives) {
          const altsInput = await rl.question('Alternatives considered (comma-separated, optional): ');
          alternatives = altsInput.trim() ? altsInput.split(',').map(s => s.trim()) : undefined;
        }
        if (!tags) {
          const tagsInput = await rl.question('Tags (comma-separated, optional): ');
          tags = tagsInput.trim() ? tagsInput.split(',').map(s => s.trim()) : undefined;
        }
      } finally {
        rl.close();
      }
    }

    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      await initDb(root);

      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const atom = {
        category: 'decision' as const,
        title,
        content,
        reasoning,
        alternatives,
        tags,
      };

      if (hasAiConfigured(config)) {
        // Loaded here, not at module scope: the AI SDK tree (ai, @ai-sdk/*, zod, ws)
        // is hundreds of modules, and node spends more time resolving them than the
        // libraries spend running. Only AI-backed commands need it.
        const { initAI } = await import('../ai/provider.js');
        const { runDecisionPipeline } = await import('../pipeline/pipeline.js');
        initAI(config.ai!);
        const mergeResult = await runDecisionPipeline(project.id, atom, {
          autoResolveContradictions: true,
          commitMessage: `Record decision: ${title}`
        }, config);

        if (mergeResult.unresolvedContradictions.length > 0) {
          const decision = await recordDecisionDirect(project.id, atom, `Record decision (fallback): ${title}`, config);
          console.log(decision.action === 'duplicate'
            ? `ℹ️ Already recorded verbatim, nothing written. ID: ${decision.item.id}`
            : `✅ Recorded decision successfully! ID: ${decision.item.id}`);
          for (const line of formatCrossRepoNotice(decision.crossRepo)) console.log(line);
          if (decision.superseded) console.log(`🔄 Superseded older decision: ${decision.superseded.id}`);
          if (decision.nearDuplicate) console.log(`⚠️ Left active beside "${decision.nearDuplicate.title}" (${decision.nearDuplicate.id}) — run \`knowl supersede ${decision.nearDuplicate.id} ${decision.item.id}\` if it replaces that one.`);
        } else if (mergeResult.supersededIds.length > 0) {
          const newId = mergeResult.insertedIds[0];
          console.log(`✅ Recorded decision successfully! ID: ${newId}`);
          console.log(`🔄 Superseded older conflicting decision(s): ${mergeResult.supersededIds.join(', ')}`);
        } else if (mergeResult.updatedIds.length > 0) {
          console.log(`✅ Recorded decision successfully! ID: ${mergeResult.updatedIds[0]} (updated)`);
        } else if (mergeResult.insertedIds.length > 0) {
          console.log(`✅ Recorded decision successfully! ID: ${mergeResult.insertedIds[0]}`);
        } else {
          console.log(`ℹ️ Decision was identified as a duplicate and skipped.`);
        }
      } else {
        console.log(`⚠️ No AI provider configured or API keys found. Falling back to direct insertion without conflict detection.`);
        const decision = await recordDecisionDirect(project.id, atom, `Record decision: ${title}`, config);
        console.log(decision.action === 'duplicate'
          ? `ℹ️ Already recorded verbatim, nothing written. ID: ${decision.item.id}`
          : `✅ Recorded decision successfully! ID: ${decision.item.id}`);
        for (const line of formatCrossRepoNotice(decision.crossRepo)) console.log(line);
        if (decision.superseded) console.log(`🔄 Superseded older decision: ${decision.superseded.id}`);
        if (decision.nearDuplicate) console.log(`⚠️ Left active beside "${decision.nearDuplicate.title}" (${decision.nearDuplicate.id}) — run \`knowl supersede ${decision.nearDuplicate.id} ${decision.item.id}\` if it replaces that one.`);
      }

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Error recording decision: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('store')
  .argument('<content>', 'The knowledge itself')
  .description('Record one verified fact, decision or constraint')
  .requiredOption('--category <category>', 'fact, decision, goal, constraint, architecture, state or skill')
  .requiredOption('--title <title>', 'Concise title')
  .option('--tag <tag...>', 'Tags')
  .option('--path <path...>', 'Repository-relative paths this knowledge depends on')
  .option('--confidence <number>', 'Confidence from 0.0 to 1.0', Number)
  .option('--provenance <provenance>', 'observed, user_stated or inferred')
  .option('--reasoning <text>', 'Why this is believed')
  .option('--alternative <text...>', 'Alternatives considered')
  .option('--source <label>', 'Source label')
  .option('--source-commit <sha>', 'Commit where this was last reviewed')
  .option('--supersedes <id>', 'Id of an active item this replaces')
  .option('--local', 'Never publish this atom to a cloud workspace')
  .action(async (content: string, options) => {
    try {
      if (!KNOWLEDGE_CATEGORIES.includes(options.category)) {
        console.error(`Invalid category "${options.category}". Expected one of: ${KNOWLEDGE_CATEGORIES.join(', ')}.`);
        process.exit(1);
      }

      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      await initDb(root);
      try {
        const project = await repo.getProjectByRootPath(root);
        if (!project) throw new Error('Project not found in database.');

        // Retiring an item is a write to that item, and in a linked workspace it may belong to
        // another repo. The MCP write tools guard this; a CLI that did not would be the hole.
        if (options.supersedes) {
          const owner = await resolveWorkspace(root, config);
          if (owner) await assertOwnedItem(options.supersedes, owner);
        }

        const result = await storeKnowledgeItemDeduped(
          project.id,
          {
            category: options.category,
            title: options.title,
            content,
            reasoning: options.reasoning,
            alternatives: options.alternative,
            tags: options.tag,
            source: options.source,
            sourceCommit: options.sourceCommit,
            affectedPaths: options.path,
            confidence: options.confidence,
            provenance: options.provenance,
            supersedes: options.supersedes,
          },
          `Store ${options.category}: ${options.title}`,
          config.security,
        );

        if (result.action === 'duplicate') {
          console.log(`NOT STORED — already held verbatim as ${result.item.id}. Nothing was written and nothing was lost.`);
          return;
        }

        // Excluded after the write, which is the only order available: the id does not exist
        // until the row does. The seam may therefore have staged it a moment ago, so the
        // exclusion is paired with an unstage rather than trusting it to have lost the race.
        if (options.local) {
          await excludeFromPublish(result.item.id, 'knowl store --local');
          const connected = cloudPointer(config);
          if (connected) await unstagePublish(result.item.id, connected.workspaceId);
        }

        console.log(`Stored ${options.category} ${result.item.id}: ${result.item.title}`);
        if (result.superseded) console.log(`  Retired ${result.superseded.id}.`);
        if (options.local) console.log('  Marked local. It will not be published.');
      } finally {
        await closeDb();
      }
    } catch (error: any) {
      console.error(`Error storing knowledge: ${error.message}`);
      process.exit(1);
    }
  });

// --- 5. ASK COMMAND ---
program
  .command('ask')
  .description('Ask a natural language question about the project state')
  .argument('<question>', 'The question to ask')
  .action(async (question) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      await initDb(root);

      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      if (!hasAiConfigured(config)) {
        throw new Error('AI is not configured. Set ai.provider and ai.model, then provide an API key or configure ollama for local models.');
      }

      // Deferred: the AI SDK tree is hundreds of modules and only AI-backed commands need it.
      const { initAI, askQuestion } = await import('../ai/provider.js');
      initAI(config.ai!);

      const hierarchy = await getHierarchicalKnowledge(project.id);
      const contextMarkdown = formatHierarchyToMarkdown(hierarchy);

      console.log(`🤔 Thinking...`);
      const answer = await askQuestion(question, contextMarkdown);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(answer);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Error asking question: ${error.message}`);
      process.exit(1);
    }
  });

// --- 6. INGEST COMMAND ---
program
  .command('ingest')
  .description('Ingest raw text (developer discussion, notes, chat logs) through the Knowl pipeline')
  .argument('<text>', 'The raw text to ingest')
  .option('-m, --message <commitMessage>', 'Custom commit message')
  .option('--auto-resolve', 'Auto-resolve contradictions by superseding older items', false)
  .action(async (text, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      await initDb(root);

      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      if (!hasAiConfigured(config)) {
        throw new Error('AI is not configured for raw ingestion. Use MCP structured tools, or set ai.provider and ai.model with an API key/local model.');
      }

      // Deferred: the AI SDK tree is hundreds of modules, and only AI-backed commands
      // need it. Resolving them dominated startup for every other command.
      const { initAI } = await import('../ai/provider.js');
      const { runPipeline } = await import('../pipeline/pipeline.js');
      initAI(config.ai!);

      console.log(`🌀 Processing text through KNOWL pipeline...`);
      const result = await runPipeline(project.id, text, config, {
        autoResolveContradictions: options.autoResolve,
        commitMessage: options.message || 'Ingest via CLI',
      });

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📁 PIPELINE INGESTION REPORT`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Filter Status:   ${result.passedFilter ? '🟢 PASSED' : '🔴 BLOCKED'}`);
      if (!result.passedFilter) {
        console.log(`Filter Reason:   ${result.filterReason}`);
      } else {
        console.log(`Atoms Extracted: ${result.extractedCount}`);
        if (result.mergeResult) {
          console.log(`Merged Changes:  ${result.mergeResult.mergedCount || 0}`);
          console.log(`  Inserted:      ${result.mergeResult.insertedIds.length}`);
          console.log(`  Updated:       ${result.mergeResult.updatedIds.length}`);
          console.log(`  Superseded:    ${result.mergeResult.supersededIds.length}`);

          if (result.mergeResult.unresolvedContradictions.length > 0) {
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`⚠️  UNRESOLVED CONTRADICTIONS`);
            for (const c of result.mergeResult.unresolvedContradictions) {
              console.log(`  Atom: "${c.atom.title}" (${c.atom.category})`);
              console.log(`  Conflict: ${c.compareResult?.reason}`);
              console.log(`  👉 Re-run with --auto-resolve to overwrite the old decision,`);
              console.log(`     or update the item manually using its ID.`);
            }
          }
        }
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Ingestion failed: ${error.message}`);
      process.exit(1);
    }
  });

/**
 * Bring stored vectors up to date under the repository's current profile.
 *
 * Shared by `knowl reindex --vectors` and the offer made after a config change, so the
 * two cannot report different things about the same operation.
 */
async function rebuildVectorEmbeddings(root: string, options: { force?: boolean } = {}): Promise<void> {
  const config = await loadConfig(root);
  if (!isVectorSearchEnabled(config)) {
    throw new Error('Vector search is not enabled. Set search.vector.enabled true before running vector reindex.');
  }

  await initDb(root);
  try {
    const project = await repo.getProjectByRootPath(root);
    if (!project) throw new Error('Project not found in database.');

    const embedder = await createLocalEmbeddingProvider(config, root, {
      // Only claim a download when one is actually going to happen. This announced
      // "Downloading" on every run, cached or not, because the callback fires whenever
      // the pipeline is not in memory -- which is always in a fresh CLI process.
      onFirstLoad: ({ model, cached }) => console.log(
        cached
          ? `Loading local embedding model ${model}...`
          : `Downloading local embedding model ${model} (first run)...`,
      ),
    });
    const result = await reindexKnowledgeEmbeddings(project.id, embedder, { force: options.force });
    const perStatus = Object.entries(result.byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    console.log(`Indexed ${result.indexed} vector embedding(s)${perStatus ? ` (${perStatus})` : ''}.`);
    // Named rather than left as silence, so a run that embeds nothing reads as "already
    // current" instead of "did not work" -- the common outcome now that runs are incremental.
    if (result.skipped > 0) {
      console.log(`Skipped ${result.skipped} already up to date. Use --force to rebuild them anyway.`);
    }
    if (result.purged > 0) console.log(`Purged ${result.purged} embedding(s) from a previous model.`);
  } finally {
    await closeDb();
  }
}

// --- 7. CONFIG COMMAND ---
const configCommand = program
  .command('config')
  .description('Interactively view or edit repository configuration')
  // Commander 14 rejects excess arguments before the action runs. Left alone, `knowl config
  // ai.model gpt-4o` would answer "too many arguments for 'config'" instead of naming the
  // subcommand syntax the user was reaching for, which is the whole point of the check below.
  .allowExcessArguments();

configCommand.action(async () => {
  try {
    const commandIndex = process.argv.lastIndexOf('config');
    if (commandIndex >= 0 && process.argv.slice(commandIndex + 1).length > 0) {
      throw new Error('Use `knowl config set <key> <value>` or `knowl config get <key>`.');
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Interactive config requires a TTY. Use `knowl config get`, `set`, or `reset`.');
    }
    const root = await findProjectRoot(process.cwd());
    const clack = await import('@clack/prompts');
    clack.intro('knowl config');
    const result = await runConfigUi(root);
    // Run here rather than inside the UI: rebuilding needs the embedder and the database,
    // and the UI layer deliberately knows about neither.
    if (result.reindexRequested) await rebuildVectorEmbeddings(root);
    // Every exit is framed, including the one that changed nothing -- a run that just
    // stops leaves you unsure whether it saved.
    clack.outro(result.saved
      ? `Saved ${result.changes.length} change${result.changes.length === 1 ? '' : 's'} to .knowl/config.json`
      : 'No changes written');
  } catch (error: any) {
    console.error(`❌ Configuration error: ${error.message}`);
    process.exitCode = 1;
  }
});

configCommand
  .command('get')
  .argument('<key>')
  .action(async (key) => {
    try {
      const value = await getEffectiveConfigValue(await findProjectRoot(process.cwd()), key);
      console.log(typeof value === 'string' ? value : JSON.stringify(value));
    } catch (error: any) {
      console.error(`❌ Configuration error: ${error.message}`);
      process.exitCode = 1;
    }
  });

configCommand
  .command('set')
  .argument('<key>')
  .argument('<value>')
  .action(async (key, value) => {
    try {
      // Refused before the write, not after: `preset custom` alone names no model, and
      // anything running before the follow-up keys arrive would resolve that as a profile.
      if (key === 'search.vector.preset' && value === 'custom') {
        throw new Error('Use `knowl config set-model <name>` for a custom model; `preset custom` alone leaves no model to use.');
      }
      const root = await findProjectRoot(process.cwd());
      const before = await loadConfig(root);
      const typedValue = await setConfigValue(root, key, value);
      console.log(`Set ${key} = ${JSON.stringify(typedValue)}`);
      const after = await loadConfig(root);
      // Said here because announceProfileChange cannot say it: a shadowed key leaves the
      // resolved profile untouched, so the change reads as "no change" rather than "ignored".
      for (const line of shadowedByPresetNotice(after, key)) console.log(line);
      await announceProfileChange(root, before, after);
      // Turning transcript search off deletes its index. Wired to every mutation path, not just
      // the interactive editor, or this command would silently keep it.
      const teardown = describeTranscriptTeardown(await applyTranscriptConfigTransition(root, before, after));
      if (teardown) console.log(teardown);
    } catch (error: any) {
      console.error(`❌ Configuration error: ${error.message}`);
      process.exitCode = 1;
    }
  });

configCommand
  .command('set-model')
  .argument('<model>')
  .description('Verify, download and select a custom embedding model')
  .option('--pooling <mode>', 'cls or mean; required when the model does not declare it')
  .action(async (model: string, options: { pooling?: string }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const probe = await verifyCustomModel(model);
      if (!probe.ok) throw new Error(probe.reason);

      const pooling = probe.pooling ?? options.pooling;
      if (!pooling) {
        throw new Error(
          `${model} does not declare its pooling method. Re-run with --pooling cls or --pooling mean. ` +
          'Guessing would produce vectors that rank badly with no visible error.',
        );
      }
      if (pooling !== 'cls' && pooling !== 'mean') throw new Error('--pooling must be cls or mean.');

      const before = await loadConfig(root);
      await setConfigValues(root, [
        { key: 'search.vector.preset', raw: 'custom' },
        { key: 'search.vector.model', raw: model },
        { key: 'search.vector.pooling', raw: pooling },
      ]);
      console.log(`Selected ${model} (${pooling} pooling).`);
      console.log('Run `knowl reindex --vectors` to rebuild embeddings with it.');
      await announceProfileChange(root, before, await loadConfig(root));
    } catch (error: any) {
      console.error(`❌ Configuration error: ${error.message}`);
      process.exitCode = 1;
    }
  });

configCommand
  .command('reset')
  .argument('[key]')
  .option('-y, --yes', 'Confirm resetting all settings')
  .action(async (key, options) => {
    try {
      if (!key && !options.yes) {
        const clack = await import('@clack/prompts');
        const answer = process.stdin.isTTY && process.stdout.isTTY
          ? await clack.confirm({ message: 'Reset all configuration to defaults?', initialValue: false })
          : false;
        if (clack.isCancel(answer) || !answer) {
          throw new Error('Reset cancelled. Use `--yes` for non-interactive full reset.');
        }
      }
      const root = await findProjectRoot(process.cwd());
      const before = await loadConfig(root);
      if (key) await resetConfigValue(root, key);
      else await resetAllConfig(root);
      console.log(key ? `Reset ${key}` : 'Reset all configuration to defaults');
      // A full reset moves an old repo onto the default preset, which is a model change
      // like any other -- and the one most likely to surprise, since nothing named a model.
      const afterReset = await loadConfig(root);
      await announceProfileChange(root, before, afterReset);
      // A whole-config reset turns transcript search off implicitly rather than by naming the
      // key, which is exactly the case a key-name check would miss.
      const teardown = describeTranscriptTeardown(await applyTranscriptConfigTransition(root, before, afterReset));
      if (teardown) console.log(teardown);
    } catch (error: any) {
      console.error(`❌ Configuration error: ${error.message}`);
      process.exitCode = 1;
    }
  });

configCommand.on('command:*', () => {
  console.error('Use `knowl config get <key>`, `set <key> <value>`, or `reset [key]`.');
  process.exitCode = 1;
});

// --- 8. REINDEX COMMAND ---
program
  .command('reindex')
  .description('Rebuild derived search indexes')
  .option('--vectors', 'Rebuild optional vector embeddings')
  .option('--transcripts', 'Build or update the optional session transcript index')
  .option('--budget <minutes>', 'Stop after this many minutes; the next run resumes', parseFloat)
  .option('--force', 'With --vectors, re-embed every item instead of only the stale ones')
  .action(async (options) => {
    try {
      if (!options.vectors && !options.transcripts) {
        throw new Error('Nothing to reindex. Pass --vectors or --transcripts.');
      }

      const root = await findProjectRoot(process.cwd());
      if (options.vectors) await rebuildVectorEmbeddings(root, { force: options.force });

      if (options.transcripts) {
        const result = await rebuildTranscriptIndex(root, { budgetMinutes: options.budget });
        console.log(`Indexed ${result.indexed} transcript message(s).`);
        if (result.embedded > 0) console.log(`Embedded ${result.embedded} message(s).`);
        if (result.removed > 0) console.log(`Removed ${result.removed} deleted transcript(s).`);
        if (result.skippedEmbedding) console.log(result.skippedEmbedding);
        if (!result.complete) console.log('Stopped early. Run the same command again to resume.');
        await closeTranscriptDbs();
      }
    } catch (error: any) {
      console.error(`Error reindexing: ${error.message}`);
      process.exit(1);
    }
  });

// --- 8b. TRANSCRIPT CANDIDATE COMMANDS ---
//
// Extraction and approval are separate commands because they are separate decisions, and because
// only one of them costs money. `extract` runs the configured model over whole sessions and stages
// what it finds; nothing it writes can be retrieved. `approve` is the act that puts an atom in
// front of every future query, and it names what it is promoting.
const transcripts = program
  .command('transcripts')
  .description('Distil indexed session transcripts into reviewable knowledge candidates');

/** The transcripts index for the current project, or a readable error saying how to build one. */
async function openCandidateStore(root: string) {
  const config = await loadConfig(root);
  if (!isTranscriptSearchEnabled(config)) {
    throw new Error(
      'Transcript search is not enabled for this repository. Set search.transcripts.enabled to true (knowl config), then run knowl reindex --transcripts.',
    );
  }
  const dbPath = resolveStorage(root).transcripts;
  return { config, db: await openTranscriptDb(dbPath) };
}

transcripts
  .command('extract')
  .description('Run the configured model over unextracted sessions and stage what it finds')
  .option('--limit <n>', `Sessions to extract in this run (default ${DEFAULT_EXTRACT_LIMIT})`, parseInt)
  .option('--budget <minutes>', 'Stop after this many minutes; the next run resumes', parseFloat)
  .option('--yes', 'Skip the cost estimate and run')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const { config, db } = await openCandidateStore(root);
      const plan = await planExtraction(db, { limit: options.limit });

      if (plan.sessions.length === 0) {
        console.log(plan.done > 0
          ? `Nothing to extract: all ${plan.done} indexed session(s) have been extracted.`
          : 'Nothing to extract. Run knowl reindex --transcripts first.');
        await closeTranscriptDbs();
        return;
      }

      // Printed before anything is sent, and gated behind --yes. This spends the operator's API
      // quota on their own archive; the size of that is theirs to see before it happens, not
      // after. `remaining` is stated too, so a run that covers a tenth of the archive cannot read
      // as having covered it.
      console.log(`Extract ${plan.sessions.length} session(s), about ${Math.round(plan.chars / 1000)}k characters, using ${config.ai?.provider}/${config.ai?.model}.`);
      console.log(`${plan.pending} session(s) await extraction; ${plan.done} already done.`);
      if (!options.yes) {
        console.log('This calls your configured model and spends your quota. Re-run with --yes to proceed.');
        await closeTranscriptDbs();
        return;
      }

      const deadline = options.budget !== undefined ? Date.now() + options.budget * 60_000 : undefined;
      const result = await extractCandidates(db, config, { limit: options.limit, deadline });

      console.log(`Extracted ${result.sessionsExtracted} session(s) into ${result.candidates} candidate(s).`);
      if (result.empty > 0) console.log(`${result.empty} session(s) yielded nothing and will not be retried.`);
      if (result.remaining > 0) console.log(`${result.remaining} session(s) still unextracted. Run again to continue.`);
      console.log('Review them with knowl transcripts candidates; nothing is stored until you approve it.');
      await closeTranscriptDbs();
    } catch (error: any) {
      console.error(`Error extracting: ${error.message}`);
      process.exit(1);
    }
  });

transcripts
  .command('candidates')
  .description('List staged candidates awaiting a decision')
  .option('--status <status>', 'pending, approved or discarded', 'pending')
  .option('--limit <n>', 'Maximum rows to show', parseInt)
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const { db } = await openCandidateStore(root);
      const counts = await countCandidates(db);
      const rows = await listCandidates(db, { status: options.status, limit: options.limit });

      if (rows.length === 0) {
        console.log(`No ${options.status} candidates.`);
      } else {
        for (const row of rows) {
          console.log(`[${row.id}] ${row.category.padEnd(12)} ${row.title}`);
          console.log(`    ${row.content.replace(/\s+/g, ' ').slice(0, 160)}`);
          console.log(`    from ${row.harness} session ${row.sessionId}, confidence ${row.confidence.toFixed(2)}`);
        }
      }
      const summary = Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ');
      if (summary) console.log(`\n${summary}.`);
      await closeTranscriptDbs();
    } catch (error: any) {
      console.error(`Error listing candidates: ${error.message}`);
      process.exit(1);
    }
  });

transcripts
  .command('approve [ids...]')
  .description('Promote staged candidates into the knowledge store')
  .option('--all', `Approve up to ${APPROVE_ALL_LIMIT} pending candidates`)
  .action(async (ids: string[], options) => {
    try {
      if (!options.all && (!ids || ids.length === 0)) {
        throw new Error('Name the candidate ids to approve, or pass --all.');
      }
      const root = await findProjectRoot(process.cwd());
      const { config, db } = await openCandidateStore(root);
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not registered in the database.');

      const result = await approveCandidates(db, project.id, config, { ids, all: options.all });
      console.log(`Approved ${result.approved} candidate(s).`);
      if (result.deduped > 0) console.log(`${result.deduped} merged into knowledge the store already held.`);
      for (const failure of result.failed) console.log(`Failed ${failure.id}: ${failure.reason}`);
      // Said out loud, because `--all` stops at a cap and a first run over a real archive
      // produces atoms on that order. "Approved 1000 candidate(s)" alone reads as finished.
      if (result.remaining > 0) {
        console.log(`${result.remaining} still pending. Run approve --all again to continue.`);
      }
      await closeTranscriptDbs();
    } catch (error: any) {
      console.error(`Error approving: ${error.message}`);
      process.exit(1);
    }
  });

transcripts
  .command('discard [ids...]')
  .description('Reject staged candidates, so a rerun does not ask again')
  .option('--all', 'Discard every pending candidate')
  .action(async (ids: string[], options) => {
    try {
      if (!options.all && (!ids || ids.length === 0)) {
        throw new Error('Name the candidate ids to discard, or pass --all.');
      }
      const root = await findProjectRoot(process.cwd());
      const { db } = await openCandidateStore(root);
      console.log(`Discarded ${await discardCandidates(db, { ids, all: options.all })} candidate(s).`);
      await closeTranscriptDbs();
    } catch (error: any) {
      console.error(`Error discarding: ${error.message}`);
      process.exit(1);
    }
  });

// --- 9. RETRIEVAL EVALUATION COMMAND ---
program
  .command('eval')
  .description('Evaluate agent retrieval against a checked-in dataset')
  .requiredOption('--dataset <path>', 'Path to a retrieval evaluation JSON dataset')
  .option('--json', 'Print machine-readable JSON')
  .option('--vector', 'Embed queries and rank with vector + BM25 fusion (the path real agents use; requires the local embedding model)')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const datasetPath = path.resolve(options.dataset);
      const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf-8')) as {
        cases?: RetrievalEvaluationCase[];
        fixtures?: Array<{ id: string; category: any; title: string; content: string; tags?: string[]; freshness?: any; status?: any }>;
      };
      if (!Array.isArray(dataset.cases)) {
        throw new Error('Retrieval dataset must contain a cases array.');
      }

      let fixtureRoot: string | null = null;
      let cases = dataset.cases;
      let project;
      if (dataset.fixtures?.length) {
        fixtureRoot = await fs.mkdtemp(path.join(process.env.TEMP || root, 'knowl-eval-'));
        await fs.mkdir(path.join(fixtureRoot, '.knowl'), { recursive: true });
        await initDb(fixtureRoot);
        project = await repo.createProject(fixtureRoot, 'Retrieval evaluation fixture');
        const ids = new Map<string, string>();
        for (const fixture of dataset.fixtures) {
          const item = await repo.createKnowledgeItem(project.id, fixture);
          ids.set(fixture.id, item.id);
          if (fixture.status) await repo.updateKnowledgeItem(item.id, { status: fixture.status } as any);
        }
        cases = dataset.cases.map(testCase => ({
          ...testCase,
          expectedItemIds: testCase.expectedItemIds.map(id => ids.get(id) ?? id),
          mustNotReturn: testCase.mustNotReturn.map(id => ids.get(id) ?? id),
        }));
      } else {
        await initDb(root);
        project = await repo.getProjectByRootPath(root);
        if (!project) throw new Error('Project not found in database.');
      }

      let embedder: Awaited<ReturnType<typeof createLocalEmbeddingProvider>> | null = null;
      if (options.vector) {
        const config = await loadConfig(root);
        if (!isVectorSearchEnabled(config)) throw new Error('Vector search is not enabled. Set search.vector.enabled true to run --vector.');
        embedder = await createLocalEmbeddingProvider(config, root);
        if (fixtureRoot) {
          // A fixture store is built by this command, milliseconds ago, and thrown away when it
          // returns -- so embedding it is not the live-store mutation the note below guards
          // against, and without it `--vector` cannot measure anything. The fixtures are created
          // with no embeddings, so a query vector has nothing to match and every case silently
          // falls through to BM25: `--vector` and plain BM25 returned byte-identical metrics on
          // every fixture-backed dataset, including the semantic suite built to need embeddings.
          // The note's own advice was unfollowable here too -- there is no store for the user to
          // reindex. Five of the six checked-in datasets carry fixtures.
          const indexed = await reindexKnowledgeEmbeddings(project.id, embedder);
          console.error(`Embedded ${indexed.indexed} fixture(s) for the vector run.`);
        } else {
          // No reindex against a live store. An "evaluate" command was rewriting the live
          // embedding table before measuring it, which both mutates the store the user asked it
          // to observe and makes the numbers describe a state the store was not in. Measure what
          // retrieval would actually return today; if coverage is the problem, that is the
          // user's call to fix.
          console.error('Note: evaluates the store as it stands. If embedding coverage is incomplete, run `knowl reindex --vectors` first.');
        }
      }

      const evaluation = await evaluateRetrieval(cases, async (testCase) => {
        const startedAt = Date.now();
        const vectorOption = embedder
          ? {
            enabled: true,
            profileFingerprint: embedder.profileFingerprint,
            embedding: await embedder.embedQuery(testCase.query),
            relevanceFloor: embedder.relevanceFloor,
          }
          : undefined;
        // rankKnowledge, not queryKnowledgeForAgent: the latter records a knowledge_access row
        // per returned item, and access rows feed GC liveness and tier confirmation -- so every
        // benchmark run was promoting whichever items it returned and shielding them from GC.
        // A measurement that mutates its subject is the defect the doctor check already had.
        const items = (await rankKnowledge(project.id, {
          query: testCase.query,
          status: 'active',
          limit: testCase.limit,
          vector: vectorOption,
          // The explanation is dropped rather than ignored: `contextChars` below measures the
          // serialized result, so carrying it would inflate the very number being reported.
        })).map(({ explanation: _explanation, ...item }) => item);
        return {
          itemIds: items.map(item => item.id),
          staleItemIds: items.filter(item => item.freshness !== 'fresh').map(item => item.id),
          latencyMs: Date.now() - startedAt,
          contextChars: JSON.stringify(items).length,
        };
      });

      const result = { dataset: datasetPath, timestamp: new Date().toISOString(), ...evaluation };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`KNOWL RETRIEVAL EVALUATION`);
        console.log(`Dataset: ${result.dataset}`);
        console.log(`Recall@3: ${result.metrics.recallAt3.toFixed(3)}`);
        console.log(`Recall@10: ${result.metrics.recallAt10.toFixed(3)}`);
        console.log(`MRR: ${result.metrics.mrr.toFixed(3)}`);
        console.log(`nDCG: ${result.metrics.ndcg.toFixed(3)}`);
        console.log(`Stale hits: ${result.metrics.staleHitCount}`);
        console.log(`Forbidden hits: ${result.metrics.forbiddenHitCount}`);
        console.log(`Latency p50/p95: ${result.metrics.p50LatencyMs}/${result.metrics.p95LatencyMs}ms`);
        console.log(`Context chars avg: ${result.metrics.averageContextChars.toFixed(0)}`);
        if (Object.keys(result.byTier).length > 0) {
          console.log('By tier:');
          for (const [tier, metrics] of Object.entries(result.byTier)) {
            console.log(
              `  ${tier.padEnd(9)} n=${String(metrics.cases).padStart(4)} ` +
              `R@3 ${metrics.recallAt3.toFixed(4)} R@10 ${metrics.recallAt10.toFixed(4)} ` +
              `MRR ${metrics.mrr.toFixed(4)} nDCG ${metrics.ndcg.toFixed(4)}`,
            );
          }
        }
        console.log(`Failed cases: ${result.failedCaseIds.join(', ') || 'none'}`);
      }
      await closeDb();
      if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    } catch (error: any) {
      reportCommandFailure(options.json, 'Error evaluating retrieval', error);
    }
  });

// --- 10. ACCESS REPORT COMMAND ---
program
  .command('access')
  .description('Show high-value, stale, and corrected knowledge from retrieval feedback')
  .option('--json', 'Print machine-readable JSON')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');
      const report = await getKnowledgeAccessReport();
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('KNOWL ACCESS REPORT');
        for (const [label, items] of Object.entries(report)) {
          console.log(`${label}:`);
          for (const item of items) {
            console.log(`- ${item.title} (${item.retrievalCount} retrievals, ${item.usefulCount} useful, ${item.causedCorrectionCount} corrections)`);
          }
        }
      }
      await closeDb();
    } catch (error: any) {
      console.error(`Error reporting access: ${error.message}`);
      process.exit(1);
    }
  });

// --- 11. UPGRADE COMMAND ---
program
  .command('upgrade')
  .description('Refresh project files only (config, schema, guidance, .gitignore) — no agent setup. `knowl init` runs this plus agent registration.')
  .option('--all', 'Upgrade and repair every Knowl repository on this machine')
  .option('--root <dir...>', 'With --all, also scan these directories for repositories not yet known')
  .option('--reindex', 'With --all, also re-embed items missing vector coverage (slow)')
  .option('--no-snapshot', 'With --all, skip the per-repository snapshot')
  .option('--dry-run', 'With --all, list the repositories that would be swept and change nothing')
  .action(async (options: { all?: boolean; root?: string[]; reindex?: boolean; snapshot?: boolean; dryRun?: boolean }) => {
    try {
      if (!options.all) {
        // Rejected rather than ignored: a flag that silently does nothing is how you end up
        // believing a sweep ran.
        for (const [flag, present] of [['--root', Boolean(options.root)], ['--reindex', Boolean(options.reindex)], ['--no-snapshot', options.snapshot === false], ['--dry-run', Boolean(options.dryRun)]] as const) {
          if (present) throw new Error(`${flag} only applies to \`knowl upgrade --all\`.`);
        }
        const root = await findProjectRoot(process.cwd());
        const result = await upgradeExistingRepository(root, path.basename(root) || 'My Project');
        printUpgradeStatus(result);
        return;
      }

      // Read before discovery so the registry is healed first and the sweep list below is
      // already the corrected one. A registry line is dropped only when the filesystem
      // positively says it is not a repository, and a sweep must not shrink in silence:
      // these are the paths `upgrade --all` and `doctor --fix` will stop acting on.
      const { forgotten } = await readKnownRepos({ persist: !options.dryRun });
      for (const stale of forgotten) {
        console.log(`Forgot ${stale} -- recorded as a Knowl repository, but no longer one.`);
      }
      if (forgotten.length > 0) console.log('');

      const discovered = await discoverRepos({ roots: options.root, record: !options.dryRun });
      if (discovered.length === 0) {
        console.log('No Knowl repositories found. Run `knowl init` in a repository, or pass --root <dir> to scan for existing ones.');
        return;
      }

      const verb = options.dryRun ? 'Would sweep' : 'Sweeping';
      console.log(`${verb} ${discovered.length} repositor${discovered.length === 1 ? 'y' : 'ies'}:`);
      for (const repository of discovered) console.log(`  ${repository.root}  (found via ${repository.source})`);
      console.log('');

      if (options.dryRun) {
        console.log('Dry run: nothing was changed. Re-run without --dry-run to sweep.');
        return;
      }

      const results = await sweepRepos(discovered.map(repository => repository.root), {
        reindex: options.reindex,
        snapshot: options.snapshot,
      });
      console.log(formatSweepReport(results));

      // Set rather than exited: a hard exit while database handles are still closing crashes
      // the process on Windows instead of reporting a status.
      if (results.some(result => !result.ready)) process.exitCode = 1;
    } catch (error: any) {
      console.error(`❌ Error upgrading KNOWL: ${error.message}`);
      process.exit(1);
    }
  });

// --- 11. GC COMMAND ---
program
  .command('gc')
  .description('Preview or apply knowledge garbage collection')
  .option('--apply', 'Apply the GC recommendations')
  .option('--stale-days <days>', 'Archive active state items older than this many days (default 60)')
  .option('--compress-days <days>', 'Compress archived items cold for this many days (default 30)')
  .option('--min-bytes <bytes>', 'Minimum content bytes before compressing an archived item (default 180)')
  .option('--ignore-access', 'Archive stale state even if it was recently or frequently retrieved (hot)')
  .option('--tombstone-days <days>', 'Remove delete records older than this many days (default 90)')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const gcOptions = {
        staleStateDays: numericOption(options.staleDays, '--stale-days', { min: 0 }),
        compressArchivedDays: numericOption(options.compressDays, '--compress-days', { min: 0 }),
        minCompressBytes: numericOption(options.minBytes, '--min-bytes', { min: 0 }),
        ignoreAccess: Boolean(options.ignoreAccess),
        tombstoneDays: numericOption(options.tombstoneDays, '--tombstone-days', { min: 0 }),
      };
      const result = options.apply
        ? await applyKnowledgeGc(project.id, gcOptions)
        : await previewKnowledgeGc(project.id, gcOptions);

      console.log(options.apply ? 'KNOWL GC APPLY' : 'KNOWL GC PREVIEW');
      console.log(`Archive:  ${result.summary.archive}`);
      console.log(`Compress: ${result.summary.compress}`);
      console.log(`Purge:    ${result.summary.purge}`);

      if (result.candidates.length === 0) {
        const staleDays = gcOptions.staleStateDays ?? 60;
        const items = await repo.listKnowledgeItems();
        const now = new Date();
        const ageOf = (item: any) => Math.floor((now.getTime() - new Date(item.updatedAt).getTime()) / 86_400_000);
        const states = items.filter(item => item.status === 'active' && item.category === 'state');
        const archived = items.filter(item => item.status === 'archived').length;
        const ageEligible = states.filter(item => ageOf(item) >= staleDays);
        const access = await getAccessSummary();
        const hotProtected = gcOptions.ignoreAccess ? 0 : ageEligible.filter(item => isHot(item.id, access, now)).length;
        console.log('No GC actions recommended.');
        if (ageEligible.length === 0) {
          const oldestDays = states.length ? Math.max(...states.map(ageOf)) : 0;
          console.log(`  No state items past --stale-days ${staleDays} (oldest of ${states.length} is ${oldestDays}d); no exact duplicates; ${archived} archived items to compress.`);
          console.log('  Tip: lower the age, e.g. `knowl gc --stale-days 14`.');
        } else if (hotProtected === ageEligible.length) {
          console.log(`  ${ageEligible.length} state items are old enough but all protected as recently/frequently retrieved (hot).`);
          console.log('  Tip: archive them anyway with `knowl gc --ignore-access` (add --apply to commit).');
        } else {
          console.log(`  ${ageEligible.length} old-enough state items, ${hotProtected} protected as hot; no exact duplicates; ${archived} archived to compress.`);
        }
      } else {
        for (const candidate of result.candidates) {
          console.log(`- ${candidate.action.toUpperCase()} ${candidate.itemId} ${candidate.title}`);
          console.log(`  Reason: ${candidate.reason}`);
          if (candidate.duplicateOfId) {
            console.log(`  Duplicate of: ${candidate.duplicateOfId}`);
          }
          console.log(`  Bytes: ${candidate.beforeBytes} -> ${candidate.afterBytes}`);
        }
      }

      await closeDb();
    } catch (error: any) {
      console.error(`Error running GC: ${error.message}`);
      process.exit(1);
    }
  });

/**
 * The read side of the forget log. Recording why an item was destroyed and then offering no way
 * to read it back would leave the collection policy exactly as unfalsifiable as it was before
 * the table existed -- the numbers would merely be unreachable in SQLite instead of unreachable
 * in a discarded local variable.
 *
 * Listing, not pruning, is the default. The whole argument for a table separate from
 * `knowledge_tombstones` is that these rows are kept when tombstones are dropped, so the
 * destructive mode has to be asked for by name.
 */
program
  .command('forget-log')
  .description('Show why knowledge items were destroyed, newest first')
  .option('--limit <n>', 'How many entries to show (default 20, max 1000)')
  .option('--repo <name>', 'Only entries for items owned by this workspace repo')
  .option('--prune-days <days>', 'Instead of listing, delete entries older than this many days')
  .option('--json', 'Emit JSON instead of text')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);

      const pruneDays = numericOption(options.pruneDays, '--prune-days', { min: 0 });
      if (pruneDays !== undefined) {
        const removed = await pruneForgetLog(pruneDays);
        console.log(options.json ? JSON.stringify({ pruned: removed }) : `Pruned ${removed} forget-log entries.`);
        await closeDb();
        return;
      }

      const entries = await listForgetLog({
        limit: numericOption(options.limit, '--limit', { min: 1 }) ?? 20,
        originRepo: options.repo,
      });

      if (options.json) {
        console.log(JSON.stringify({ entries }));
        await closeDb();
        return;
      }

      console.log('KNOWL FORGET LOG');
      if (entries.length === 0) {
        console.log(options.repo
          ? `No recorded deletions for repo "${options.repo}".`
          : 'No recorded deletions. Entries appear here once `knowl gc --apply` purges something.');
      }
      for (const entry of entries) {
        const owner = entry.originRepo ? ` [${entry.originRepo}]` : '';
        console.log(`- ${entry.deletedAt} ${entry.policy} ${entry.itemId}${owner} ${entry.title}`);
        // Sentence first, code after. The code is what a tally groups by, but that happens over
        // `--json` or SQL, where the field is already there; a human reading this list wants the
        // sentence that says which item this was.
        const survivor = entry.mergedIntoId ? ` -> ${entry.mergedIntoId}` : '';
        console.log(`  Reason: ${entry.reason} [${entry.reasonCode}]${survivor}`);
        // The body, because the item is gone: judging whether a rule was right usually means
        // seeing what it took, and this row is the only copy anyone reads.
        if (entry.contentPreview) {
          console.log(`  Was: ${truncateText(entry.contentPreview, 160)}`);
        }
        // The retrieval numbers are the point: a purge of something still being read is the
        // finding a threshold review is looking for, and it is invisible in a plain count.
        const lastSeen = entry.lastRetrievedAt ? `, last ${entry.lastRetrievedAt}` : '';
        const age = entry.ageDays === null ? '' : `, ${entry.ageDays}d old`;
        const size = entry.bytes === null ? '' : `, ${entry.bytes} bytes`;
        console.log(`  Retrievals: ${entry.retrievalCount}${lastSeen}${age}${size}`);
      }

      await closeDb();
    } catch (error: any) {
      reportCommandFailure(options.json, 'Error reading the forget log', error);
    }
  });

// --- 12. SESSION COMMAND ---
const sessionCommand = program.command('session').description('Capture bounded temporary session memory');
sessionCommand.command('start').argument('<title>').option('-q, --query <query>').option('--agent <agent>').option('--json').action(async (title, options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await startMemorySession({ title, query: options.query, agent: options.agent }); console.log(options.json ? JSON.stringify(result) : `Session started: ${result.id}`); await closeDb(); } catch (error: any) { reportCommandFailure(options.json, 'Error starting session', error); }
});
sessionCommand.command('event').argument('<id>').argument('<type>').option('--exit-code <code>').option('--summary <summary>').option('--command <command>').option('--json').action(async (id, type, options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await captureMemorySessionEvent(id, type, { exitCode: options.exitCode === undefined ? undefined : Number(options.exitCode), summary: options.summary, command: options.command }); console.log(options.json ? JSON.stringify(result) : `Session event recorded: ${result.id}`); await closeDb(); } catch (error: any) { reportCommandFailure(options.json, 'Error recording session event', error); }
});
sessionCommand.command('finish').argument('<id>').requiredOption('--status <status>', 'finished or failed').option('--summary <summary>').option('--json').action(async (id, options) => {
  try { if (options.status !== 'finished' && options.status !== 'failed') throw new Error('Status must be finished or failed.'); const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await finishMemorySession(id, options.status, options.summary); const project = await repo.getProjectByRootPath(root); const promotion = project ? await finalizeMemorySession(project.id, id) : null; console.log(options.json ? JSON.stringify({ ...result, promotion }) : `Session ${result.status}: ${result.id}`); await closeDb(); } catch (error: any) { reportCommandFailure(options.json, 'Error finishing session', error); }
});
sessionCommand.command('recover').option('--json').action(async (options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const recovered = await recoverAbandonedSessions(); const purgedEventCount = await purgeExpiredSessionEvents(); const result = { recoveredCount: recovered.length, purgedEventCount }; console.log(options.json ? JSON.stringify(result) : `Recovered: ${result.recoveredCount}; purged events: ${result.purgedEventCount}`); await closeDb(); } catch (error: any) { reportCommandFailure(options.json, 'Error recovering sessions', error); }
});

// --- 13. AGENT LIFECYCLE COMMAND ---
program
  .command('agent-event')
  .description('Receive a bounded lifecycle event from an agent host hook')
  .argument('<event>', 'session-start, session-event, session-stop, or session-recover')
  .option('--session <id>')
  .option('--title <title>')
  .option('--query <query>')
  .option('--agent <agent>')
  .option('--type <type>')
  .option('--status <status>')
  .option('--summary <summary>')
  .option('--command <command>')
  .option('--exit-code <code>')
  .option('--json')
  .action(async (event, options) => {
    try {
      if (!isLifecycleEvent(event)) throw new Error('Unsupported agent lifecycle event.');
      const payload = await readLifecyclePayload();
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const sessionId = options.session ?? stringPayloadValue(payload, 'session');
      let result: unknown;

      if (event === 'session-start') {
        const title = options.title ?? stringPayloadValue(payload, 'title');
        if (!title) throw new Error('Agent lifecycle session-start requires a title.');
        const project = await repo.getProjectByRootPath(root);
        if (!project) throw new Error('Project not found in database.');
        const bootstrap = await bootstrapAgentSession({ projectId: project.id, title, query: options.query ?? stringPayloadValue(payload, 'query'), agent: options.agent ?? stringPayloadValue(payload, 'agent'), sessionId });
        result = { ...bootstrap.session, context: bootstrap.context, contextTruncated: bootstrap.truncated };
      } else if (event === 'session-event') {
        if (!sessionId) throw new Error('Agent lifecycle session-event requires --session.');
        const type = options.type ?? stringPayloadValue(payload, 'type');
        if (!isSessionEventType(type)) throw new Error('Agent lifecycle session-event requires a valid type.');
        result = await captureMemorySessionEvent(sessionId, type, {
          ...payload,
          command: options.command ?? stringPayloadValue(payload, 'command'),
          summary: options.summary ?? stringPayloadValue(payload, 'summary'),
          exitCode: options.exitCode === undefined ? payload.exitCode : Number(options.exitCode),
        });
      } else if (event === 'session-stop') {
        if (!sessionId) throw new Error('Agent lifecycle session-stop requires --session.');
        const status = options.status ?? stringPayloadValue(payload, 'status');
        if (status !== 'finished' && status !== 'failed') throw new Error('Agent lifecycle session-stop requires status finished or failed.');
        const session = await finishMemorySession(sessionId, status, options.summary ?? stringPayloadValue(payload, 'summary'));
        const project = await repo.getProjectByRootPath(root);
        result = { ...session, promotion: project ? await finalizeMemorySession(project.id, sessionId) : null };
      } else {
        const recovered = await recoverAbandonedSessions();
        result = { recoveredCount: recovered.length, purgedEventCount: await purgeExpiredSessionEvents() };
      }

      console.log(options.json ? JSON.stringify(result) : 'Agent lifecycle event handled.');
      await closeDb();
    } catch (error: any) {
      if (event === 'session-event' && /Memory session not found|terminal memory session/.test(String(error?.message))) {
        console.log(options.json ? JSON.stringify({ accepted: false, reason: 'event-loss' }) : 'Agent lifecycle event dropped.');
        await closeDb().catch(() => {});
        return;
      }
      await closeDb().catch(() => {});
      reportCommandFailure(options.json, 'Error handling agent lifecycle event', error);
    }
  });

program
  .command('agent-reminder')
  .description('Emit fixed workflow guidance for an agent host prompt hook')
  .argument('<host>', 'claude')
  .option('--json')
  .action(host => {
    try {
      console.log(JSON.stringify(createAgentReminderOutput(host)));
    } catch (error: any) {
      console.error(`Error emitting agent reminder: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('agent-hook')
  .description('Translate a project-local agent host hook into bounded Knowl memory events')
  .argument('<host>', 'codex, claude, cursor, claude-desktop, or generic')
  .argument('<event>', 'host lifecycle event name')
  .option('--json')
  // Registered so `knowl --help` still describes it, but a real hook invocation never
  // reaches here: `src/index.ts` dispatches straight to `runAgentHook` so that a hook
  // process does not construct the whole command surface first. See that module.
  .action(async (host, event) => runAgentHook(host, event));

// --- 14. TASK COMMAND ---
const taskCommand = program
  .command('task')
  .description('Run a manual Knowl work loop around multi-step execution');

taskCommand
  .command('start')
  .description('Start a work loop, query relevant memory, and store active task state')
  .argument('<title>', 'Task title')
  .option('-q, --query <query>', 'Focused query for relevant memory lookup')
  .action(async (title, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = await startWorkLoop(project.id, title, options.query);
      console.log('KNOWL WORK LOOP START');
      console.log(`Task ID: ${result.taskId}`);
      console.log(`Query: ${result.query}`);
      printRelevantMemory(result.relevantMemory);

      await closeDb();
    } catch (error: any) {
      console.error(`Error starting work loop: ${error.message}`);
      process.exit(1);
    }
  });

taskCommand
  .command('checkpoint')
  .description('Store durable progress for an active work loop')
  .argument('<taskId>', 'Task ID returned by knowl task start')
  .argument('<summary>', 'Checkpoint summary')
  .option('--goal <goal>', 'Optional current goal for resumable handoffs')
  .option('--completed <item>', 'Optional completed step; repeatable', (value: string, previous: string[] = []) => previous.concat(value), [])
  .option('--next-action <nextAction>', 'Optional next action to resume with')
  .option('--blocker <blocker>', 'Optional current blocker')
  .option('--artifact <ref>', 'Optional artifact or file reference; repeatable', (value: string, previous: string[] = []) => previous.concat(value), [])
  .option('--verification-status <status>', 'Optional verification status such as unverified, tests-passing, or needs-review')
  .action(async (taskId, summary, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = await checkpointWorkLoop(project.id, taskId, {
        summary,
        goal: options.goal,
        completed: options.completed,
        nextAction: options.nextAction,
        blocker: options.blocker,
        artifactRefs: options.artifact,
        verificationStatus: options.verificationStatus,
      });
      console.log('KNOWL WORK LOOP CHECKPOINT');
      console.log(`Task ID: ${result.taskId}`);
      console.log(`Checkpoint ID: ${result.itemId}`);
      if (result.taskState) {
        if (result.taskState.goal) console.log(`Goal: ${result.taskState.goal}`);
        if (result.taskState.completed?.length) console.log(`Completed: ${result.taskState.completed.join('; ')}`);
        if (result.taskState.nextAction) console.log(`Next action: ${result.taskState.nextAction}`);
        if (result.taskState.blocker) console.log(`Blocker: ${result.taskState.blocker}`);
        if (result.taskState.artifactRefs?.length) console.log(`Artifacts: ${result.taskState.artifactRefs.join(', ')}`);
        if (result.taskState.verificationStatus) console.log(`Verification: ${result.taskState.verificationStatus}`);
      }

      await closeDb();
    } catch (error: any) {
      console.error(`Error recording work loop checkpoint: ${error.message}`);
      process.exit(1);
    }
  });

taskCommand
  .command('finish')
  .description('Store durable completion state for a work loop')
  .argument('<taskId>', 'Task ID returned by knowl task start')
  .argument('<summary>', 'Completion summary')
  .action(async (taskId, summary) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = await finishWorkLoop(project.id, taskId, summary);
      console.log('KNOWL WORK LOOP FINISH');
      console.log(`Task ID: ${result.taskId}`);
      console.log(`Finish ID: ${result.itemId}`);

      await closeDb();
    } catch (error: any) {
      console.error(`Error finishing work loop: ${error.message}`);
      process.exit(1);
    }
  });

taskCommand
  .command('run')
  .description('Start a work loop, run a command, then finish on success or checkpoint on failure')
  .argument('<title>', 'Task title')
  .argument('[command...]', 'Command and arguments to run after --')
  .option('-q, --query <query>', 'Focused query for relevant memory lookup')
  .action(async (title, commandParts: string[], options) => {
    const command = commandParts[0];
    const commandArgs = commandParts.slice(1);

    if (!command) {
      console.error('Error running work loop command: missing command after --');
      process.exit(1);
    }

    let root: string;
    let taskId: string;
    try {
      root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const startResult = await startWorkLoop(project.id, title, options.query);
      taskId = startResult.taskId;
      console.log('KNOWL WORK LOOP START');
      console.log(`Task ID: ${startResult.taskId}`);
      console.log(`Query: ${startResult.query}`);
      printRelevantMemory(startResult.relevantMemory);
      await closeDb();

      const child = spawnWorkLoopCommand(command, commandArgs);

      await initDb(root);
      const reopenedProject = await repo.getProjectByRootPath(root);
      if (!reopenedProject) throw new Error('Project not found in database.');

      const commandText = formatCommand(command, commandArgs);
      if (child.error) {
        if (startResult.memorySessionId) await captureMemorySessionEvent(startResult.memorySessionId, 'command', { command: commandText, exitCode: 1, summary: 'Command failed to start.' });
        const summary = `Command failed to start: ${commandText} (${child.error.message})`;
        const checkpoint = await checkpointWorkLoop(reopenedProject.id, taskId, summary);
        console.log('KNOWL WORK LOOP CHECKPOINT');
        console.log(`Task ID: ${checkpoint.taskId}`);
        console.log(`Checkpoint ID: ${checkpoint.itemId}`);
        console.log(summary);
        await closeDb();
        process.exit(1);
      }

      const exitCode = child.status ?? 1;
      if (startResult.memorySessionId) await captureMemorySessionEvent(startResult.memorySessionId, 'command', { command: commandText, exitCode, summary: exitCode === 0 ? 'Command succeeded.' : 'Command failed.' });
      if (exitCode === 0) {
        const finish = await finishWorkLoop(reopenedProject.id, taskId, `Command succeeded: ${commandText}`);
        console.log('KNOWL WORK LOOP FINISH');
        console.log(`Task ID: ${finish.taskId}`);
        console.log(`Finish ID: ${finish.itemId}`);
        await closeDb();
        process.exit(0);
      }

      const summary = `Command failed with exit code ${exitCode}: ${commandText}`;
      const checkpoint = await checkpointWorkLoop(reopenedProject.id, taskId, summary);
      console.log('KNOWL WORK LOOP CHECKPOINT');
      console.log(`Task ID: ${checkpoint.taskId}`);
      console.log(`Checkpoint ID: ${checkpoint.itemId}`);
      console.log(summary);
      await closeDb();
      process.exit(exitCode);
    } catch (error: any) {
      try {
        await closeDb();
      } catch {
        // Ignore close errors while reporting the root cause.
      }
      console.error(`Error running work loop command: ${error.message}`);
      process.exit(1);
    }
  });

// --- 13. SKILL COMMAND ---
const skillCommand = program
  .command('skill')
  .description('Manage learned file-backed skill packages under .knowl/skills');

skillCommand
  .command('list')
  .description('List learned skill packages')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const skills = await listSkillPackages(root);
      if (skills.length === 0) {
        console.log('No learned skills.');
        return;
      }
      for (const skill of skills) {
        console.log(`${skill.name}\t${skill.purpose}`);
      }
    } catch (error: any) {
      console.error(`Error listing skills: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('read')
  .description('Read one learned skill package')
  .argument('<name>', 'Skill name')
  .action(async (name) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const skill = await readSkillPackage(root, name);
      console.log(JSON.stringify(skill.manifest, null, 2));
      console.log('');
      console.log(skill.markdown);
    } catch (error: any) {
      console.error(`Error reading skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('create')
  .description('Create a learned file-backed skill package and index it in Knowl')
  .argument('<name>', 'Skill name')
  .requiredOption('--purpose <purpose>', 'One-sentence purpose for the skill')
  .option('--markdown <markdown>', 'Content for SKILL.md')
  .option('--trigger <phrase>', 'Trigger phrase for discovery', collectOption, [])
  .option('--file <path=content>', 'File to create inside the skill package', collectOption, [])
  .option('--script <path>', 'Default script entrypoint path')
  .option('--fallback-shell <command>', 'Fallback shell command entrypoint')
  .action(async (name, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const skill = await createSkillPackage(root, {
        name,
        purpose: options.purpose,
        markdown: options.markdown,
        triggers: options.trigger || [],
        files: parseSkillFiles(options.file || []),
        entrypoints: createSkillEntrypoints({
          script: options.script,
          fallbackShell: options.fallbackShell,
        }),
      });

      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');
      await indexSkillPackage(project.id, skill.manifest);
      await closeDb();

      console.log(`Created skill ${skill.manifest.name}`);
    } catch (error: any) {
      try {
        await closeDb();
      } catch {
        // Ignore close errors while reporting the root cause.
      }
      console.error(`Error creating skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('run')
  .description('Run a learned skill package entrypoint')
  .argument('<name>', 'Skill name')
  .argument('[args...]', 'Optional runtime args')
  .option('-e, --entrypoint <entrypoint>', 'Entrypoint name', 'default')
  .action(async (name, args: string[], options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = await runSkillPackage(root, name, options.entrypoint, args || []);
      await recordSkillRun(project.id, name, result.exitCode === 0);
      await closeDb();

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    } catch (error: any) {
      try {
        await closeDb();
      } catch {
        // Ignore close errors while reporting the root cause.
      }
      console.error(`Error running skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('approve')
  .description('Approve a skill package for execution, pinned to its current contents')
  .argument('<name>', 'Skill package name')
  .option('--entrypoint <name...>', 'Approve only these entrypoints (defaults to all)')
  .action(async (name, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const record = await approveSkill(root, name, {
        approvedBy: `cli:${process.env.USER ?? process.env.USERNAME ?? 'unknown'}`,
        allowedEntrypoints: options.entrypoint,
      });
      console.log(`Approved skill "${name}".`);
      console.log(`Hash: ${record.approvedHash}`);
      console.log(`Entrypoints: ${record.allowedEntrypoints.join(', ')}`);
      console.log('Any change to the package revokes this approval.');
    } catch (error: any) {
      console.error(`Error approving skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('revoke')
  .description('Withdraw approval for a skill package')
  .argument('<name>', 'Skill package name')
  .action(async name => {
    try {
      const root = await findProjectRoot(process.cwd());
      const removed = await revokeSkill(root, name);
      console.log(removed ? `Revoked skill "${name}".` : `Skill "${name}" was not approved.`);
    } catch (error: any) {
      console.error(`Error revoking skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('trust')
  .description('List approved skill packages')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const trust = await listTrust(root);
      const names = Object.keys(trust).sort();
      if (names.length === 0) {
        console.log('No skill package is approved for execution.');
        return;
      }
      for (const name of names) {
        const record = trust[name];
        console.log(`${name}\t${record.approvedHash}\t${record.approvedAt}\t${record.allowedEntrypoints.join(',')}`);
      }
    } catch (error: any) {
      console.error(`Error listing skill trust: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('evidence')
  .description('List the provenance evidence linked to one knowledge item')
  .argument('<item-id>', 'Knowledge item ID')
  .action(async (itemId) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const evidence = await Promise.all((await listEvidenceForItem(itemId)).map(async item => {
        const symbol = item.type === 'symbol' ? await resolveSymbolEvidence(item) : null;
        return { ...item, stale: symbol?.stale ?? await isEvidenceStale(item, root), suggestedLocator: symbol?.suggestedLocator };
      }));
      for (const item of evidence) {
        console.log(`${item.relationship}\t${item.type}\t${item.locator}\t${item.stale ? 'stale' : 'current'}${item.suggestedLocator ? `\tsuggested: ${item.suggestedLocator}` : ''}${item.excerpt ? `\t${item.excerpt}` : ''}`);
      }
      if (evidence.length === 0) console.log('No evidence.');
      await closeDb();
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error listing evidence: ${error.message}`);
      process.exit(1);
    }
  });

// --- 14. PR COMMAND ---
program
  .command('pr')
  .description('Mark knowledge tied to changed files as needing review')
  .requiredOption('--since <commit>', 'Base commit to compare against')
  .option('--dry-run', 'Preview impacted knowledge without marking it')
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const currentCommit = getCurrentGitCommit(root);
      const changedFiles = listChangedFilesSince(root, options.since, currentCommit);
      const result = await checkKnowledgeDrift(project.id, {
        sinceCommit: options.since,
        currentCommit,
        changedFiles,
        apply: !options.dryRun,
        projectRoot: root,
        // A rename leaves the old path absent from the tree, so without this a refactor reads as
        // a mass deletion of everything it touched.
        renamedFrom: listRenamedPathsSince(root, options.since, currentCommit),
        // `pr check` is the deliberate, on-demand pass, so it also examines affected paths git
        // cannot diff -- untracked or ignored working directories an atom names. The automatic
        // session-start check still does NOT ask for this; it passes `projectRoot` alone, which
        // since 2026-08-13 buys it removal-vs-edit classification without the extra scan.
        includeUntracked: true,
      });

      printPrCheckResult(result);

      /**
       * Tell the team, from the one place that should.
       *
       * `reportDrift` shipped complete, gated and tested with no production caller at all. It gets
       * one here rather than at session start, because this is the deliberate pass a human runs:
       * session start must stay offline, and a network call per session on a signal nobody asked
       * for is how the last version of this became noise.
       *
       * Every refusal is silent by design. `reportDrift` returns `not-connected` for a local repo,
       * `not-published` for an atom the team has never seen, and `gated` off the default branch or
       * behind its remote -- a drift report retires knowledge for everyone, so it keeps the vantage
       * requirement that publishing gave up. None of those is a failure of `pr check`, and none
       * should make it exit non-zero.
       */
      const prCheckConfig = await loadConfig(root);
      if (prCheckConfig.cloud && !options.dryRun && result.candidates.length > 0) {
        const reported: string[] = [];
        for (const candidate of result.candidates) {
          // The reason is stored on the report and read by whoever reviews it, so it names the
          // evidence rather than restating the verdict: which cited paths went away, and the kind
          // of drift this was.
          const evidence = candidate.removedPaths.length > 0
            ? candidate.removedPaths.join(', ')
            : candidate.matchedPaths.join(', ');
          const outcome = await reportDrift({
            projectRoot: root,
            config: prCheckConfig,
            itemId: candidate.itemId,
            reason: `${candidate.kind}: ${evidence}`,
          }).catch(() => 'not-connected' as const);
          if (outcome === 'reported') reported.push(candidate.itemId);
        }
        if (reported.length > 0) {
          console.log(`Reported ${reported.length} of ${result.candidates.length} to the team.`);
        }
      }

      await closeDb();
    } catch (error: any) {
      try {
        await closeDb();
      } catch {
        // Ignore close errors while reporting the root cause.
      }
      console.error(`Error checking PR drift: ${error.message}`);
      process.exit(1);
    }
  });

// --- 15. DOCTOR COMMAND ---
program
  .command('audit')
  .description('Read-only integrity audit for stored knowledge')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      await initDb(root);
      const report = await auditKnowledgeStore(config.security);
      console.log('KNOWL INTEGRITY AUDIT');
      if (report.findings.length === 0) {
        console.log('No integrity findings.');
      } else {
        for (const finding of report.findings) {
          console.log(`[${finding.severity.toUpperCase()}] ${finding.code}${finding.itemId ? ` ${finding.itemId}` : ''}: ${finding.detail}`);
        }
      }
      await closeDb();
      if (report.findings.some(finding => finding.severity === 'error')) process.exitCode = 1;
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error auditing knowledge: ${error.message}`);
      process.exit(1);
    }
  });

const snapshotCommand = program
  .command('snapshot')
  .description('Create and restore safe local database snapshots');

snapshotCommand
  .command('create')
  .description('Create a timestamped snapshot with a checksum manifest')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const snapshot = await createSnapshot(root);
      await closeDb();
      console.log('KNOWL SNAPSHOT CREATED');
      console.log(`Snapshot: ${snapshot.path}`);
      console.log(`Manifest: ${snapshot.manifestPath}`);
      console.log(`SHA-256: ${snapshot.manifest.sha256}`);
      // Named, not counted. A snapshot that disappears without being named is the thing
      // someone goes looking for later.
      for (const pruned of snapshot.pruned) console.log(`Pruned: ${pruned}`);
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error creating snapshot: ${error.message}`);
      process.exit(1);
    }
  });

snapshotCommand
  .command('restore')
  .description('Restore a snapshot after creating a pre-restore snapshot')
  .argument('<path>', 'Snapshot database path')
  .requiredOption('--confirm', 'Confirm the destructive restore operation')
  .option(
    '--accept-origin-mismatch',
    'Restore a snapshot whose recorded origin is a different path than this repository. ' +
    'For a repo that moved or was renamed since the snapshot; restoring another project\'s ' +
    'snapshot replaces this one\'s memory with it.',
  )
  .action(async (snapshotPath, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const result = await restoreSnapshot(root, snapshotPath, {
        confirm: options.confirm,
        acceptOriginMismatch: options.acceptOriginMismatch,
      });
      await closeDb();
      console.log('Snapshot restored.');
      console.log(`Pre-restore snapshot: ${result.preRestore.path}`);
      console.log(`Integrity findings: ${result.findings.length}`);
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error restoring snapshot: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check whether the current Knowl project is ready for agent memory usage')
  .option('--fix', 'Apply the repairs that are safe to automate, then re-check')
  .option('--reindex', 'With --fix, also re-embed items missing vector coverage (slow)')
  .action(async (options: { fix?: boolean; reindex?: boolean }) => {
    let result = await runDoctor(process.cwd());

    if (options.fix) {
      const root = await findProjectRoot(process.cwd());
      const fixes = await applyDoctorRemedies(root, result.checks, { reindex: options.reindex });

      if (fixes.applied.length > 0) console.log(`Fixed: ${fixes.applied.join(', ')}`);
      for (const failure of fixes.failed) console.log(`Could not fix ${failure.remedy}: ${failure.error}`);
      if (fixes.deferred.length > 0) console.log(`Skipped (needs --reindex): ${fixes.deferred.join(', ')}`);
      if (fixes.applied.length === 0 && fixes.failed.length === 0 && fixes.deferred.length === 0) {
        console.log('Nothing to fix automatically.');
      }
      console.log('');

      // Re-checked rather than assumed. A repair that reported success without resolving its
      // finding is precisely what an automatic fix must not be able to hide.
      result = await runDoctor(root);
    }

    console.log(formatDoctorReport(result));

    // Set the code instead of process.exit(), and set it here rather than after the
    // best-effort update check below: a hard exit while sockets/timers are still
    // tearing down crashes the process on Windows (STATUS_STACK_BUFFER_OVERRUN)
    // instead of reporting status 1, and the exit code must not depend on the
    // timing of an unrelated network call that is allowed to be slow or fail.
    if (!result.ready) {
      process.exitCode = 1;
    }

    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      if (isUpdateCheckEnabled(config)) {
        // `ttlMs: 0`, unlike `status`, so this always asks the registry.
        //
        // The day-long cache is right for a command run in passing and wrong for the one command
        // whose entire job is to report what is true right now. Measured 2026-08-08: 3.4.0
        // published at 10:18Z against a cache written at 05:14Z, and `doctor` went on reporting
        // a healthy 3.3.0 for the rest of the day -- a diagnostic that cannot be made to look
        // again is one you stop believing.
        //
        // Costs at most `FETCH_TIMEOUT_MS` (2s) on a deliberate, already-slow command, fails
        // silently offline like every other caller, and still refreshes the shared cache so the
        // next `knowl status` benefits.
        const update = await checkForUpdate({
          packageName: PACKAGE_NAME, currentVersion: PACKAGE_VERSION, projectRoot: root, ttlMs: 0,
        });
        if (update?.updateAvailable) console.log(formatUpdateNotice(update, PACKAGE_NAME));
      }
    } catch {
      // never let the update check affect doctor's verdict
    }
  });

// --- 16. SERVE COMMAND ---
program
  .command('serve')
  .description('Start the Model Context Protocol (MCP) server for KNOWL')
  .action(async () => {
    try {
      console.error(`🚀 Starting KNOWL MCP Server...`);
      // Imported here, not at module scope: the MCP SDK costs ~530ms to load and only this
      // command needs it, so every other CLI invocation was paying for it.
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer();
    } catch (error: any) {
      console.error(`❌ Failed to start MCP Server: ${error.message}`);
      process.exit(1);
    }
  });

// --- 17. STARTUP DIAGNOSTICS ---
program
  .command('diagnose-startup')
  .description('Report why `knowl serve` startups were slow: per-phase timings, SQLite contention, stalls and host kills')
  .option('--since <hours>', 'How far back to look', '48')
  .option('--clear', 'Delete the machine-wide startup diagnostics log')
  .action(async (options) => {
    if (options.clear) {
      const { clearStartupLog, startupLogPath } = await import('../core/startup-trace.js');
      const file = startupLogPath();
      clearStartupLog();
      console.log(`Cleared ${file}`);
      return;
    }
    const { formatStartupReport } = await import('./startup-report.js');
    const hours = Number(options.since);
    if (!Number.isFinite(hours) || hours <= 0) {
      console.error('--since must be a positive number of hours');
      process.exit(1);
    }
    console.log(formatStartupReport(hours));
  });

return program;
}

/**
 * Build the tree and run it against argv.
 *
 * Separate from `buildProgram` and NOT run on import. Parsing at module scope meant that merely
 * importing this file consumed whatever argv the host process happened to have -- under vitest
 * that is the runner's own arguments, and the first unrecognised one called `process.exit(1)`
 * before a single assertion ran. `src/index.ts` calls this explicitly instead.
 */
export function runProgram(argv: string[] = process.argv): void {
  buildProgram().parse(argv);
}
