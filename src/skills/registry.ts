import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type SkillEntrypoint =
  | {
      type: 'script';
      path: string;
      args?: string[];
      autoRun?: boolean;
    }
  | {
      type: 'shell';
      command: string;
      autoRun?: boolean;
    };

export interface SkillManifest {
  name: string;
  purpose: string;
  triggers?: string[];
  entrypoints: Record<string, SkillEntrypoint>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFileInput {
  path: string;
  content: string;
}

export interface CreateSkillPackageInput {
  name: string;
  purpose: string;
  markdown?: string;
  triggers?: string[];
  files?: SkillFileInput[];
  entrypoints?: Record<string, SkillEntrypoint>;
}

export interface SkillSummary {
  name: string;
  purpose: string;
  triggers: string[];
  entrypoints: string[];
  path: string;
}

export interface SkillPackage {
  manifest: SkillManifest;
  markdown: string;
  path: string;
}

export interface SkillRunAttempt {
  entrypoint: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SkillRunResult {
  name: string;
  requestedEntrypoint: string;
  usedEntrypoint: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  attempts: SkillRunAttempt[];
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function getSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, '.knowl', 'skills');
}

export function skillSourcePath(name: string): string {
  validateSkillName(name);
  return `.knowl/skills/${name}/SKILL.md`;
}

function validateSkillName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name "${name}". Use lowercase letters, numbers, underscores, and hyphens.`);
  }
}

function normalizeSkillFilePath(filePath: string): string {
  if (!filePath || filePath.includes('\0') || path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Invalid skill file path "${filePath}"`);
  }

  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid skill file path "${filePath}"`);
  }

  return normalized;
}

function getSkillPackageDir(projectRoot: string, name: string): string {
  validateSkillName(name);
  return path.join(getSkillsDir(projectRoot), name);
}

function resolveSkillFile(projectRoot: string, name: string, filePath: string): string {
  const skillDir = getSkillPackageDir(projectRoot, name);
  const normalized = normalizeSkillFilePath(filePath);
  const resolved = path.resolve(skillDir, ...normalized.split('/'));
  const relative = path.relative(skillDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid skill file path "${filePath}"`);
  }
  return resolved;
}

function normalizeEntrypoints(entrypoints?: Record<string, SkillEntrypoint>): Record<string, SkillEntrypoint> {
  const normalized: Record<string, SkillEntrypoint> = {};
  for (const [name, entrypoint] of Object.entries(entrypoints || {})) {
    if (!SAFE_SKILL_NAME.test(name)) {
      throw new Error(`Invalid skill entrypoint "${name}"`);
    }
    if (entrypoint.type === 'script') {
      normalized[name] = {
        type: 'script',
        path: normalizeSkillFilePath(entrypoint.path),
        args: entrypoint.args || [],
        autoRun: entrypoint.autoRun ?? true,
      };
    } else if (entrypoint.type === 'shell') {
      if (!entrypoint.command.trim()) {
        throw new Error(`Invalid empty shell command for entrypoint "${name}"`);
      }
      normalized[name] = {
        type: 'shell',
        command: entrypoint.command,
        autoRun: entrypoint.autoRun ?? true,
      };
    } else {
      throw new Error(`Invalid skill entrypoint type for "${name}"`);
    }
  }
  return normalized;
}

export async function createSkillPackage(projectRoot: string, input: CreateSkillPackageInput): Promise<SkillPackage> {
  validateSkillName(input.name);
  const skillDir = getSkillPackageDir(projectRoot, input.name);
  const now = new Date().toISOString();
  const manifest: SkillManifest = {
    name: input.name,
    purpose: input.purpose,
    triggers: input.triggers || [],
    entrypoints: normalizeEntrypoints(input.entrypoints),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const markdown = input.markdown || `# ${input.name}\n\nPurpose: ${input.purpose}\n`;

  for (const file of input.files || []) {
    normalizeSkillFilePath(file.path);
  }
  for (const entrypoint of Object.values(manifest.entrypoints)) {
    if (entrypoint.type === 'script') {
      resolveSkillFile(projectRoot, input.name, entrypoint.path);
    }
  }

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), markdown, 'utf-8');
  await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  for (const file of input.files || []) {
    const target = resolveSkillFile(projectRoot, input.name, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf-8');
    await fs.chmod(target, 0o755).catch(() => {});
  }

  return { manifest, markdown, path: skillDir };
}

async function readManifest(skillDir: string): Promise<SkillManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(skillDir, 'skill.json'), 'utf-8')) as SkillManifest;
  validateSkillName(manifest.name);
  manifest.entrypoints = normalizeEntrypoints(manifest.entrypoints);
  manifest.triggers = manifest.triggers || [];
  return manifest;
}

export async function listSkillPackages(projectRoot: string): Promise<SkillSummary[]> {
  const skillsDir = getSkillsDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const summaries: SkillSummary[] = [];
  for (const entry of entries) {
    if (!SAFE_SKILL_NAME.test(entry)) continue;
    const skillDir = path.join(skillsDir, entry);
    const stat = await fs.stat(skillDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    try {
      const manifest = await readManifest(skillDir);
      summaries.push({
        name: manifest.name,
        purpose: manifest.purpose,
        triggers: manifest.triggers || [],
        entrypoints: Object.keys(manifest.entrypoints || {}),
        path: skillDir,
      });
    } catch {
      // Ignore incomplete skill directories; explicit reads report detailed errors.
    }
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillPackage(projectRoot: string, name: string): Promise<SkillPackage> {
  const skillDir = getSkillPackageDir(projectRoot, name);
  const manifest = await readManifest(skillDir);
  const markdown = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
  return { manifest, markdown, path: skillDir };
}

function quoteShellArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function runShell(projectRoot: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  const commandText = args.length > 0
    ? `${command} ${args.map(quoteShellArg).join(' ')}`
    : command;
  return spawnSync(commandText, {
    cwd: projectRoot,
    env,
    shell: true,
    encoding: 'utf-8',
  });
}

function scriptCommand(scriptPath: string, args: string[]): { command: string; args: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', scriptPath, ...args],
    };
  }
  if (ext === '.ps1') {
    return {
      command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    };
  }
  if (ext === '.sh') {
    return { command: 'sh', args: [scriptPath, ...args] };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [scriptPath, ...args] };
  }
  return { command: scriptPath, args };
}

function runScript(projectRoot: string, scriptPath: string, args: string[], env: NodeJS.ProcessEnv) {
  const command = scriptCommand(scriptPath, args);
  return spawnSync(command.command, command.args, {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
  });
}

function childToAttempt(entrypoint: string, child: ReturnType<typeof spawnSync>): SkillRunAttempt {
  return {
    entrypoint,
    exitCode: child.status ?? 1,
    stdout: child.stdout?.toString() || '',
    stderr: `${child.stderr?.toString() || ''}${child.error ? child.error.message : ''}`,
  };
}

export async function runSkillPackage(
  projectRoot: string,
  name: string,
  entrypointName = 'default',
  args: string[] = []
): Promise<SkillRunResult> {
  const skill = await readSkillPackage(projectRoot, name);
  const attempts: SkillRunAttempt[] = [];

  async function runNamed(nameToRun: string): Promise<SkillRunAttempt> {
    const entrypoint = skill.manifest.entrypoints[nameToRun];
    if (!entrypoint) {
      throw new Error(`Skill "${name}" does not define entrypoint "${nameToRun}"`);
    }
    if (entrypoint.autoRun === false) {
      throw new Error(`Skill "${name}" entrypoint "${nameToRun}" does not allow auto-run`);
    }

    const env = {
      ...process.env,
      KNOWL_PROJECT_ROOT: projectRoot,
      KNOWL_SKILL_NAME: skill.manifest.name,
      KNOWL_SKILL_DIR: skill.path,
    };
    const child = entrypoint.type === 'shell'
      ? runShell(projectRoot, entrypoint.command, args, env)
      : runScript(
          projectRoot,
          resolveSkillFile(projectRoot, skill.manifest.name, entrypoint.path),
          [...(entrypoint.args || []), ...args],
          env
        );
    const attempt = childToAttempt(nameToRun, child);
    attempts.push(attempt);
    return attempt;
  }

  let attempt = await runNamed(entrypointName);
  if (attempt.exitCode !== 0 && entrypointName !== 'fallback' && skill.manifest.entrypoints.fallback) {
    attempt = await runNamed('fallback');
  }

  return {
    name: skill.manifest.name,
    requestedEntrypoint: entrypointName,
    usedEntrypoint: attempt.entrypoint,
    exitCode: attempt.exitCode,
    stdout: attempt.stdout,
    stderr: attempt.stderr,
    attempts,
  };
}
