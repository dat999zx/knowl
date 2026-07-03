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

    // Verify files exist
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(TEST_DIR, '.knowl', 'knowl.db'))).resolves.toBeUndefined();
  });

  it('should create AGENTS.md with Knowl MCP guidance during init', async () => {
    const agentsPath = path.join(TEST_DIR, 'AGENTS.md');
    const content = await fs.readFile(agentsPath, 'utf-8');

    expect(content).toContain('## Knowl Project Memory');
    expect(content).toContain('Before answering project-specific questions, query Knowl first');
    expect(content).toContain('knowl_state');
    expect(content).toContain('knowl_query');
    expect(content).toContain('knowl_store');
    expect(content).toContain('knowl_decide');
    expect(content).toContain('After discovering and verifying durable project knowledge from repository files, store it in Knowl');
    expect(content).toContain('Do not store temporary debugging noise');
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
