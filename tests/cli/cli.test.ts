import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
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
    const output = execSync(`node "${CLI_PATH}" init "CLI Test Project"`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('Successfully initialized KNOWL repository!');
    expect(output).toContain('CLI Test Project');
    expect(output).toContain('codex mcp add knowl');

    // Verify files exist
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'knowl.db'))).resolves.toBeUndefined();
    const config = JSON.parse(await fs.readFile(path.join(TEST_DIR, '.knowl', 'config.json'), 'utf-8'));
    expect(config.search.vector.enabled).toBe(false);
    expect(config.search.vector.provider).toBe('local');
  });

  it('should create project .gitignore with .knowl during init', async () => {
    const ignoreDir = path.resolve('./.knowl-cli-new-gitignore-test');
    await fs.rm(ignoreDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(ignoreDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init "New Gitignore Project"`, {
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

    execSync(`node "${CLI_PATH}" init "Gitignore Project"`, {
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
    expect(content).toContain('At the start of any project-specific task, query Knowl for relevant facts, decisions, constraints, architecture, state, and skills before inspecting files or editing code');
    expect(content).toContain('For specific project questions, call `knowl_query` first');
    expect(content).toContain('Do not use `knowl_ask` for MCP first-pass lookup');
    expect(content).toContain('Use 2-6 concise search keywords');
    expect(content).toContain('Omit category filters unless you are certain');
    expect(content).toContain('Only use `knowl_state` for broad project-memory summaries');
    expect(content).toContain('Do not inspect repository files before this targeted Knowl query');
    expect(content).toContain('If `knowl_query` returns a relevant active item, answer from Knowl immediately');
    expect(content).toContain('Do not inspect repository files just to re-verify known facts');
    expect(content).toContain('Only inspect repository files when Knowl misses, conflicts, looks stale or low-confidence, or the user asks for source verification');
    expect(content).toContain('If the Knowl MCP tools are unavailable');
    expect(content).toContain('`Auth: Unsupported` on a local stdio MCP server is normal');
    expect(content).toContain('knowl_state');
    expect(content).toContain('knowl_query');
    expect(content).toContain('knowl_store');
    expect(content).toContain('knowl_decide');
    expect(content).toContain('During work, keep Knowl current');
    expect(content).toContain('If new findings contradict or replace existing memory, use `knowl_update`');
    expect(content).toContain('Before the final answer, check whether the work produced durable knowledge');
    expect(content).toContain('implemented feature summaries, setup steps, architecture changes, important commands, decisions, constraints, recurring bugs, gotchas, and verified project facts');
    expect(content).toContain('Store durable knowledge as concise structured atoms, not raw chat transcripts');
    expect(content).toContain('After discovering and verifying durable project knowledge from repository files, store it in Knowl');
    expect(content).toContain('Do not store temporary debugging noise');
  });

  it('should report AGENTS.md guidance status when init is rerun in an existing repository', () => {
    const output = execSync(`node "${CLI_PATH}" init "CLI Test Project"`, {
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

    execSync(`node "${CLI_PATH}" init "Old Config Project"`, {
      cwd: oldProjectDir,
      encoding: 'utf-8',
    });

    const config = JSON.parse(await fs.readFile(path.join(oldProjectDir, '.knowl', 'config.json'), 'utf-8'));
    expect(config.ai.provider).toBe('openai');
    expect(config.security.secretPatterns).toEqual(['password']);
    expect(config.search.vector.enabled).toBe(false);
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

    execSync(`node "${CLI_PATH}" init "Old DB Project"`, {
      cwd: oldDbDir,
      encoding: 'utf-8',
    });

    const output = execSync(`node "${CLI_PATH}" status`, {
      cwd: oldDbDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL REPOSITORY STATUS');
    expect(output).toContain('Old DB Project');

    await fs.rm(oldDbDir, { recursive: true, force: true });
  });

  it('should run explicit upgrade for existing repositories', async () => {
    const upgradeDir = path.resolve('./.knowl-cli-upgrade-test');
    await fs.rm(upgradeDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(upgradeDir, { recursive: true });

    execSync(`node "${CLI_PATH}" init "Upgrade Project"`, {
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

    execSync(`node "${CLI_PATH}" init "Existing Agents Project"`, {
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

    execSync(`node "${CLI_PATH}" init "Refresh Agents Project"`, {
      cwd: AGENTS_REFRESH_TEST_DIR,
      encoding: 'utf-8',
    });

    await fs.writeFile(
      agentsPath,
      '# Agent Instructions\n\n<!-- KNOWL_PROJECT_MEMORY -->\n## Knowl Project Memory\n\n- Before answering project-specific questions, query Knowl first using `knowl_state` or `knowl_query`.\n',
      'utf-8'
    );

    execSync(`node "${CLI_PATH}" init "Refresh Agents Project"`, {
      cwd: AGENTS_REFRESH_TEST_DIR,
      encoding: 'utf-8',
    });

    const content = await fs.readFile(agentsPath, 'utf-8');
    expect(content).toContain('At the start of any project-specific task, query Knowl');
    expect(content).toContain('For specific project questions, call `knowl_query` first');
    expect(content).toContain('Do not use `knowl_ask` for MCP first-pass lookup');
    expect(content).toContain('If `knowl_query` returns a relevant active item, answer from Knowl immediately');
    expect(content).toContain('Before the final answer, check whether the work produced durable knowledge');
    expect(content).toContain('After discovering and verifying durable project knowledge from repository files, store it in Knowl');
    expect((content.match(/## Knowl Project Memory/g) || []).length).toBe(1);
  });

  it('should initialize without AI provider configuration by default', () => {
    const aiConfig = execSync(`node "${CLI_PATH}" config ai`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();

    expect(aiConfig).toBe('undefined');
  });

  it('should allow explicit AI provider configuration', () => {
    const providerUpdate = execSync(`node "${CLI_PATH}" config ai.provider openai`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();
    expect(providerUpdate).toContain('Set "ai.provider" to: "openai"');

    const modelUpdate = execSync(`node "${CLI_PATH}" config ai.model gpt-4-turbo`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    }).trim();
    expect(modelUpdate).toContain('Set "ai.model" to: "gpt-4-turbo"');

    const model = execSync(`node "${CLI_PATH}" config ai.model`, {
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

  it('should report agent readiness with doctor', async () => {
    const doctorDir = path.resolve('./.knowl-cli-doctor-test');
    await fs.rm(doctorDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(doctorDir, { recursive: true });
    execSync(`node "${CLI_PATH}" init "Doctor Project"`, {
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
    expect(output).toContain('[OK] Vector search disabled; BM25 retrieval remains active');
    expect(output).toContain('Result: READY');

    await fs.rm(doctorDir, { recursive: true, force: true });
  });

  it('should require vector search to be enabled before vector reindex', () => {
    expect(() => execSync(`node "${CLI_PATH}" reindex --vectors`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
      stdio: 'pipe',
    })).toThrow(/Vector search is not enabled/);
  });

  it('should show repository status', () => {
    const output = execSync(`node "${CLI_PATH}" status`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    expect(output).toContain('KNOWL REPOSITORY STATUS');
    expect(output).toContain('CLI Test Project');
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
