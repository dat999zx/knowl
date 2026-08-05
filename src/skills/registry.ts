import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSkillApproved } from './trust.js';

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
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SkillRunResult {
  name: string;
  requestedEntrypoint: string;
  usedEntrypoint: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  attempts: SkillRunAttempt[];
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Windows re-parses the command line of a batch file *after* Node has quoted it for MSVCRT,
 * under rules that do not honour `\"` — so no argv quoting can make `cmd.exe /d /c run.cmd
 * <args>` safe (BatBadBut / CVE-2024-24576). Node itself has refused to spawn `.bat`/`.cmd`
 * without an explicit shell since April 2024 for this reason. There is no escape to write
 * here; the fix is to not run them.
 */
const UNRUNNABLE_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat']);

function assertRunnableScriptPath(scriptPath: string): void {
  const ext = path.extname(scriptPath).toLowerCase();
  if (UNRUNNABLE_SCRIPT_EXTENSIONS.has(ext)) {
    throw new Error(
      `Skill entrypoint "${scriptPath}" is a ${ext} batch script, which cannot receive arguments safely on Windows (CVE-2024-24576). Use .ps1, .js or .sh instead.`
    );
  }
}

export function getSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, '.knowl', 'skills');
}

export function skillSourcePath(name: string): string {
  validateSkillName(name);
  return `.knowl/skills/${name}/SKILL.md`;
}

export function validateSkillName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name "${name}". Use lowercase letters, numbers, underscores, and hyphens.`);
  }
}

export function normalizeSkillFilePath(filePath: string): string {
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
        autoRun: entrypoint.autoRun ?? false,
      };
    } else if (entrypoint.type === 'shell') {
      if (!entrypoint.command.trim()) {
        throw new Error(`Invalid empty shell command for entrypoint "${name}"`);
      }
      normalized[name] = {
        type: 'shell',
        command: entrypoint.command,
        autoRun: entrypoint.autoRun ?? false,
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
      assertRunnableScriptPath(entrypoint.path);
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

/**
 * The directory name is the identity. A manifest claiming a different one is rejected rather
 * than trusted, because entrypoint resolution followed the manifest: a package inspected as
 * `foo` could execute the files of `bar`, so `knowl skill read` and `knowl_skill_run` could
 * disagree about what the agent had just approved.
 */
async function readManifest(skillDir: string, expectedName: string): Promise<SkillManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(skillDir, 'skill.json'), 'utf-8')) as SkillManifest;
  validateSkillName(manifest.name);
  if (manifest.name !== expectedName) {
    throw new Error(
      `Skill package in "${expectedName}" declares the name "${manifest.name}". The directory name ` +
      'is the identity Knowl runs; rename one so the two agree.',
    );
  }
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
      const manifest = await readManifest(skillDir, entry);
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
  const manifest = await readManifest(skillDir, name);
  const markdown = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
  return { manifest, markdown, path: skillDir };
}

/**
 * Ceilings on one skill run. A learned skill is agent-authored and agent-triggered, so an
 * accidental infinite loop or a gigabyte of stdout is an ordinary outcome, not an attack.
 */
const MAX_SKILL_RUNTIME_MS = 120_000;
const MAX_SKILL_OUTPUT_BYTES = 8 * 1024 * 1024;

function spawnLimits(projectRoot: string, env: NodeJS.ProcessEnv) {
  return {
    cwd: projectRoot,
    env,
    encoding: 'utf-8' as const,
    timeout: MAX_SKILL_RUNTIME_MS,
    maxBuffer: MAX_SKILL_OUTPUT_BYTES,
  };
}

/**
 * Variables a child process needs to function, and nothing else.
 *
 * Inheriting `process.env` handed every skill run the host's model-provider keys, cloud
 * credentials, GitHub tokens and SSH-agent socket. A learned skill is agent-authored; the
 * default has to be that it sees none of that.
 */
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'SystemRoot', 'SystemDrive', 'windir',
  'ComSpec', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'TZ', 'NUMBER_OF_PROCESSORS',
];

export function skillEnvironment(projectRoot: string, skill: SkillPackage): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.KNOWL_PROJECT_ROOT = projectRoot;
  env.KNOWL_SKILL_NAME = skill.manifest.name;
  env.KNOWL_SKILL_DIR = skill.path;
  return env;
}

function runShell(projectRoot: string, command: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, { ...spawnLimits(projectRoot, env), shell: true });
}

function scriptCommand(scriptPath: string, args: string[]): { command: string; args: string[] } {
  assertRunnableScriptPath(scriptPath);
  const ext = path.extname(scriptPath).toLowerCase();
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
  const child = spawnSync(command.command, command.args, spawnLimits(projectRoot, env));
  return { child, commandText: [command.command, ...command.args].join(' ') };
}

function childToAttempt(entrypoint: string, commandText: string, child: ReturnType<typeof spawnSync>): SkillRunAttempt {
  return {
    entrypoint,
    command: commandText,
    exitCode: child.status ?? 1,
    stdout: child.stdout?.toString() || '',
    stderr: `${child.stderr?.toString() || ''}${child.error ? child.error.message : ''}`,
  };
}

export async function runSkillPackage(
  projectRoot: string,
  name: string,
  entrypointName = 'default',
  args: string[] = [],
  options: { allowFallback?: boolean } = {}
): Promise<SkillRunResult> {
  const skill = await readSkillPackage(projectRoot, name);
  const attempts: SkillRunAttempt[] = [];

  async function runNamed(nameToRun: string): Promise<SkillRunAttempt> {
    const entrypoint = skill.manifest.entrypoints[nameToRun];
    if (!entrypoint) {
      throw new Error(`Skill "${name}" does not define entrypoint "${nameToRun}"`);
    }
    if (entrypoint.autoRun !== true) {
      throw new Error(`Skill "${name}" entrypoint "${nameToRun}" does not allow auto-run`);
    }
    // A shell entrypoint is a command *string*, so arguments could only be appended by
    // quoting them into it — and no quoting is correct for both cmd.exe and POSIX shells.
    // Refuse instead of appending something that looks escaped and is not.
    if (entrypoint.type === 'shell' && args.length > 0) {
      throw new Error(
        `Skill "${name}" entrypoint "${nameToRun}" is a shell command and cannot take arguments safely. Pass values through the KNOWL_* environment, or use a script entrypoint.`
      );
    }

    // A human approved these exact bytes for this entrypoint, or nothing runs. Checked here
    // rather than at the call sites because this is the only path that spawns a process.
    await assertSkillApproved(projectRoot, name, nameToRun);

    const env = skillEnvironment(projectRoot, skill);
    const { child, commandText } = entrypoint.type === 'shell'
      ? { child: runShell(projectRoot, entrypoint.command, env), commandText: entrypoint.command }
      : runScript(
          projectRoot,
          resolveSkillFile(projectRoot, name, entrypoint.path),
          [...(entrypoint.args || []), ...args],
          env
        );
    const attempt = childToAttempt(nameToRun, commandText, child);
    attempts.push(attempt);
    return attempt;
  }

  let attempt = await runNamed(entrypointName);
  // Opt-in, not automatic. A failed entrypoint used to chain straight into `fallback`, so a
  // caller who asked for one execution got two and the second was never named in the request.
  // A package that wants its fallback run can be asked for it; it should not be able to arrange
  // its own second attempt by failing the first.
  if (
    options.allowFallback
    && attempt.exitCode !== 0
    && entrypointName !== 'fallback'
    && skill.manifest.entrypoints.fallback
  ) {
    attempt = await runNamed('fallback');
  }

  return {
    name: skill.manifest.name,
    requestedEntrypoint: entrypointName,
    usedEntrypoint: attempt.entrypoint,
    command: attempt.command,
    exitCode: attempt.exitCode,
    stdout: attempt.stdout,
    stderr: attempt.stderr,
    attempts,
  };
}
