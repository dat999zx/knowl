#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { DEFAULT_CONFIG, findProjectRoot, loadConfig, hasAiConfigured, upgradeConfigDefaults } from './core/config.js';
import { installKnowlAgentsGuidance } from './core/agents-guidance.js';
import { installKnowlGitignoreEntry } from './core/gitignore.js';
import { initDb, closeDb } from './store/database.js';
import * as repo from './store/repository.js';
import { recordDecisionDirect } from './store/knowledge-actions.js';
import { getHierarchicalKnowledge, queryKnowledgeBase } from './store/queries.js';
import { initAI, askQuestion } from './ai/provider.js';
import { runPipeline, runDecisionPipeline } from './pipeline/pipeline.js';
import { startMcpServer } from './mcp/server.js';
import { formatHierarchyToMarkdown } from './core/format.js';
import { formatStatusReport } from './cli/status-report.js';
import { formatDoctorReport, runDoctor } from './cli/doctor-report.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from './ai/embeddings.js';
import { getConfigValue, resetAllConfig, resetConfigValue, setConfigValue } from './cli/config/service.js';
import { runConfigUi } from './cli/config/ui.js';
import { formatAgentInitSummary, runAgentInitFlow } from './cli/init-flow.js';
import { reindexKnowledgeEmbeddings } from './store/vector-index.js';
import { applyKnowledgeGc, previewKnowledgeGc } from './store/gc.js';
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
import { bootstrapAgentSession } from './store/context-bootstrap.js';
import { listAssertions } from './store/assertions.js';
import { listActiveConflictKeys } from './store/conflicts.js';
import { composeContext } from './store/context-composer.js';
import { indexCode, listCodeSymbols } from './code/symbol-index.js';
import { exportKnowledge } from './store/portability.js';
import { synthesizeKnowledge } from './store/synthesis.js';

// Load environment variables (.env file)
dotenv.config();

const program = new Command();

function printAgentsGuidanceStatus(status: Awaited<ReturnType<typeof installKnowlAgentsGuidance>>) {
  if (status === 'created') {
    console.log(`Created AGENTS.md with Knowl MCP guidance.`);
  } else if (status === 'updated') {
    console.log(`Updated AGENTS.md with Knowl MCP guidance.`);
  } else {
    console.log(`AGENTS.md Knowl MCP guidance is up to date.`);
  }
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

async function upgradeExistingRepository(projectRoot: string, fallbackName: string) {
  const configStatus = await upgradeConfigDefaults(projectRoot);
  const config = await loadConfig(projectRoot);
  const agentsStatus = await installKnowlAgentsGuidance(projectRoot);
  const gitignoreStatus = await installKnowlGitignoreEntry(projectRoot);
  await fs.mkdir(path.join(projectRoot, '.knowl', 'skills'), { recursive: true });

  await initDb(projectRoot);
  let project = await repo.getProjectByRootPath(projectRoot);
  if (!project) {
    project = await repo.createProject(projectRoot, fallbackName);
  }
  await closeDb();

  return {
    project,
    configStatus,
    agentsStatus,
    gitignoreStatus,
  };
}

function printUpgradeStatus(result: Awaited<ReturnType<typeof upgradeExistingRepository>>) {
  console.log(`KNOWL repository upgrade complete.`);
  console.log(`Repository: ${result.project.rootPath}`);
  console.log(`Config: ${result.configStatus}`);
  console.log(`AGENTS.md: ${result.agentsStatus}`);
  console.log(`.gitignore: ${result.gitignoreStatus}`);
}

program
  .name('knowl')
  .description('KNOWL — A Knowledge Operating System for AI Agents')
  .version('0.1.0');

// --- 1. INIT COMMAND ---
program
  .command('init')
  .description('Initialize a new KNOWL repository in the current directory')
  .argument('[agents...]', 'Agent integrations to configure')
  .option('-y, --yes', 'Accept global configuration confirmations')
  .action(async (agents: string[], options) => {
    const cwd = process.cwd();
    const knowlDir = path.join(cwd, '.knowl');
    const name = path.basename(cwd) || 'My Project';

    try {
      let isExisting = false;
      try {
        await fs.access(knowlDir);
        isExisting = true;
      } catch {
        // Doesn't exist
      }

      if (isExisting) {
        const result = await upgradeExistingRepository(cwd, name);
        console.log(`⚠️  KNOWL repository already initialized in this directory: ${knowlDir}`);
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

      // Create default config.json
      const defaultConfig = DEFAULT_CONFIG;

      await fs.writeFile(
        path.join(knowlDir, 'config.json'),
        JSON.stringify(defaultConfig, null, 2),
        'utf-8'
      );

      // Bootstrap SQLite database
      await initDb(cwd);
      const project = await repo.createProject(cwd, name);
      await closeDb();
      const agentsStatus = await installKnowlAgentsGuidance(cwd);
      const gitignoreStatus = await installKnowlGitignoreEntry(cwd);

      console.log(`🎉 Successfully initialized KNOWL repository!`);
      console.log(`📂 Created: ${knowlDir}`);
      if (agentsStatus === 'created') {
        console.log(`🧭 Created AGENTS.md with Knowl MCP guidance.`);
      } else if (agentsStatus === 'updated') {
        console.log(`🧭 Updated AGENTS.md with Knowl MCP guidance.`);
      }
      if (gitignoreStatus === 'created') {
        console.log(`Created .gitignore with .knowl/ entry.`);
      } else if (gitignoreStatus === 'updated') {
        console.log(`Updated .gitignore with .knowl/ entry.`);
      }
      console.log(`⚙️  Local project store ready.`);
      console.log(`👉 Run "knowl status" to see repository status.`);
      if (agentsStatus === 'unchanged') {
        printAgentsGuidanceStatus(agentsStatus);
      }
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
        activeItems,
        supersededItems,
        deprecatedItems,
        commits,
      }));

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
      const md = formatHierarchyToMarkdown(hierarchy);
      console.log(md);

      await closeDb();
    } catch (error: any) {
      console.error(`❌ Error fetching project state: ${error.message}`);
      process.exit(1);
    }
  });

program.command('timeline').argument('<itemId>').action(async itemId => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listAssertions(itemId), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading timeline: ${error.message}`); process.exit(1); }
});

program.command('query').argument('[query]').option('--as-of <timestamp>').option('--limit <count>').action(async (query, options) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); const items = await queryKnowledgeBase(project.id, { query, limit: options.limit === undefined ? undefined : Number(options.limit), asOf: options.asOf }); console.log(JSON.stringify(items, null, 2)); await closeDb(); } catch (error: any) { console.error(`Error querying knowledge: ${error.message}`); process.exit(1); }
});

program.command('conflicts').action(async () => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify((await listActiveConflictKeys()).map(item => ({ id: item.id, title: item.title, conflictKey: item.conflictKey, conflictScope: item.conflictScope, freshness: item.freshness })), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error listing conflicts: ${error.message}`); process.exit(1); }
});

program.command('supersede').argument('<itemId>').argument('<replacementId>').action(async (itemId, replacementId) => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await repo.supersedeKnowledgeItem(itemId, replacementId), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error superseding knowledge: ${error.message}`); process.exit(1); }
});

program.command('context').option('--query <query>').option('--task <task>').requiredOption('--token-budget <budget>').action(async options => {
  try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await composeContext(project.id, { query: options.query, task: options.task, tokenBudget: Number(options.tokenBudget) }), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error composing context: ${error.message}`); process.exit(1); }
});

const codeCommand = program.command('code').description('Index and inspect project code symbols');
codeCommand.command('index').action(async () => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); await indexCode(root); console.log('Code symbols indexed.'); await closeDb(); } catch (error: any) { console.error(`Error indexing code: ${error.message}`); process.exit(1); } });
codeCommand.command('symbols').argument('<path>').action(async filePath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); console.log(JSON.stringify(await listCodeSymbols(filePath), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error reading code symbols: ${error.message}`); process.exit(1); } });

program.command('export').argument('<path>').action(async outputPath => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await exportKnowledge(project.id, path.resolve(outputPath)), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error exporting knowledge: ${error.message}`); process.exit(1); } });

program.command('synthesize').requiredOption('--scope <path-or-tag>').action(async options => { try { const root = await findProjectRoot(process.cwd()); await initDb(root); const project = await repo.getProjectByRootPath(root); if (!project) throw new Error('Project not found in database.'); console.log(JSON.stringify(await synthesizeKnowledge(project.id, options.scope), null, 2)); await closeDb(); } catch (error: any) { console.error(`Error synthesizing knowledge: ${error.message}`); process.exit(1); } });


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
        initAI(config.ai!);
        const mergeResult = await runDecisionPipeline(project.id, atom, {
          autoResolveContradictions: true,
          commitMessage: `Record decision: ${title}`
        }, config);

        if (mergeResult.unresolvedContradictions.length > 0) {
          const item = await recordDecisionDirect(project.id, atom, `Record decision (fallback): ${title}`, config);
          console.log(`✅ Recorded decision successfully! ID: ${item.id}`);
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
        const item = await recordDecisionDirect(project.id, atom, `Record decision: ${title}`, config);
        console.log(`✅ Recorded decision successfully! ID: ${item.id}`);
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
        onFirstLoad: ({ model }) => console.log(`Downloading local embedding model ${model}...`),
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

      const evaluation = await evaluateRetrieval(cases, async (testCase) => {
        const startedAt = Date.now();
        const items = await queryKnowledgeForAgent(project.id, {
          query: testCase.query,
          status: 'active',
          surface: 'cli_eval',
          limit: testCase.limit,
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
  .description('Upgrade an existing KNOWL repository with the latest config, schema, and agent files')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const result = await upgradeExistingRepository(root, 'My Project');
      printUpgradeStatus(result);
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
  .action(async (options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = options.apply
        ? await applyKnowledgeGc(project.id)
        : await previewKnowledgeGc(project.id);

      console.log(options.apply ? 'KNOWL GC APPLY' : 'KNOWL GC PREVIEW');
      console.log(`Archive:  ${result.summary.archive}`);
      console.log(`Compress: ${result.summary.compress}`);
      console.log(`Purge:    ${result.summary.purge}`);

      if (result.candidates.length === 0) {
        console.log('No GC actions recommended.');
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
  .action(async (taskId, summary) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const project = await repo.getProjectByRootPath(root);
      if (!project) throw new Error('Project not found in database.');

      const result = await checkpointWorkLoop(project.id, taskId, summary);
      console.log('KNOWL WORK LOOP CHECKPOINT');
      console.log(`Task ID: ${result.taskId}`);
      console.log(`Checkpoint ID: ${result.itemId}`);

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
  .action(async () => {
    const result = await runDoctor(process.cwd());
    console.log(formatDoctorReport(result));
    if (!result.ready) {
      process.exit(1);
    }
  });

// --- 16. SERVE COMMAND ---
program
  .command('serve')
  .description('Start the Model Context Protocol (MCP) server for KNOWL')
  .action(async () => {
    try {
      console.error(`🚀 Starting KNOWL MCP Server...`);
      await startMcpServer();
    } catch (error: any) {
      console.error(`❌ Failed to start MCP Server: ${error.message}`);
      process.exit(1);
    }
  });

// Parse commands
program.parse(process.argv);
