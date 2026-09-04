import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_DIR = path.join(os.tmpdir(), 'knowl-cli-skill-test');
const CLI_PATH = path.resolve('./dist/index.js');

describe('CLI learned skills', () => {
  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('should create, list, read, and run learned skill packages from the CLI', async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_DIR, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    const createOutput = execFileSync(process.execPath, [
      CLI_PATH,
      'skill',
      'create',
      'run_app',
      '--purpose',
      'Start the app locally',
      '--markdown',
      '# Run App\n\nUse this to start the app.\n',
      '--file',
      "run.js=console.log('cli-skill-ok');\n",
      '--script',
      'run.js',
    ], {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(createOutput).toContain('Created skill run_app');

    const listOutput = execSync(`node "${CLI_PATH}" skill list`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(listOutput).toContain('run_app');
    expect(listOutput).toContain('Start the app locally');

    const readOutput = execSync(`node "${CLI_PATH}" skill read run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(readOutput).toContain('# Run App');
    expect(readOutput).toContain('"name": "run_app"');

    // Running is gated on a human approving these exact bytes, so the CLI flow has to include
    // it. Exercised through the real command rather than the module, because that command is
    // the whole interface a user has to this decision.
    const approveOutput = execSync(`node "${CLI_PATH}" skill approve run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(approveOutput).toContain('Approved skill "run_app"');
    expect(approveOutput).toMatch(/Hash: sha256:[0-9a-f]{64}/);

    const trustOutput = execSync(`node "${CLI_PATH}" skill trust`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(trustOutput).toContain('run_app');

    const runOutput = execSync(`node "${CLI_PATH}" skill run run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(runOutput).toContain('cli-skill-ok');

    const stateOutput = execSync(`node "${CLI_PATH}" state`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(stateOutput).toContain('run_app');

    const agents = await fs.readFile(path.join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('knowl_skill_list');
    expect(agents).toContain('knowl_skill_read');
    expect(agents).toContain('knowl_skill_run');
  }, 120_000);

  it('global playbook lifecycle: unbound refusal, binding, global approval, precondition check, and hash invalidation', async () => {
    const GLOBAL_HOME = path.join(os.tmpdir(), 'knowl-cli-global-home');
    const PROJECT_DIR = path.join(os.tmpdir(), 'knowl-cli-global-project');
    await fs.rm(GLOBAL_HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(GLOBAL_HOME, 'skills', 'deploy_task'), { recursive: true });
    await fs.mkdir(path.join(PROJECT_DIR, '.knowl'), { recursive: true });

    execSync('git init', { cwd: PROJECT_DIR, stdio: 'pipe' });
    // Identity on the invocation, never written to a config file -- see
    // tests/architecture/git-identity.test.ts for what a written one costs.
    const AS_TEST = 'git -c user.name="Test" -c user.email="test@example.com"';
    await fs.writeFile(path.join(PROJECT_DIR, 'README.md'), '# Project\n');
    execSync('git add .', { cwd: PROJECT_DIR, stdio: 'pipe' });
    execSync(`${AS_TEST} commit -m "initial commit"`, { cwd: PROJECT_DIR, stdio: 'pipe' });
    execSync(`node "${CLI_PATH}" init --yes`, { cwd: PROJECT_DIR, env: { ...process.env, KNOWL_HOME: GLOBAL_HOME }, encoding: 'utf-8', stdio: 'pipe' });
    execSync('git add .', { cwd: PROJECT_DIR, stdio: 'pipe' });
    execSync(`${AS_TEST} commit -m "commit knowl init"`, { cwd: PROJECT_DIR, stdio: 'pipe' });

    const playbookYaml = [
      'name: deploy_task',
      'purpose: Deploy application',
      'version: 1',
      'requires:',
      '  inputs:',
      '    target_env:',
      '      description: Target environment',
      '  preconditions:',
      '    - clean_worktree',
      '  capabilities:',
      '    - process',
      'entrypoints:',
      '  default:',
      '    type: script',
      '    path: deploy.js',
      '    args: ["${inputs.target_env}"]',
      '    autoRun: true',
    ].join('\n') + '\n';

    await fs.writeFile(
      path.join(GLOBAL_HOME, 'skills', 'deploy_task', 'deploy.js'),
      "console.log('DEPLOYED_' + process.argv[2]);\n",
      'utf8',
    );
    await fs.writeFile(path.join(GLOBAL_HOME, 'skills', 'deploy_task', 'skill.yaml'), playbookYaml, 'utf8');

    const env = { ...process.env, KNOWL_HOME: GLOBAL_HOME };

    // 1. Run unbound: refused, names missing input
    let unboundFailed = false;
    try {
      execSync(`node "${CLI_PATH}" skill run deploy_task`, { cwd: PROJECT_DIR, env, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err: any) {
      unboundFailed = true;
      const out = (err.stderr || '') + (err.stdout || '');
      expect(out).toMatch(/target_env/);
      expect(out).toMatch(/missing/i);
    }
    expect(unboundFailed).toBe(true);

    // 2. Bind in project config
    const config = {
      skills: {
        deploy_task: {
          inputs: {
            target_env: 'production',
          },
        },
      },
    };
    await fs.writeFile(path.join(PROJECT_DIR, '.knowl', 'config.json'), JSON.stringify(config, null, 2), 'utf8');

    // 3. Approve global playbook
    const approveOutput = execSync(`node "${CLI_PATH}" skill approve deploy_task --global`, {
      cwd: PROJECT_DIR,
      env,
      encoding: 'utf-8',
    });
    expect(approveOutput).toContain('Approved skill "deploy_task"');
    expect(approveOutput).toMatch(/Hash: sha256:[0-9a-f]{64}/);

    // 4. Run with dirty worktree: refused, names clean_worktree precondition
    await fs.writeFile(path.join(PROJECT_DIR, 'uncommitted.txt'), 'dirty');
    let dirtyFailed = false;
    try {
      execSync(`node "${CLI_PATH}" skill run deploy_task`, { cwd: PROJECT_DIR, env, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err: any) {
      dirtyFailed = true;
      const out = (err.stderr || '') + (err.stdout || '');
      expect(out).toMatch(/clean_worktree/);
    }
    expect(dirtyFailed).toBe(true);

    // 5. Commit and run: banner shows resolved command, execution succeeds
    execSync('git add .', { cwd: PROJECT_DIR, stdio: 'pipe' });
    execSync(`${AS_TEST} commit -m "clean worktree"`, { cwd: PROJECT_DIR, stdio: 'pipe' });

    const runOutput = execSync(`node "${CLI_PATH}" skill run deploy_task`, {
      cwd: PROJECT_DIR,
      env,
      encoding: 'utf-8',
    });
    expect(runOutput).toContain('knowl skill run deploy_task');
    expect(runOutput).toContain('production');
    expect(runOutput).toContain('clean_worktree');
    expect(runOutput).toContain('DEPLOYED_production');

    // 6. Edit playbook: approval is invalidated
    await fs.writeFile(
      path.join(GLOBAL_HOME, 'skills', 'deploy_task', 'skill.yaml'),
      playbookYaml + '# modified\n',
      'utf8',
    );
    let modifiedFailed = false;
    try {
      execSync(`node "${CLI_PATH}" skill run deploy_task`, { cwd: PROJECT_DIR, env, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err: any) {
      modifiedFailed = true;
      const out = (err.stderr || '') + (err.stdout || '');
      expect(out).toMatch(/changed since it was approved/i);
    }
    expect(modifiedFailed).toBe(true);

    await fs.rm(GLOBAL_HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});
  }, 120_000);
});
