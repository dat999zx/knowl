import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { globalSkillsRoot } from './paths.js';
import { assertSkillApproved, assertBindingNotSelfApproved, readTrust } from './trust.js';
import { resolveBinding, interpolate, assertPinned, type SkillBinding } from './bindings.js';
import { checkPreconditions } from './preconditions.js';
import { formatRunBanner } from './run-banner.js';
import { loadConfig } from '../core/config.js';
import type { ProjectConfig } from '../core/types.js';
import {
  SAFE_SKILL_NAME, normalizeSkillFilePath, validateSkillName,
} from '../core/skill-paths.js';

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

export type SkillCapability = 'process' | 'network' | 'write' | 'publish' | 'delete';

export interface SkillRequires {
  capabilities?: SkillCapability[];
  inputs?: Record<string, { description?: string; default?: string }>;
  preconditions?: string[];
}

export interface SkillManifest {
  name: string;
  purpose: string;
  triggers?: string[];
  entrypoints: Record<string, SkillEntrypoint>;
  version: number;
  createdAt: string;
  updatedAt: string;
  requires?: SkillRequires;
  provenance?: string;
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
  requires?: SkillRequires;
  provenance?: string;
}

export interface SkillSummary {
  name: string;
  purpose: string;
  triggers: string[];
  entrypoints: string[];
  path: string;
  layer: 'project' | 'global';
}

export interface SkillPackage {
  manifest: SkillManifest;
  markdown: string;
  path: string;
  layer?: 'project' | 'global';
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

/**
 * Both validators live in `core/skill-paths.ts` — `store/portability.ts` applies the same rule
 * when importing a bundle and cannot import upward into this feature to get it. Re-exported
 * here so the registry stays the obvious place to look.
 */
export { normalizeSkillFilePath, validateSkillName } from '../core/skill-paths.js';

function getSkillPackageDir(projectRoot: string, name: string): string {
  validateSkillName(name);
  return path.join(getSkillsDir(projectRoot), name);
}

function resolveSkillFile(skillDir: string, filePath: string): string {
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

async function findManifestFile(skillDir: string): Promise<string | null> {
  for (const file of ['skill.yaml', 'skill.yml', 'skill.json']) {
    try {
      const filePath = path.join(skillDir, file);
      await fs.access(filePath);
      return filePath;
    } catch {
      // ignore
    }
  }
  return null;
}

export async function createSkillPackage(projectRoot: string, input: CreateSkillPackageInput): Promise<SkillPackage> {
  validateSkillName(input.name);
  const skillDir = getSkillPackageDir(projectRoot, input.name);
  // Create means create. `mkdir -p` + `writeFile` silently overwrote an existing package --
  // a second create of the same name replaced its SKILL.md and entrypoints, reported
  // "Successfully created", and did not bump the version, so a working skill could vanish
  // with no trace. Refuse instead; editing an existing skill is its own operation.
  if (await findManifestFile(skillDir)) {
    throw new Error(
      `A skill named "${input.name}" already exists. Creating would overwrite it. ` +
      `Delete it first, or choose another name.`,
    );
  }
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
      resolveSkillFile(skillDir, entrypoint.path);
    }
  }

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), markdown, 'utf-8');
  await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  for (const file of input.files || []) {
    const target = resolveSkillFile(skillDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf-8');
    await fs.chmod(target, 0o755).catch(() => {});
  }

  return { manifest, markdown, path: skillDir, layer: 'project' };
}

/**
 * The directory name is the identity. A manifest claiming a different one is rejected rather
 * than trusted, because entrypoint resolution followed the manifest: a package inspected as
 * `foo` could execute the files of `bar`, so `knowl skill read` and `knowl_skill_run` could
 * disagree about what the agent had just approved.
 */
async function readManifest(skillDir: string, expectedName: string): Promise<SkillManifest> {
  const manifestPath = await findManifestFile(skillDir);
  if (!manifestPath) {
    throw new Error(`Skill package in "${expectedName}" is missing a manifest (skill.yaml or skill.json)`);
  }
  const raw = await fs.readFile(manifestPath, 'utf-8');
  const manifest = (manifestPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)) as SkillManifest;
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

async function listSkillsInDir(skillsDir: string, layer: 'project' | 'global'): Promise<SkillSummary[]> {
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
        layer,
      });
    } catch {
      // Ignore incomplete skill directories; explicit reads report detailed errors.
    }
  }
  return summaries;
}

export async function listSkillPackages(projectRoot: string): Promise<SkillSummary[]> {
  const projectSummaries = await listSkillsInDir(getSkillsDir(projectRoot), 'project');
  const globalSummaries = await listSkillsInDir(globalSkillsRoot(), 'global');

  const projectNames = new Set(projectSummaries.map(s => s.name));
  const effectiveGlobals = globalSummaries.filter(s => !projectNames.has(s.name));

  const all = [...projectSummaries, ...effectiveGlobals];
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillPackage(projectRoot: string, name: string): Promise<SkillPackage> {
  validateSkillName(name);
  const projectSkillDir = getSkillPackageDir(projectRoot, name);
  const hasProject = await findManifestFile(projectSkillDir);
  if (hasProject) {
    const manifest = await readManifest(projectSkillDir, name);
    const markdown = await fs.readFile(path.join(projectSkillDir, 'SKILL.md'), 'utf-8').catch(() => '');
    return { manifest, markdown, path: projectSkillDir, layer: 'project' };
  }

  const globalSkillDir = path.join(globalSkillsRoot(), name);
  const hasGlobal = await findManifestFile(globalSkillDir);
  if (hasGlobal) {
    const manifest = await readManifest(globalSkillDir, name);
    const markdown = await fs.readFile(path.join(globalSkillDir, 'SKILL.md'), 'utf-8').catch(() => '');
    return { manifest, markdown, path: globalSkillDir, layer: 'global' };
  }

  const manifest = await readManifest(projectSkillDir, name);
  const markdown = await fs.readFile(path.join(projectSkillDir, 'SKILL.md'), 'utf-8').catch(() => '');
  return { manifest, markdown, path: projectSkillDir, layer: 'project' };
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

  let config: ProjectConfig | null = null;
  try {
    config = await loadConfig(projectRoot);
  } catch {
    // Config not present or invalid
  }
  const binding: SkillBinding | undefined = config?.skills?.[name];

  if (skill.layer === 'global') {
    await assertBindingNotSelfApproved(projectRoot, name);
    if (!binding) {
      const bound = resolveBinding(skill.manifest, undefined);
      if ('missing' in bound && bound.missing.length > 0) {
        throw new Error(
          `Skill "${name}" is a global skill and has not been bound in this project. Missing required input${bound.missing.length > 1 ? 's' : ''}: ${bound.missing.join(', ')}. Add "skills.${name}" to .knowl/config.json.`,
        );
      }
      throw new Error(
        `Skill "${name}" is a global skill and is not bound in this project. Bind it in .knowl/config.json under "skills.${name}" before running.`,
      );
    }
  }

  if (binding) {
    assertPinned(skill.manifest, binding);
  }

  const bindingResult = resolveBinding(skill.manifest, binding);
  if ('missing' in bindingResult) {
    throw new Error(
      `Skill "${name}" is missing required input${bindingResult.missing.length > 1 ? 's' : ''}: ${bindingResult.missing.join(', ')}. Bind in project config under "skills.${name}.inputs".`,
    );
  }
  const inputValues = 'values' in bindingResult ? bindingResult.values : {};

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
    const trustRoot = skill.layer === 'global' ? globalSkillsRoot() : projectRoot;
    await assertSkillApproved(trustRoot, name, nameToRun);
    const trustRecord = await readTrust(trustRoot, name);
    const approvedAt = trustRecord?.approvedAt ? trustRecord.approvedAt.slice(0, 10) : undefined;

    // Check preconditions fail-closed
    const rawPreconditions = skill.manifest.requires?.preconditions ?? [];
    const interpolatedPreconditions = interpolate(rawPreconditions, inputValues);
    const precondResult = await checkPreconditions(interpolatedPreconditions, { cwd: projectRoot });
    if (!precondResult.ok) {
      throw new Error(
        `Precondition failed for skill "${name}": ${precondResult.failed} (${precondResult.reason})`,
      );
    }

    const env = skillEnvironment(projectRoot, skill);

    let child: ReturnType<typeof spawnSync>;
    let commandText: string;

    if (entrypoint.type === 'shell') {
      commandText = interpolate([entrypoint.command], inputValues)[0];
      const banner = formatRunBanner({
        name: skill.manifest.name,
        layer: skill.layer,
        version: skill.manifest.version,
        approvedAt,
        command: commandText,
        cwd: projectRoot,
        capabilities: skill.manifest.requires?.capabilities,
        preconditions: interpolatedPreconditions,
      });
      console.log(banner);
      child = runShell(projectRoot, commandText, env);
    } else {
      const scriptPath = resolveSkillFile(skill.path, entrypoint.path);
      const combinedArgs = [...(entrypoint.args || []), ...args];
      const interpolatedArgs = interpolate(combinedArgs, inputValues);
      const cmd = scriptCommand(scriptPath, interpolatedArgs);
      commandText = [cmd.command, ...cmd.args].join(' ');
      const banner = formatRunBanner({
        name: skill.manifest.name,
        layer: skill.layer,
        version: skill.manifest.version,
        approvedAt,
        command: commandText,
        cwd: projectRoot,
        capabilities: skill.manifest.requires?.capabilities,
        preconditions: interpolatedPreconditions,
      });
      console.log(banner);
      child = spawnSync(cmd.command, cmd.args, spawnLimits(projectRoot, env));
    }

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
