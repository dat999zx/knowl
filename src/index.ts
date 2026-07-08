#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { findProjectRoot, loadConfig, saveConfig, hasAiConfigured, upgradeConfigDefaults } from './core/config.js';
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
import { reindexKnowledgeEmbeddings } from './store/vector-index.js';
import { applyKnowledgeGc, previewKnowledgeGc } from './store/gc.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop, WorkLoopMemoryHit } from './store/work-loop.js';

// Load environment variables (.env file)
dotenv.config();

const program = new Command();

function printMcpSetupHint() {
  console.log(`🔌 To let Codex use Knowl memory, register the MCP server:`);
  console.log(`   codex mcp add knowl -- knowl.cmd serve`);
}

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

function printConnectInstructions(target: string) {
  const normalized = target.toLowerCase();
  console.log('KNOWL CONNECT');
  console.log(`Target: ${normalized}`);
  console.log('');

  if (normalized === 'codex') {
    console.log('Run:');
    console.log('  codex mcp add knowl -- knowl.cmd serve');
    console.log('');
    console.log('Then:');
    console.log('  Start a new Codex session so the MCP tools are loaded.');
    return;
  }

  if (normalized === 'cursor') {
    console.log('Add this MCP server in Cursor:');
    console.log('  Name: `knowl`');
    console.log('  Type: `command`');
    console.log('  Command: `knowl serve`');
    return;
  }

  if (normalized === 'claude') {
    console.log('Add this to Claude Desktop MCP configuration:');
    console.log(JSON.stringify({
      mcpServers: {
        knowl: {
          command: 'knowl',
          args: ['serve'],
        },
      },
    }, null, 2));
    return;
  }

  throw new Error('Unsupported connect target. Use codex, cursor, or claude.');
}

async function upgradeExistingRepository(projectRoot: string, fallbackName: string) {
  const configStatus = await upgradeConfigDefaults(projectRoot);
  const config = await loadConfig(projectRoot);
  const agentsStatus = await installKnowlAgentsGuidance(projectRoot);
  const gitignoreStatus = await installKnowlGitignoreEntry(projectRoot);

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
  .argument('[name]', 'Name of the project', 'My Project')
  .action(async (name) => {
    const cwd = process.cwd();
    const knowlDir = path.join(cwd, '.knowl');

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
        printMcpSetupHint();
        process.exit(0);
      }

      await fs.mkdir(knowlDir, { recursive: true });

      // Create default config.json
      const defaultConfig = {
        version: 1,
        security: {
          rejectSecrets: true,
          secretPatterns: ['api_key', 'password', 'secret', 'token', 'private_key'],
        },
        search: {
          vector: {
            enabled: false,
            provider: 'local',
            model: 'Xenova/all-MiniLM-L6-v2',
            dtype: 'q8',
          },
        },
      };

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
      printMcpSetupHint();
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
          const item = await recordDecisionDirect(project.id, atom, `Record decision (fallback): ${title}`);
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
        const item = await recordDecisionDirect(project.id, atom, `Record decision: ${title}`);
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
program
  .command('config')
  .description('View or edit repository configuration parameters')
  .argument('[key]', 'The configuration key (e.g., ai.model)')
  .argument('[value]', 'The new value to set')
  .action(async (key, value) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);

      if (!key) {
        console.log(JSON.stringify(config, null, 2));
        process.exit(0);
      }

      // Helper to traverse dot notation keys
      const keys = key.split('.');
      
      if (value === undefined) {
        // Read key
        let current: any = config;
        for (const k of keys) {
          if (current[k] === undefined) {
            console.log(`undefined`);
            process.exit(0);
          }
          current = current[k];
        }
        console.log(typeof current === 'object' ? JSON.stringify(current, null, 2) : current);
      } else {
        // Write key
        let current: any = config;
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i];
          if (current[k] === undefined) {
            current[k] = {};
          }
          current = current[k];
        }

        const lastKey = keys[keys.length - 1];
        
        // Simple type conversion
        let typedValue: any = value;
        if (value.toLowerCase() === 'true') typedValue = true;
        else if (value.toLowerCase() === 'false') typedValue = false;
        else if (!isNaN(Number(value))) typedValue = Number(value);

        current[lastKey] = typedValue;

        await saveConfig(root, config);
        console.log(`✅ Set "${key}" to: ${JSON.stringify(typedValue)}`);
      }
    } catch (error: any) {
      console.error(`❌ Configuration error: ${error.message}`);
      process.exit(1);
    }
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

      const embedder = await createLocalEmbeddingProvider(config, root);
      const result = await reindexKnowledgeEmbeddings(project.id, embedder);
      console.log(`Indexed ${result.indexed} vector embedding(s).`);
      await closeDb();
    } catch (error: any) {
      console.error(`Error reindexing: ${error.message}`);
      process.exit(1);
    }
  });

// --- 9. UPGRADE COMMAND ---
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

// --- 10. CONNECT COMMAND ---
program
  .command('connect')
  .description('Print MCP setup instructions for an agent client')
  .argument('<target>', 'Agent client: codex, cursor, or claude')
  .action((target) => {
    try {
      printConnectInstructions(target);
    } catch (error: any) {
      console.error(`Error printing connection instructions: ${error.message}`);
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

// --- 12. TASK COMMAND ---
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

// --- 13. DOCTOR COMMAND ---
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

// --- 14. SERVE COMMAND ---
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
