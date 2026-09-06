import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_PATH = path.resolve('dist/index.js');
const ROOT_DIR = path.resolve('.');
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('plugin export and built artifact verification', () => {
  let scratchDir: string;
  let consumerDir: string;
  let tgzPath: string;
  let pluginModule: typeof import('../../src/plugin.js');

  beforeAll(async () => {
    // 1. Pack the built artifact into scratch directory
    scratchDir = path.join(os.tmpdir(), `knowl-pack-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(scratchDir, { recursive: true });

    const packOutput = execFileSync(NPM_CMD, ['pack', '--pack-destination', scratchDir], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim().split(/\r?\n/).pop()!;
    tgzPath = path.join(scratchDir, packOutput);

    // 2. Install into consumer scratch directory with OpenClaw's exact flags
    consumerDir = path.join(scratchDir, 'consumer');
    await fs.mkdir(consumerDir, { recursive: true });
    await fs.writeFile(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'consumer', type: 'module' }, null, 2),
      'utf8',
    );

    execFileSync(
      NPM_CMD,
      [
        'install',
        tgzPath,
        '--omit=dev',
        '--omit=peer',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: consumerDir, encoding: 'utf8', shell: process.platform === 'win32' },
    );

    const consumerRequire = createRequire(path.join(consumerDir, 'package.json'));
    const pluginResolvedPath = consumerRequire.resolve('@dat999zx/knowl/plugin');
    pluginModule = await import(pathToFileURL(pluginResolvedPath).href);
    // 300s, not the default: this hook runs a real `npm pack` and a real `npm install` of the
    // resulting tarball into a scratch consumer, which is the only way to prove the exports map
    // resolves the way it will for a user. That is ~54s on an idle machine and comfortably past
    // 120s once the rest of the suite is running in parallel, where it timed out. The budget is
    // for the package manager, not for anything this test asserts.
  }, 300_000);

  afterAll(async () => {
    if (scratchDir && existsSync(scratchDir)) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('still prints version from dist/index.js', () => {
    const versionOutput = execFileSync(process.execPath, [CLI_PATH, '--version'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    }).trim();
    const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    expect(versionOutput).toBe(pkg.version);
  });

  it('resolves all 5 exported paths without breaking Cline', () => {
    const consumerRequire = createRequire(path.join(consumerDir, 'package.json'));

    // 1. Root export (.)
    expect(consumerRequire.resolve('@dat999zx/knowl')).toBeTruthy();

    // 2. Plugin export (./plugin)
    expect(consumerRequire.resolve('@dat999zx/knowl/plugin')).toBeTruthy();

    // 3. Package.json export (./package.json)
    expect(consumerRequire.resolve('@dat999zx/knowl/package.json')).toBeTruthy();

    // 4. Cline integration export (./integrations/*)
    const clinePath = consumerRequire.resolve('@dat999zx/knowl/integrations/cline/knowl-plugin.mjs');
    expect(existsSync(clinePath)).toBe(true);

    // 5. Dist wildcard export (./dist/*)
    const distIndexPath = consumerRequire.resolve('@dat999zx/knowl/dist/index.js');
    expect(existsSync(distIndexPath)).toBe(true);
  });

  it('exports openProject, normalizeHostHook, readLifecyclePayloadObject, and KNOWL_MIGRATION_LEVEL', () => {
    expect(typeof pluginModule.openProject).toBe('function');
    expect(typeof pluginModule.normalizeHostHook).toBe('function');
    expect(typeof pluginModule.readLifecyclePayloadObject).toBe('function');
    expect(typeof pluginModule.KNOWL_MIGRATION_LEVEL).toBe('number');
    expect(pluginModule.KNOWL_MIGRATION_LEVEL).toBeGreaterThan(0);
  });

  it('built plugin chunk does not pull commander into its module tree', () => {
    const distPluginPath = path.resolve('dist/plugin.js');
    const visited = new Set<string>();

    function inspect(file: string) {
      if (visited.has(file)) return;
      visited.add(file);
      const content = readFileSync(file, 'utf8');
      expect(content).not.toContain('commander');
      const matches = content.matchAll(/from\s+['"](\.[^'"]+)['"]/g);
      for (const match of matches) {
        const dep = path.resolve(path.dirname(file), match[1]);
        inspect(dep);
      }
    }

    inspect(distPluginPath);
    expect(visited.size).toBeGreaterThan(0);
  });

  it('returns null on ProjectNotFoundError and throws MissingKnowledgeDatabaseError on missing db', async () => {
    const nonExistentDir = path.join(scratchDir, 'non-existent-repo');
    await fs.mkdir(nonExistentDir, { recursive: true });

    // Non-repo directory returns null
    const handle = await pluginModule.openProject(nonExistentDir);
    expect(handle).toBeNull();

    // Initialized repo with deleted database file throws MissingKnowledgeDatabaseError
    const missingDbDir = path.join(scratchDir, 'missing-db-repo');
    await fs.mkdir(missingDbDir, { recursive: true });
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: missingDbDir, encoding: 'utf8' });
    const dbFile = path.join(missingDbDir, '.knowl', 'knowl.db');
    await fs.rm(dbFile, { force: true });

    await expect(pluginModule.openProject(missingDbDir)).rejects.toThrow(
      pluginModule.MissingKnowledgeDatabaseError,
    );
  });

  it('multi-project regression: writes to project A land in project A and never in project B', async () => {
    const projectADir = path.join(scratchDir, 'projectA');
    const projectBDir = path.join(scratchDir, 'projectB');
    await fs.mkdir(projectADir, { recursive: true });
    await fs.mkdir(projectBDir, { recursive: true });

    // Initialize both projects using the CLI
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: projectADir, encoding: 'utf8' });
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: projectBDir, encoding: 'utf8' });

    // Open handles to both projects concurrently in this single process
    const handleA = await pluginModule.openProject(projectADir);
    const handleB = await pluginModule.openProject(projectBDir);

    expect(handleA).not.toBeNull();
    expect(handleB).not.toBeNull();

    try {
      expect(path.resolve(handleA!.projectRoot)).toBe(path.resolve(projectADir));
      expect(path.resolve(handleB!.projectRoot)).toBe(path.resolve(projectBDir));
      expect(path.resolve(handleA!.databasePath)).not.toBe(path.resolve(handleB!.databasePath));

      // Write strictly through handleA
      const writeResult = await handleA!.store({
        category: 'decision',
        title: 'Project A Architectural Isolation',
        content: 'Verification row asserting project A isolation in in-process execution.',
      });
      expect(writeResult.action).toBe('inserted');

      // Verify handleA can retrieve it
      const resultsA = await handleA!.query('Project A Architectural Isolation');
      expect(resultsA.some((item) => item.title === 'Project A Architectural Isolation')).toBe(true);

      // Verify handleB CANNOT retrieve it
      const resultsB = await handleB!.query('Project A Architectural Isolation');
      expect(resultsB.some((item) => item.title === 'Project A Architectural Isolation')).toBe(false);

      // Verify at the SQLite level directly
      const clientA = createClient({ url: `file:${handleA!.databasePath}` });
      const clientB = createClient({ url: `file:${handleB!.databasePath}` });

      const rowsA = await clientA.execute({
        sql: 'SELECT id, title FROM knowledge_items WHERE title = ?',
        args: ['Project A Architectural Isolation'],
      });
      const rowsB = await clientB.execute({
        sql: 'SELECT id, title FROM knowledge_items WHERE title = ?',
        args: ['Project A Architectural Isolation'],
      });

      clientA.close();
      clientB.close();

      expect(rowsA.rows.length).toBe(1);
      expect(rowsB.rows.length).toBe(0);
    } finally {
      await handleA!.release();
      await handleB!.release();
    }
  }, 60_000);
});
