#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';
import { checkForUpdate, formatUpdateNotice, isUpdateCheckEnabled } from './core/version-check.js';
import { NEW_PROJECT_CONFIG, findProjectRoot, loadConfig, saveConfig, hasAiConfigured, upgradeConfigDefaults } from './core/config.js';
import {
  installKnowlProjectGuidance,
  KnowlProjectGuidanceInstallResult,
} from './core/agents-guidance.js';
import { installKnowlGitignoreEntry } from './core/gitignore.js';
import { initDb, closeDb } from './store/database.js';
import * as repo from './store/repository.js';
import { recordDecisionDirect } from './store/knowledge-actions.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from './store/queries.js';
import { formatHierarchyToMarkdown } from './core/format.js';
import { formatStatusReport } from './cli/status-report.js';
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from './core/types.js';
import { createManifest, isValidRepoName, readManifest, writeManifest } from './workspace/manifest.js';
import { listKnownWorkspaces, workspaceManifestPath } from './workspace/paths.js';
import { assertSafeToLink, backfillOriginRepo, countOwnedItems, joinWorkspace, leaveWorkspace } from './workspace/membership.js';
import { promoteItems } from './workspace/promote.js';
import { existingItemsNotice, visibilityGateNotice } from './cli/workspace-visibility-notice.js';
import { repoEntry, updateRepoSettings } from './workspace/repo-settings.js';
import { runCliQuery } from './cli/query-command.js';
import { formatCrossRepoNotice } from './cli/cross-repo-notice.js';
import { formatWorkspaceBlock } from './cli/workspace-report.js';
import { resolveWorkspace } from './workspace/resolve.js';
import { formatDoctorReport, runDoctor } from './cli/doctor-report.js';
import { upgradeExistingRepository, type UpgradeResult } from './cli/upgrade.js';
import { recordKnownRepo } from './cli/repo-registry.js';
import { discoverRepos } from './cli/repo-discovery.js';
import { applyDoctorRemedies } from './cli/doctor-fix.js';
import { formatSweepReport, sweepRepos } from './cli/upgrade-all.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from './ai/embeddings.js';
import { getConfigValue, resetAllConfig, resetConfigValue, setConfigValue } from './cli/config/service.js';
import { runConfigUi } from './cli/config/ui.js';
import { DEFAULT_DIVERGENCE_POLICY, DIVERGENCE_POLICIES } from './store/import-policy.js';
import { formatAgentInitSummary, runAgentInitFlow } from './cli/init-flow.js';
import { formatWarmResult, warmEmbeddingModel } from './cli/warm-embeddings.js';
import { parseAgentNames } from './cli/agents/registry.js';
import { reindexKnowledgeEmbeddings } from './store/vector-index.js';
import { applyKnowledgeGc, previewKnowledgeGc, isHot } from './store/gc.js';
import { getAccessSummary } from './store/access-feedback.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop, WorkLoopMemoryHit } from './store/work-loop.js';
import { checkKnowledgeDrift, DriftCheckResult, getCurrentGitCommit, listChangedFilesSince } from './store/drift.js';
import { indexSkillPackage, recordSkillRun } from './skills/knowledge-index.js';
import { createSkillPackage, listSkillPackages, readSkillPackage, runSkillPackage, SkillEntrypoint } from './skills/registry.js';
import { auditKnowledgeStore } from './store/integrity.js';
import { createSnapshot, restoreSnapshot } from './store/snapshots.js';
import { isEvidenceStale, listEvidenceForItem, resolveSymbolEvidence } from './store/evidence-repository.js';
import { queryKnowledgeForAgent } from './store/agent-query.js';
import { evaluateRetrieval, RetrievalEvaluationCase } from './store/retrieval-evaluation.js';
import { getKnowledgeAccessReport } from './store/access-feedback.js';
import { finishMemorySession, purgeExpiredSessionEvents, recoverAbandonedSessions, startMemorySession } from './store/session-repository.js';
import { captureMemorySessionEvent } from './store/session-capture.js';
import { finalizeMemorySession } from './store/session-finalizer.js';
import { isLifecycleEvent, isSessionEventType, readLifecyclePayload, stringPayloadValue } from './cli/agents/lifecycle.js';
import { IncompleteHostHookPayloadError, normalizeHostHook } from './cli/agents/host-hook.js';
import { bootstrapAgentSession } from './store/context-bootstrap.js';
import { handleHostLifecycleEvent } from './store/host-lifecycle.js';
import { listAssertions } from './store/assertions.js';
import { listActiveConflictKeys } from './store/conflicts.js';
import { composeContext } from './store/context-composer.js';
import { indexCode, listCodeSymbols } from './code/symbol-index.js';
import { exportKnowledge, importKnowledge } from './store/portability.js';
import { synthesizeKnowledge } from './store/synthesis.js';
import { startViewer } from './viewer/server.js';
import { createAgentReminderOutput } from './cli/agents/reminder.js';
import { hostProfile } from './cli/agents/hosts/index.js';

// Load environment variables (.env file)
dotenv.config();

const program = new Command();

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

function hasPathSeparator(command: string) {
  return command.includes('/') || command.includes('\\');
}

function resolveWindowsCommand(command: string) {
  const ext = path.extname(command);
  if (ext) return command;

  const pathEntries = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const pathExts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const searchDirs = hasPathSeparator(command) ? [''] : [process.cwd(), ...pathEntries];

  for (const dir of searchDirs) {
    for (const pathExt of pathExts) {
      const candidate = dir ? path.join(dir, `${command}${pathExt}`) : `${command}${pathExt}`;
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

function isWindowsBatchCommand(command: string) {
  const resolved = resolveWindowsCommand(command);
  const ext = path.extname(resolved).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function spawnWorkLoopCommand(command: string, args: string[]) {
  const spawnOptions = {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit' as const,
  };

  if (process.platform !== 'win32') {
    return spawnSync(command, args, spawnOptions);
  }

  if (isWindowsBatchCommand(command)) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args], spawnOptions);
  }

  return spawnSync(command, args, spawnOptions);
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
      let isExisting = false;
      try {
        await fs.access(knowlDir);
        isExisting = true;
      } catch {
        // Doesn't exist
      }

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
      const project = await repo.createProject(cwd, name);
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

program.command('timeline').argument('<itemId>').description('Show the recorded history of one knowledge item').action(async itemId => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listAssertions(itemId), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading timeline: ${error.message}`); process.exit(1); }
});

program.command('query').argument('[query]').description('Search project memory by keywords').option('--as-of <timestamp>').option('--limit <count>').action(async (query, options) => {
  try {
    const root = await findProjectRoot(process.cwd());
    await initDb(root);
    const project = await repo.getProjectByRootPath(root);
    if (!project) throw new Error('Project not found in database.');
    const limit = options.limit === undefined ? undefined : Number(options.limit);

    // One engine, whether or not this repo is linked and whether an agent or a human asked.
    // The ranking used to differ on both axes: this command read queryKnowledgeBase directly
    // while knowl_query used the shared ranker, and the workspace branch used the ranker while
    // the solo branch did not -- the same command disagreeing with itself.
    const { items, skipped } = await runCliQuery({
      projectRoot: root, projectId: project.id, query, limit, asOf: options.asOf,
    });

    console.log(JSON.stringify(items, null, 2));
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
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await repo.supersedeKnowledgeItem(itemId, replacementId), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error superseding knowledge: ${error.message}`); process.exit(1); }
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
  .option('--default-visibility <repo|workspace>', 'Visibility stamped on new writes here (default: repo)')
  .option('--kin <group>', 'Group name shared with repos of the same lineage')
  .option('--promote-existing', 'Also share knowledge already in this repo; requires --default-visibility workspace')
  .option('--force', 'Link even though .knowl/config.json is tracked by git')
  .action(async (workspaceName: string, options: { name?: string; role?: string; defaultVisibility?: string; kin?: string; promoteExisting?: boolean; force?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const repoName = options.name ?? path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const visibility = parseDefaultVisibility(options.defaultVisibility);

      // Rejected rather than ignored. A flag that silently does nothing is how you end up
      // believing a whole repo was shared when none of it was -- the same rule `knowl upgrade`
      // applies to its --all-only flags.
      if (options.promoteExisting && visibility !== 'workspace') {
        throw new Error('--promote-existing only applies with --default-visibility workspace, because it publishes everything this repo already knows.');
      }

      await joinWorkspace({
        projectRoot: root, workspaceName, repoName, force: options.force,
        settings: { role: options.role, kin: options.kin, defaultVisibility: visibility },
      });
      console.log(`Linked this repo as "${repoName}" in workspace "${workspaceName}".`);

      if (visibility === 'workspace') {
        console.log('');
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
      const result = await promoteItems({ projectRoot: root, repoName: active.repo, categories, ids: options.id, apply: options.apply });
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

const codeCommand = program.command('code').description('Index and inspect project code symbols');
codeCommand.command('index').action(async () => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); await indexCode(root); console.log('Code symbols indexed.'); await closeDb(); } catch (error: any) { console.error(`Error indexing code: ${error.message}`); process.exit(1); } });
codeCommand.command('symbols').argument('<path>').action(async filePath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listCodeSymbols(filePath), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading code symbols: ${error.message}`); process.exit(1); } });

program.command('export').argument('<path>').description('Write portable JSONL memory to a file').action(async outputPath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await exportKnowledge(project.id, path.resolve(outputPath), root), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error exporting knowledge: ${error.message}`); process.exit(1); } });

program.command('import').argument('<path>').description('Load portable JSONL memory from a file').option('--dry-run')
  .option('--on-divergence <policy>', `How to resolve items that differ locally: ${DIVERGENCE_POLICIES.join(', ')}`, DEFAULT_DIVERGENCE_POLICY)
  .action(async (inputPath, options) => {
    try {
      if (!DIVERGENCE_POLICIES.includes(options.onDivergence)) {
        throw new Error(`Unknown --on-divergence policy: ${options.onDivergence}. Expected one of: ${DIVERGENCE_POLICIES.join(', ')}`);
      }
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      console.log(JSON.stringify(await importKnowledge(path.resolve(inputPath), { dryRun: options.dryRun, projectRoot: root, onDivergence: options.onDivergence }), null, 2));
      await closeDb();
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error importing knowledge: ${error.message}`);
      process.exit(1);
    }
  });

program.command('synthesize').description('Summarize knowledge for a path or tag into one item').requiredOption('--scope <path-or-tag>').action(async options => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await synthesizeKnowledge(project.id, options.scope), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error synthesizing knowledge: ${error.message}`); process.exit(1); } });

program.command('view').description('Serve the local knowledge viewer in a browser').option('--port <port>').action(async options => { try { const root = await findProjectRoot(process.cwd()); const viewer = await startViewer(root, { port: options.port === undefined ? 0 : Number(options.port) }); console.log(`Knowl viewer: ${viewer.url}`); const stop = async () => { await viewer.close(); process.exit(0); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); } catch (error: any) { console.error(`Error starting viewer: ${error.message}`); process.exit(1); } });


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
        const { initAI } = await import('./ai/provider.js');
        const { runDecisionPipeline } = await import('./pipeline/pipeline.js');
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
      const { initAI, askQuestion } = await import('./ai/provider.js');
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
      const { initAI } = await import('./ai/provider.js');
      const { runPipeline } = await import('./pipeline/pipeline.js');
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

// --- 7. CONFIG COMMAND ---
const configCommand = program
  .command('config')
  .description('Interactively view or edit repository configuration');

configCommand.action(async () => {
  try {
    const commandIndex = process.argv.lastIndexOf('config');
    if (commandIndex >= 0 && process.argv.slice(commandIndex + 1).length > 0) {
      throw new Error('Use `knowl config set <key> <value>` or `knowl config get <key>`.');
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Interactive config requires a TTY. Use `knowl config get`, `set`, or `reset`.');
    }
    await runConfigUi(await findProjectRoot(process.cwd()));
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
      const value = await getConfigValue(await findProjectRoot(process.cwd()), key);
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
      const typedValue = await setConfigValue(await findProjectRoot(process.cwd()), key, value);
      console.log(`Set ${key} = ${JSON.stringify(typedValue)}`);
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
        if (!process.stdin.isTTY || !process.stdout.isTTY || !(await (await import('@inquirer/prompts')).confirm({ message: 'Reset all configuration to defaults?', default: false }))) {
          throw new Error('Reset cancelled. Use `--yes` for non-interactive full reset.');
        }
      }
      const root = await findProjectRoot(process.cwd());
      if (key) await resetConfigValue(root, key);
      else await resetAllConfig(root);
      console.log(key ? `Reset ${key}` : 'Reset all configuration to defaults');
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
  .action(async (options) => {
    try {
      if (!options.vectors) {
        throw new Error('Nothing to reindex. Pass --vectors to rebuild vector embeddings.');
      }

      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      if (!isVectorSearchEnabled(config)) {
        throw new Error('Vector search is not enabled. Set search.vector.enabled true before running vector reindex.');
      }

      await initDb(root);
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
      const result = await reindexKnowledgeEmbeddings(project.id, embedder);
      console.log(`Indexed ${result.indexed} vector embedding(s).`);
      await closeDb();
    } catch (error: any) {
      console.error(`Error reindexing: ${error.message}`);
      process.exit(1);
    }
  });

// --- 9. RETRIEVAL EVALUATION COMMAND ---
program
  .command('eval')
  .description('Run checked-in retrieval evaluation datasets')
  .command('retrieval')
  .description('Evaluate agent retrieval against a dataset')
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
        await reindexKnowledgeEmbeddings(project.id, embedder);
      }

      const evaluation = await evaluateRetrieval(cases, async (testCase) => {
        const startedAt = Date.now();
        const vectorOption = embedder
          ? { enabled: true, provider: embedder.provider, model: embedder.model, embedding: (await embedder.embed([testCase.query]))[0] }
          : undefined;
        const items = await queryKnowledgeForAgent(project.id, {
          query: testCase.query,
          status: 'active',
          surface: 'cli_eval',
          limit: testCase.limit,
          vector: vectorOption,
        });
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
        console.log(`Failed cases: ${result.failedCaseIds.join(', ') || 'none'}`);
      }
      await closeDb();
      if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    } catch (error: any) {
      console.error(`Error evaluating retrieval: ${error.message}`);
      process.exit(1);
    }
  });

// --- 10. ACCESS REPORT COMMAND ---
program
  .command('access')
  .description('Inspect retrieval access feedback')
  .command('report')
  .description('Show high-value, stale, and corrected knowledge')
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
        staleStateDays: options.staleDays !== undefined ? Number(options.staleDays) : undefined,
        compressArchivedDays: options.compressDays !== undefined ? Number(options.compressDays) : undefined,
        minCompressBytes: options.minBytes !== undefined ? Number(options.minBytes) : undefined,
        ignoreAccess: Boolean(options.ignoreAccess),
        tombstoneDays: options.tombstoneDays !== undefined ? Number(options.tombstoneDays) : undefined,
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

// --- 12. SESSION COMMAND ---
const sessionCommand = program.command('session').description('Capture bounded temporary session memory');
sessionCommand.command('start').argument('<title>').option('-q, --query <query>').option('--agent <agent>').option('--json').action(async (title, options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await startMemorySession({ title, query: options.query, agent: options.agent }); console.log(options.json ? JSON.stringify(result) : `Session started: ${result.id}`); await closeDb(); } catch (error: any) { console.error(`Error starting session: ${error.message}`); process.exit(1); }
});
sessionCommand.command('event').argument('<id>').argument('<type>').option('--exit-code <code>').option('--summary <summary>').option('--command <command>').option('--json').action(async (id, type, options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await captureMemorySessionEvent(id, type, { exitCode: options.exitCode === undefined ? undefined : Number(options.exitCode), summary: options.summary, command: options.command }); console.log(options.json ? JSON.stringify(result) : `Session event recorded: ${result.id}`); await closeDb(); } catch (error: any) { console.error(`Error recording session event: ${error.message}`); process.exit(1); }
});
sessionCommand.command('finish').argument('<id>').requiredOption('--status <status>', 'finished or failed').option('--summary <summary>').option('--json').action(async (id, options) => {
  try { if (options.status !== 'finished' && options.status !== 'failed') throw new Error('Status must be finished or failed.'); const root = await findProjectRoot(process.cwd()); await initDb(root); const result = await finishMemorySession(id, options.status, options.summary); const project = await repo.getProjectByRootPath(root); const promotion = project ? await finalizeMemorySession(project.id, id) : null; console.log(options.json ? JSON.stringify({ ...result, promotion }) : `Session ${result.status}: ${result.id}`); await closeDb(); } catch (error: any) { console.error(`Error finishing session: ${error.message}`); process.exit(1); }
});
sessionCommand.command('recover').option('--json').action(async (options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const recovered = await recoverAbandonedSessions(); const purgedEventCount = await purgeExpiredSessionEvents(); const result = { recoveredCount: recovered.length, purgedEventCount }; console.log(options.json ? JSON.stringify(result) : `Recovered: ${result.recoveredCount}; purged events: ${result.purgedEventCount}`); await closeDb(); } catch (error: any) { console.error(`Error recovering sessions: ${error.message}`); process.exit(1); }
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
      console.error(`Error handling agent lifecycle event: ${error.message}`);
      await closeDb().catch(() => {});
      process.exit(1);
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
  .action(async (host, event) => {
    try {
      const payload = await readLifecyclePayload();
      const normalized = normalizeHostHook(host, event, payload);
      const root = await findProjectRoot(normalized.projectRoot);
      normalized.projectRoot = root;
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');
      const result = await handleHostLifecycleEvent(project.id, normalized);
      if (result.hostOutput) console.log(JSON.stringify(result.hostOutput));
      else if (!hostProfile(normalized.host).nativeOutput) console.log(JSON.stringify(result));
      await closeDb();
    } catch (error: any) {
      if (error instanceof IncompleteHostHookPayloadError) {
        await closeDb().catch(() => {});
        return;
      }
      console.error(`Error handling agent hook: ${error.message}`);
      await closeDb().catch(() => {});
      process.exit(1);
    }
  });

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

    let root = '';
    let taskId = '';
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

const evidenceCommand = program
  .command('evidence')
  .description('Inspect provenance evidence linked to knowledge');

evidenceCommand
  .command('list')
  .description('List evidence linked to one knowledge item')
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
const prCommand = program
  .command('pr')
  .description('Check git changes against stored knowledge provenance');

prCommand
  .command('check')
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
      });

      printPrCheckResult(result);
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
  .action(async (snapshotPath, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const result = await restoreSnapshot(root, snapshotPath, { confirm: options.confirm });
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
        const update = await checkForUpdate({ packageName: PACKAGE_NAME, currentVersion: PACKAGE_VERSION, projectRoot: root });
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
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
    } catch (error: any) {
      console.error(`❌ Failed to start MCP Server: ${error.message}`);
      process.exit(1);
    }
  });

// Parse commands
program.parse(process.argv);
