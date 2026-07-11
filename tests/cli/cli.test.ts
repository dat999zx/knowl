import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import fs from 'node:fs/promises';
import path from 'node:path';

const TEST_DIR = path.resolve('./.knowl-cli-test');
const AGENTS_TEST_DIR = path.resolve('./.knowl-cli-agents-test');
const AGENTS_REFRESH_TEST_DIR = path.resolve('./.knowl-cli-agents-refresh-test');
const CLI_PATH = path.resolve('./dist/index.js');

describe('CLI Integration', () => {
  beforeAll(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
      await fs.rm(AGENTS_TEST_DIR, { recursive: true, force: true });
      await fs.rm(AGENTS_REFRESH_TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.mkdir(AGENTS_TEST_DIR, { recursive: true });
    await fs.mkdir(AGENTS_REFRESH_TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
      await fs.rm(AGENTS_TEST_DIR, { recursive: true, force: true });
      await fs.rm(AGENTS_REFRESH_TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should initialize a repository', async () => {
    const output = execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('Successfully initialized KNOWL repository!');
    expect(output).toContain('Local project store ready');

    // Verify files exist
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'knowl.db'))).resolves.toBeUndefined();
    const config = JSON.parse(await fs.readFile(path.join(TEST_DIR, '.knowl', 'config.json'), 'utf-8'));
    expect(config.project).toBeUndefined();
    expect(config.search.vector.enabled).toBe(true);
    expect(config.search.vector.provider).toBe('local');
  });

  it('should evaluate retrieval from a dataset as JSON', () => {
    const dataset = path.resolve('./docs/evals/retrieval-baseline.json');
    const output = execSync(`node "${CLI_PATH}" eval retrieval --dataset "${dataset}" --json`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    const result = JSON.parse(output);
    expect(result.dataset).toBe(dataset);
    expect(result.timestamp).toBeTruthy();
    expect(result.metrics).toEqual(expect.objectContaining({
      recallAt3: expect.any(Number),
      p95LatencyMs: expect.any(Number),
      averageContextChars: expect.any(Number),
    }));
    expect(result.metrics.recallAt3).toBeGreaterThan(0);
    expect(result.failedCaseIds).toEqual(expect.any(Array));
  });

  it('should report retrieval access as JSON', () => {
    const output = execSync(`node "${CLI_PATH}" access report --json`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      highValue: expect.any(Array),
      staleFrequentlyRetrieved: expect.any(Array),
      repeatedlyCorrected: expect.any(Array),
    }));
  });

  it('should create project .gitignore with .knowl during init', async () => {
    const ignoreDir = path.resolve('./.knowl-cli-new-gitignore-test');
    await fs.rm(ignoreDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(ignoreDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: ignoreDir,
      encoding: 'utf-8',
    });

    const ignorePath = path.join(ignoreDir, '.gitignore');
    const content = await fs.readFile(ignorePath, 'utf-8');
    expect(content).toContain('.knowl/');

    await fs.rm(ignoreDir, { recursive: true, force: true });
  });

  it('should append .knowl to existing project .gitignore without overwriting content', async () => {
    const gitignoreDir = path.resolve('./.knowl-cli-gitignore-test');
    await fs.rm(gitignoreDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(gitignoreDir, { recursive: true });
    await fs.writeFile(path.join(gitignoreDir, '.gitignore'), 'node_modules/\n.env\n', 'utf-8');

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: gitignoreDir,
      encoding: 'utf-8',
    });

    const content = await fs.readFile(path.join(gitignoreDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain('.knowl/');
    expect((content.match(/\.knowl\//g) || []).length).toBe(1);

    await fs.rm(gitignoreDir, { recursive: true, force: true });
  });

  it('should create AGENTS.md with Knowl MCP guidance during init', async () => {
    const agentsPath = path.join(TEST_DIR, 'AGENTS.md');
    const content = await fs.readFile(agentsPath, 'utf-8');

    expect(content).toContain('## Knowl Project Memory');
    expect(content).toContain('`knowl init` installs automatic lifecycle capture when a host supports a verified hook format');
    expect(content).toContain('At the start of a new project-specific session, call `knowl_recent` first');
    expect(content).toContain('After `knowl_recent`, use `knowl_query` for specific questions');
    expect(content).toContain('Do not use `knowl_ask` for MCP first-pass lookup');
    expect(content).toContain('Use 2-6 concise search keywords');
    expect(content).toContain('Omit category filters unless you are certain');
    expect(content).toContain('Only use `knowl_state` for broad project-memory summaries');
    expect(content).toContain('Do not inspect repository files before this Knowl lookup');
    expect(content).toContain('If `knowl_query` returns a relevant active item, answer from Knowl immediately');
    expect(content).toContain('Do not inspect repository files just to re-verify known facts');
    expect(content).toContain('Only inspect repository files when Knowl misses, conflicts, looks stale or low-confidence, or the user asks for source verification');
    expect(content).toContain('If the Knowl MCP tools are unavailable');
    expect(content).toContain('`Auth: Unsupported` on a local stdio MCP server is normal');
    expect(content).toContain('knowl_state');
    expect(content).toContain('knowl_recent');
    expect(content).toContain('knowl_query');
    expect(content).toContain('knowl_store');
    expect(content).toContain('knowl_decide');
    expect(content).toContain('During work, keep Knowl current');
    expect(content).toContain('For multi-step tasks, do not wait until the end to use Knowl');
    expect(content).toContain('Before each new subtask or when switching areas, run a focused `knowl_query`');
    expect(content).toContain('After each completed subtask or newly verified durable finding, update Knowl immediately');
    expect(content).toContain('If later subtasks depend on new memory you just stored, query Knowl again before continuing');
    expect(content).toContain('If new findings contradict or replace existing memory, use `knowl_update`');
    expect(content).toContain('Before the final answer, check whether the work produced durable knowledge');
    expect(content).toContain('implemented feature summaries, setup steps, architecture changes, important commands, decisions, constraints, recurring bugs, gotchas, and verified project facts');
    expect(content).toContain('Store durable knowledge as concise structured atoms, not raw chat transcripts');
    expect(content).toContain('After discovering and verifying durable project knowledge from repository files, store it in Knowl');
    expect(content).toContain('Do not store temporary debugging noise');
  });

  it('should report AGENTS.md guidance status when init is rerun in an existing repository', () => {
    const output = execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL repository already initialized');
    expect(output).toContain('KNOWL repository upgrade complete.');
    expect(output).toContain('AGENTS.md: unchanged');
  });

  it('should merge missing default config keys when init is rerun in an existing repository', async () => {
    const oldProjectDir = path.resolve('./.knowl-cli-old-config-test');
    await fs.rm(oldProjectDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(oldProjectDir, '.knowl'), { recursive: true });
    await fs.writeFile(
      path.join(oldProjectDir, '.knowl', 'config.json'),
      JSON.stringify({
        version: 1,
        project: { name: 'Old Config Project' },
        ai: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${OPENAI_API_KEY}' },
        security: { rejectSecrets: true, secretPatterns: ['password'] },
      }, null, 2),
      'utf-8'
    );

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: oldProjectDir,
      encoding: 'utf-8',
    });

    const config = JSON.parse(await fs.readFile(path.join(oldProjectDir, '.knowl', 'config.json'), 'utf-8'));
    expect(config.project).toBeUndefined();
    expect(config.ai.provider).toBe('openai');
    expect(config.security.secretPatterns).toEqual(['password']);
    expect(config.search.vector.enabled).toBe(true);
    expect(config.search.vector.provider).toBe('local');

    await fs.rm(oldProjectDir, { recursive: true, force: true });
  });

  it('should bootstrap missing database tables when init is rerun in an existing repository', async () => {
    const oldDbDir = path.resolve('./.knowl-cli-old-db-test');
    await fs.rm(oldDbDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(oldDbDir, '.knowl'), { recursive: true });
    await fs.writeFile(
      path.join(oldDbDir, '.knowl', 'config.json'),
      JSON.stringify({
        version: 1,
        project: { name: 'Old DB Project' },
        security: { rejectSecrets: true, secretPatterns: [] },
      }, null, 2),
      'utf-8'
    );

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: oldDbDir,
      encoding: 'utf-8',
    });

    const output = execSync(`node "${CLI_PATH}" status`, {
      cwd: oldDbDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL REPOSITORY STATUS');
    expect(output).not.toContain('Old DB Project');

    await fs.rm(oldDbDir, { recursive: true, force: true });
  });

  it('should run explicit upgrade for existing repositories', async () => {
    const upgradeDir = path.resolve('./.knowl-cli-upgrade-test');
    await fs.rm(upgradeDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(upgradeDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: upgradeDir,
      encoding: 'utf-8',
    });

    const output = execSync(`node "${CLI_PATH}" upgrade`, {
      cwd: upgradeDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL repository upgrade complete');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('.gitignore');

    await fs.rm(upgradeDir, { recursive: true, force: true });
  });

  it('should append Knowl MCP guidance to an existing AGENTS.md without overwriting it', async () => {
    const agentsPath = path.join(AGENTS_TEST_DIR, 'AGENTS.md');
    await fs.writeFile(agentsPath, '# Existing Agent Rules\n\nKeep responses concise.\n', 'utf-8');

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: AGENTS_TEST_DIR,
      encoding: 'utf-8',
    });

    const content = await fs.readFile(agentsPath, 'utf-8');
    expect(content).toContain('# Existing Agent Rules');
    expect(content).toContain('Keep responses concise.');
    expect(content).toContain('## Knowl Project Memory');
    expect((content.match(/## Knowl Project Memory/g) || []).length).toBe(1);
  });

  it('should refresh stale Knowl MCP guidance when init is rerun in an existing project', async () => {
    const agentsPath = path.join(AGENTS_REFRESH_TEST_DIR, 'AGENTS.md');

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: AGENTS_REFRESH_TEST_DIR,
      encoding: 'utf-8',
    });

    await fs.writeFile(
      agentsPath,
      '# Agent Instructions\n\n<!-- KNOWL_PROJECT_MEMORY -->\n## Knowl Project Memory\n\n- Before answering project-specific questions, query Knowl first using `knowl_state` or `knowl_query`.\n',
      'utf-8'
    );

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: AGENTS_REFRESH_TEST_DIR,
      encoding: 'utf-8',
    });

    const content = await fs.readFile(agentsPath, 'utf-8');
    expect(content).toContain('At the start of a new project-specific session, call `knowl_recent` first');
    expect(content).toContain('After `knowl_recent`, use `knowl_query` for specific questions');
    expect(content).toContain('Do not use `knowl_ask` for MCP first-pass lookup');
    expect(content).toContain('If `knowl_query` returns a relevant active item, answer from Knowl immediately');
    expect(content).toContain('For multi-step tasks, do not wait until the end to use Knowl');
    expect(content).toContain('Before each new subtask or when switching areas, run a focused `knowl_query`');
    expect(content).toContain('After each completed subtask or newly verified durable finding, update Knowl immediately');
    expect(content).toContain('Before the final answer, check whether the work produced durable knowledge');
    expect(content).toContain('After discovering and verifying durable project knowledge from repository files, store it in Knowl');
    expect((content.match(/## Knowl Project Memory/g) || []).length).toBe(1);
  });

  it('should initialize without AI provider configuration by default', () => {
    const aiConfig = execSync(`node "${CLI_PATH}" config get ai.provider`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();

    expect(aiConfig).toBe('undefined');
  });

  it('should allow explicit AI provider configuration', () => {
    const providerUpdate = execSync(`node "${CLI_PATH}" config set ai.provider openai`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();
    expect(providerUpdate).toContain('Set ai.provider = "openai"');

    const modelUpdate = execSync(`node "${CLI_PATH}" config set ai.model gpt-4-turbo`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();
    expect(modelUpdate).toContain('Set ai.model = "gpt-4-turbo"');

    const model = execSync(`node "${CLI_PATH}" config get ai.model`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();
    expect(model).toBe('gpt-4-turbo');
  });

  it('should record decisions', () => {
    const output = execSync(
      `node "${CLI_PATH}" decide "Use Drizzle ORM" "We decide to use Drizzle ORM for type-safe SQLite database interactions" -r "Provides compile-time safety and automatic schema synchronization" -a "Prisma" "Sequelize" -t "orm" "sqlite"`,
      {
        cwd: TEST_DIR,
        encoding: 'utf-8',
      }
    );

    expect(output).toContain('Recorded decision successfully!');
  });

  it('should run a work loop with start, checkpoint, and finish commands', async () => {
    const workLoopDir = path.resolve('./.knowl-cli-work-loop-test');
    await fs.rm(workLoopDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(workLoopDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: workLoopDir,
      encoding: 'utf-8',
    });
    execSync(
      `node "${CLI_PATH}" decide "Use BM25 retrieval" "Use BM25 retrieval for concise project-memory lookups." -r "Work-loop start should surface relevant memory before execution." -t "search" "retrieval"`,
      {
        cwd: workLoopDir,
        encoding: 'utf-8',
      }
    );

    const startOutput = execSync(`node "${CLI_PATH}" task start "Implement search UI" --query "search retrieval"`, {
      cwd: workLoopDir,
      encoding: 'utf-8',
    });
    expect(startOutput).toContain('KNOWL WORK LOOP START');
    expect(startOutput).toContain('Task ID:');
    expect(startOutput).toContain('Relevant memory:');
    expect(startOutput).toContain('Use BM25 retrieval');

    const taskId = startOutput.match(/Task ID:\s+([a-f0-9]+)/)?.[1];
    expect(taskId).toBeTruthy();

    const checkpointOutput = execSync(`node "${CLI_PATH}" task checkpoint ${taskId} "Added search UI tests"`, {
      cwd: workLoopDir,
      encoding: 'utf-8',
    });
    expect(checkpointOutput).toContain('KNOWL WORK LOOP CHECKPOINT');
    expect(checkpointOutput).toContain('Checkpoint ID:');

    const finishOutput = execSync(`node "${CLI_PATH}" task finish ${taskId} "Verified search UI implementation"`, {
      cwd: workLoopDir,
      encoding: 'utf-8',
    });
    expect(finishOutput).toContain('KNOWL WORK LOOP FINISH');
    expect(finishOutput).toContain('Finish ID:');

    const stateOutput = execSync(`node "${CLI_PATH}" state`, {
      cwd: workLoopDir,
      encoding: 'utf-8',
    });
    expect(stateOutput).toContain('Work Loop: Implement search UI');
    expect(stateOutput).toContain('Work Loop checkpoint');
    expect(stateOutput).toContain('Work Loop finish');

    await fs.rm(workLoopDir, { recursive: true, force: true });
  }, 10_000);

  it('should run a command inside an automatic work loop', async () => {
    const workLoopRunDir = path.resolve('./.knowl-cli-work-loop-run-test');
    await fs.rm(workLoopRunDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(workLoopRunDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: workLoopRunDir,
      encoding: 'utf-8',
    });
    execSync(
      `node "${CLI_PATH}" decide "Use BM25 retrieval" "Use BM25 retrieval for concise project-memory lookups." -r "Automatic work-loop runs should surface relevant memory before execution." -t "search" "retrieval"`,
      {
        cwd: workLoopRunDir,
        encoding: 'utf-8',
      }
    );

    const output = execFileSync(process.execPath, [
      CLI_PATH,
      'task',
      'run',
      'Implement search UI',
      '--query',
      'search retrieval',
      '--',
      process.execPath,
      '-e',
      "console.log('wrapped output')",
    ], {
      cwd: workLoopRunDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL WORK LOOP START');
    expect(output).toContain('Relevant memory:');
    expect(output).toContain('Use BM25 retrieval');
    expect(output).toContain('wrapped output');
    expect(output).toContain('KNOWL WORK LOOP FINISH');

    const stateOutput = execSync(`node "${CLI_PATH}" state`, {
      cwd: workLoopRunDir,
      encoding: 'utf-8',
    });
    expect(stateOutput).toContain('Work Loop: Implement search UI');
    expect(stateOutput).toContain('Work Loop finish');
    expect(stateOutput).toContain('Command succeeded:');

    await fs.rm(workLoopRunDir, { recursive: true, force: true });
  }, 15_000);

  it('should checkpoint failed automatic work loop commands and preserve the exit code', async () => {
    const workLoopFailureDir = path.resolve('./.knowl-cli-work-loop-run-failure-test');
    await fs.rm(workLoopFailureDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(workLoopFailureDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: workLoopFailureDir,
      encoding: 'utf-8',
    });

    let output = '';
    let status: number | undefined;
    try {
      execFileSync(process.execPath, [
        CLI_PATH,
        'task',
        'run',
        'Fail wrapped command',
        '--',
        process.execPath,
        '-e',
        "console.error('wrapped failure'); process.exit(7)",
      ], {
        cwd: workLoopFailureDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (error: any) {
      status = error.status;
      output = `${error.stdout.toString()}${error.stderr.toString()}`;
    }

    expect(status).toBe(7);
    expect(output).toContain('KNOWL WORK LOOP START');
    expect(output).toContain('wrapped failure');
    expect(output).toContain('KNOWL WORK LOOP CHECKPOINT');
    expect(output).toContain('Command failed with exit code 7');

    const stateOutput = execSync(`node "${CLI_PATH}" state`, {
      cwd: workLoopFailureDir,
      encoding: 'utf-8',
    });
    expect(stateOutput).toContain('Work Loop: Fail wrapped command');
    expect(stateOutput).toContain('Work Loop checkpoint');
    expect(stateOutput).toContain('Command failed with exit code 7');

    await fs.rm(workLoopFailureDir, { recursive: true, force: true });
  });

  it('should run automatic work loop commands resolved from PATH', async () => {
    const workLoopPathDir = path.resolve('./.knowl-cli-work-loop-run-path-test');
    await fs.rm(workLoopPathDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(workLoopPathDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: workLoopPathDir,
      encoding: 'utf-8',
    });

    const output = execFileSync(process.execPath, [
      CLI_PATH,
      'task',
      'run',
      'Check npm shim',
      '--',
      'npm',
      '--version',
    ], {
      cwd: workLoopPathDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL WORK LOOP START');
    expect(output).toMatch(/\d+\.\d+\.\d+/);
    expect(output).toContain('KNOWL WORK LOOP FINISH');

    await fs.rm(workLoopPathDir, { recursive: true, force: true });
  });

  it('should mark changed PR knowledge for review from git diff', async () => {
    const prDir = path.resolve('./.knowl-cli-pr-check-test');
    await fs.rm(prDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(prDir, 'src'), { recursive: true });

    try {
      execSync('git init', { cwd: prDir, encoding: 'utf-8' });
      execSync('git config user.email knowl@example.test', { cwd: prDir, encoding: 'utf-8' });
      execSync('git config user.name "Knowl Test"', { cwd: prDir, encoding: 'utf-8' });
      await fs.writeFile(path.join(prDir, 'src', 'billing.ts'), 'export const version = 1;\n', 'utf-8');
      execSync('git add src/billing.ts', { cwd: prDir, encoding: 'utf-8' });
      execSync('git commit -m "base"', { cwd: prDir, encoding: 'utf-8' });
      const baseCommit = execSync('git rev-parse HEAD', { cwd: prDir, encoding: 'utf-8' }).trim();

      execSync(`node "${CLI_PATH}" init --yes`, {
        cwd: prDir,
        encoding: 'utf-8',
      });
      execSync(
        `node "${CLI_PATH}" decide "Billing module" "Billing knowledge follows src/billing.ts." -r "PR checks should review file-bound memory." -t "billing"`,
        {
          cwd: prDir,
          encoding: 'utf-8',
        }
      );

      const client = createClient({ url: `file:${path.join(prDir, '.knowl', 'knowl.db')}` });
      try {
        const rows = await client.execute({
          sql: 'SELECT id FROM knowledge_items WHERE title = ?',
          args: ['Billing module'],
        });
        const itemId = String(rows.rows[0].id);
        await client.execute({
          sql: 'UPDATE knowledge_items SET affected_paths = ?, source_commit = ?, freshness = ? WHERE id = ?',
          args: [JSON.stringify(['src/billing.ts']), baseCommit, 'fresh', itemId],
        });

        await fs.writeFile(path.join(prDir, 'src', 'billing.ts'), 'export const version = 2;\n', 'utf-8');
        execSync('git add src/billing.ts', { cwd: prDir, encoding: 'utf-8' });
        execSync('git commit -m "change billing"', { cwd: prDir, encoding: 'utf-8' });

        const output = execSync(`node "${CLI_PATH}" pr check --since ${baseCommit}`, {
          cwd: prDir,
          encoding: 'utf-8',
        });

        expect(output).toContain('KNOWL PR CHECK');
        expect(output).toContain('Changed files: 1');
        expect(output).toContain('Review candidates: 1');
        expect(output).toContain('NEEDS_REVIEW');
        expect(output).toContain('Billing module');

        const updated = await client.execute({
          sql: 'SELECT freshness, source_commit FROM knowledge_items WHERE id = ?',
          args: [itemId],
        });
        expect(updated.rows[0].freshness).toBe('needs_review');
        expect(updated.rows[0].source_commit).toBe(baseCommit);
      } finally {
        client.close();
      }
    } finally {
      await fs.rm(prDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15_000);

  it('should report agent readiness with doctor', async () => {
    const doctorDir = path.resolve('./.knowl-cli-doctor-test');
    await fs.rm(doctorDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(doctorDir, { recursive: true });
    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: doctorDir,
      encoding: 'utf-8',
    });
    execSync(
      `node "${CLI_PATH}" decide "Doctor Ready" "Doctor has an active item to retrieve" -r "Agent readiness requires retrievable active memory"`,
      {
        cwd: doctorDir,
        encoding: 'utf-8',
      }
    );

    const output = execSync(`node "${CLI_PATH}" doctor`, {
      cwd: doctorDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL AGENT READINESS');
    expect(output).toContain('[OK] Repository initialized');
    expect(output).toContain('[OK] AGENTS.md Knowl guidance current');
    expect(output).toContain('[OK] Config includes vector search defaults');
    expect(output).toContain('[OK] Database schema includes knowledge_embeddings');
    expect(output).toContain('[OK] .gitignore ignores .knowl/');
    expect(output).toContain('[OK] Agent query returned');
    expect(output).toContain('[OK] MCP tools expose knowl_query and hide knowl_ask');
    expect(output).toContain('[OK] MCP tools expose work-loop task tools');
    expect(output).toContain('[OK] Agent lifecycle hooks are unsupported; `knowl task run` remains available');
    expect(output).toContain('[OK] Vector search enabled with local/Xenova/all-MiniLM-L6-v2');
    expect(output).toContain('Result: READY');

    await fs.rm(doctorDir, { recursive: true, force: true });
  });

  it('should print doctor fix hints when guidance and gitignore are stale', async () => {
    const staleDir = path.resolve('./.knowl-cli-doctor-stale-test');
    await fs.rm(staleDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(staleDir, { recursive: true });
    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: staleDir,
      encoding: 'utf-8',
    });

    await fs.writeFile(path.join(staleDir, 'AGENTS.md'), '# Agent Instructions\n', 'utf-8');
    await fs.writeFile(path.join(staleDir, '.gitignore'), 'node_modules/\n', 'utf-8');

    let output = '';
    try {
      execSync(`node "${CLI_PATH}" doctor`, {
        cwd: staleDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (error: any) {
      output = error.stdout.toString();
    }

    expect(output).toContain('Fix: run `knowl init`');
    expect(output).toContain('Fix: add `.knowl/` to `.gitignore` or run `knowl upgrade`');

    await fs.rm(staleDir, { recursive: true, force: true });
  });

  it('should audit and safely restore snapshots through the CLI', async () => {
    const snapshotDir = path.resolve('./.knowl-cli-snapshot-test');
    await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(snapshotDir, { recursive: true });
    execSync(`node "${CLI_PATH}" init --yes`, { cwd: snapshotDir, encoding: 'utf-8' });
    execSync(`node "${CLI_PATH}" decide "Snapshot baseline" "This item exists before the snapshot." -r "Snapshot test"`, {
      cwd: snapshotDir, encoding: 'utf-8',
    });

    const audit = execSync(`node "${CLI_PATH}" audit`, { cwd: snapshotDir, encoding: 'utf-8' });
    expect(audit).toContain('KNOWL INTEGRITY AUDIT');
    expect(audit).toContain('No integrity findings.');

    const created = execSync(`node "${CLI_PATH}" snapshot create`, { cwd: snapshotDir, encoding: 'utf-8' });
    const snapshotPath = created.match(/Snapshot:\s+(.+\.db)/)?.[1];
    expect(snapshotPath).toBeTruthy();
    await expect(fs.access(snapshotPath!)).resolves.toBeUndefined();

    execSync(`node "${CLI_PATH}" decide "After snapshot" "This item must be removed by restore." -r "Snapshot test"`, {
      cwd: snapshotDir, encoding: 'utf-8',
    });
    const restored = execSync(`node "${CLI_PATH}" snapshot restore "${snapshotPath}" --confirm`, {
      cwd: snapshotDir, encoding: 'utf-8',
    });
    expect(restored).toContain('Snapshot restored');
    const state = execSync(`node "${CLI_PATH}" state`, { cwd: snapshotDir, encoding: 'utf-8' });
    expect(state).toContain('Snapshot baseline');
    expect(state).not.toContain('After snapshot');

    await fs.rm(snapshotDir, { recursive: true, force: true });
  }, 15_000);

  it('should list inspectable evidence for a knowledge item', async () => {
    const evidenceDir = path.resolve('./.knowl-cli-evidence-test');
    await fs.rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(evidenceDir, { recursive: true });
    execSync(`node "${CLI_PATH}" init --yes`, { cwd: evidenceDir, encoding: 'utf-8' });
    execSync(`node "${CLI_PATH}" decide "Evidence list target" "This item has inspectable evidence." -r "Evidence test"`, { cwd: evidenceDir, encoding: 'utf-8' });
    const client = createClient({ url: `file:${path.join(evidenceDir, '.knowl', 'knowl.db')}` });
    const itemId = String((await client.execute({ sql: 'SELECT id FROM knowledge_items WHERE title = ?', args: ['Evidence list target'] })).rows[0].id);
    await client.execute({ sql: 'INSERT INTO evidence (id, type, locator, observed_at) VALUES (?, ?, ?, ?)', args: ['cli-evidence', 'test', 'tests/evidence.test.ts', '2026-07-11T00:00:00.000Z'] });
    await client.execute({ sql: 'INSERT INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [itemId, 'cli-evidence', 'supports'] });
    client.close();

    const output = execSync(`node "${CLI_PATH}" evidence list ${itemId}`, { cwd: evidenceDir, encoding: 'utf-8' });
    expect(output).toContain('tests/evidence.test.ts');
    expect(output).toContain('supports');
    await fs.rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
  }, 15_000);

  it('should index symbols and report stale symbol evidence with an unambiguous replacement', async () => {
    const symbolDir = path.resolve('./.knowl-cli-symbol-test');
    await fs.rm(symbolDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(symbolDir, 'src'), { recursive: true });
    try {
      let itemId = '';
      execSync(`node "${CLI_PATH}" init --yes`, { cwd: symbolDir, encoding: 'utf-8' });
      const source = path.join(symbolDir, 'src', 'auth.ts');
      await fs.writeFile(source, 'export function createToken() { return "token"; }\n');
      expect(execSync(`node "${CLI_PATH}" code index`, { cwd: symbolDir, encoding: 'utf-8' })).toContain('Code symbols indexed.');
      execSync(`node "${CLI_PATH}" decide "Symbol evidence target" "Symbol evidence should be inspectable."`, { cwd: symbolDir, encoding: 'utf-8' });
      const client = createClient({ url: `file:${path.join(symbolDir, '.knowl', 'knowl.db')}` });
      try {
        const original = await client.execute({ sql: 'SELECT signature_hash FROM code_symbols WHERE locator = ?', args: ['symbol://src/auth.ts#createToken'] });
        const item = await client.execute({ sql: 'SELECT id FROM knowledge_items WHERE title = ?', args: ['Symbol evidence target'] });
        itemId = String(item.rows[0].id);
        await client.execute({ sql: 'INSERT INTO evidence (id, type, locator, content_hash, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?)', args: ['symbol-evidence', 'symbol', 'symbol://src/auth.ts#createToken', String(original.rows[0].signature_hash), '2026-07-11T00:00:00.000Z', JSON.stringify({ symbolKind: 'function' })] });
        await client.execute({ sql: 'INSERT INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [itemId, 'symbol-evidence', 'supports'] });
      } finally {
        client.close();
      }
      await fs.writeFile(source, 'export function createAccessToken() { return "token"; }\n');
      execSync(`node "${CLI_PATH}" code index`, { cwd: symbolDir, encoding: 'utf-8' });
      const symbols = execSync(`node "${CLI_PATH}" code symbols src/auth.ts`, { cwd: symbolDir, encoding: 'utf-8' });
      expect(symbols).toContain('createAccessToken');
      const evidence = execSync(`node "${CLI_PATH}" evidence list ${itemId}`, { cwd: symbolDir, encoding: 'utf-8' });
      expect(evidence).toContain('symbol://src/auth.ts#createToken');
      expect(evidence).toContain('stale');
      expect(evidence).toContain('suggested: symbol://src/auth.ts#createAccessToken');
    } finally {
      await fs.rm(symbolDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15_000);

  it('should synthesize a tagged project understanding on demand', async () => {
    const synthesisDir = path.resolve('./.knowl-cli-synthesis-test');
    await fs.rm(synthesisDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(synthesisDir, { recursive: true });
    try {
      execSync(`node "${CLI_PATH}" init --yes`, { cwd: synthesisDir, encoding: 'utf-8' });
      execSync(`node "${CLI_PATH}" decide "Auth module" "Auth lives under src/auth." -t auth`, { cwd: synthesisDir, encoding: 'utf-8' });
      execSync(`node "${CLI_PATH}" decide "Auth token" "Auth uses JWT tokens." -t auth`, { cwd: synthesisDir, encoding: 'utf-8' });
      const output = execSync(`node "${CLI_PATH}" synthesize --scope auth`, { cwd: synthesisDir, encoding: 'utf-8' });
      expect(output).toContain('Synthesized understanding: auth');
      expect(output).toContain('synthesized');
    } finally {
      await fs.rm(synthesisDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15_000);

  it('should show repository status', () => {
    const output = execSync(`node "${CLI_PATH}" status`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL REPOSITORY STATUS');
    expect(output).not.toContain('Project Name:');
    expect(output).not.toContain('Project ID:');
    expect(output).toContain('AI Config:      openai (gpt-4-turbo)');
    expect(output).toContain('Active:        1');
    expect(output).toContain('Use Drizzle ORM');
    expect(output).toContain('Record decision: Use Drizzle ORM');
  });

  it('should show project brain state', () => {
    const output = execSync(`node "${CLI_PATH}" state`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL — PROJECT BRAIN STATE');
    expect(output).toContain('Use Drizzle ORM');
  });
});
