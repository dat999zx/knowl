import path from 'node:path';

/**
 * A "shared surface": something one session can change that every other live session is
 * standing on. The list is a hand-written heuristic, in the tradition of Canopy's
 * `SharedSurface` enum, and it is honest about that: it names the places where a textual
 * change has fleet-wide effect *by construction* -- the engine every hook runs, the hook
 * registrations themselves, the settings the host reads, the schema every process opens --
 * rather than trying to infer blast radius from content. The inference half lives in the
 * read-set overlap check beside this; this half fires even when no peer has read the file,
 * because a hook config is read by processes, not by agents.
 */
export type SurfaceKind =
  | 'knowl-engine'
  | 'host-settings'
  | 'host-hooks'
  | 'knowl-config'
  | 'migrations'
  | 'manifest'
  | 'env'
  | 'generated'
  /** Not on the hand list: another live session read this exact file and still holds a current copy. */
  | 'live-read';

export interface SurfaceHit {
  kind: SurfaceKind;
  /** What the agent is about to touch, as a human reads it. */
  target: string;
  /** Why every live session cares, in one sentence. */
  reason: string;
  /** True when the effect reaches every session on the machine, not only those in this repo. */
  machineWide: boolean;
}

const MANIFEST_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'pyproject.toml', 'poetry.lock',
  'requirements.txt', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
]);

const MIGRATION_DIRS = new Set(['migrations', 'migrate', 'migration']);

/**
 * The directories each agent host keeps its hooks, MCP list and settings in.
 *
 * Every path `hookHostSpecs` and the project adapters write, plus the two user-level ones.
 * Listing only `.claude` was the same mistake the rest of this feature made: the file a Codex
 * or Windsurf session's hooks are loaded from is exactly as shared as Claude Code's, and one
 * agent rewriting it while four others run is the change this card exists to announce.
 *
 * `.github` earns its place through Copilot (`.github/hooks/knowl.json`, `.github/mcp.json`)
 * and costs nothing else: the check below still requires a hooks path or a settings-shaped
 * file name, so a workflow or an issue template does not match.
 */
const HOST_CONFIG_DIRS = new Set([
  '.claude', '.codex', '.cursor', '.windsurf', '.openhands', '.agents', '.github', '.gemini', '.codeium',
]);

/**
 * Commands that replace the Knowl engine under every running hook and serve process.
 *
 * The specific incident this guards is recorded in the store: an `npm install -g` while
 * seventeen `knowl serve` processes held the SQLite binary mapped left a half-installed tree,
 * `EBUSY` on the repair, and every open tab reporting the MCP server red. That is the most
 * expensive thing one session can do to the others, and it looks like a routine upgrade.
 */
const ENGINE_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|up|upgrade|update|link|rm|remove|uninstall)\b[^\n|;&]*(-g|--global|\bglobal\b)[^\n|;&]*\bknowl\b|\bknowl(-sync|\.cmd)?\s+(upgrade|self-update)\b|\bknowl-sync\b/i;

export function classifySharedSurfacePath(filePath: string, projectRoot?: string): SurfaceHit | undefined {
  const normalised = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalised).toLowerCase();
  const segments = normalised.toLowerCase().split('/').filter(Boolean);
  const display = projectRoot ? relativeDisplay(filePath, projectRoot) : filePath;

  if (segments.includes('.knowl') && base === 'config.json') {
    return { kind: 'knowl-config', target: display, reason: 'every hook and serve in this repo reads it on the next event', machineWide: false };
  }
  const hostIndex = segments.findIndex(segment => HOST_CONFIG_DIRS.has(segment) || /^\.claude-[\w-]+$/.test(segment));
  if (hostIndex >= 0) {
    const rest = segments.slice(hostIndex + 1);
    if (rest[0] === 'hooks' || /^hooks(\.[\w-]+)?\.json$/.test(base)) {
      return { kind: 'host-hooks', target: display, reason: 'hook scripts run inside every live session on the next matching event', machineWide: isHomeLevel(segments, hostIndex) };
    }
    if (/^(settings|config|mcp|mcp_config)(\.[\w-]+)?\.(json|toml)$/.test(base)) {
      return { kind: 'host-settings', target: display, reason: 'the host re-reads its settings live; hook, MCP and permission changes reach every session using this file', machineWide: isHomeLevel(segments, hostIndex) };
    }
  }
  if (segments.some(segment => MIGRATION_DIRS.has(segment)) && /\.(sql|ts|js|mjs|cjs|py|rb)$/.test(base)) {
    return { kind: 'migrations', target: display, reason: 'a schema change lands under every session sharing this database', machineWide: false };
  }
  if (MANIFEST_NAMES.has(base)) {
    return { kind: 'manifest', target: display, reason: 'dependency and script changes affect every session building or testing this repo', machineWide: false };
  }
  if (/^\.env(\.[\w-]+)?$/.test(base)) {
    return { kind: 'env', target: display, reason: 'every process in this repo reads it at start', machineWide: false };
  }
  if (/\.generated\.|\.gen\.|^schema\.d\.ts$/.test(base) || segments.includes('generated')) {
    return { kind: 'generated', target: display, reason: 'generated output is usually rebuilt by more than one session', machineWide: false };
  }
  return undefined;
}

export function classifySharedSurfaceCommand(command: string): SurfaceHit | undefined {
  if (ENGINE_COMMAND.test(command)) {
    return {
      kind: 'knowl-engine',
      target: command.trim().split(/\r?\n/)[0].slice(0, 120),
      reason: 'replaces the Knowl engine under every live session\'s hooks and serve processes; installing while serves run has half-installed and hit EBUSY before',
      machineWide: true,
    };
  }
  return undefined;
}

/** A host config directory directly under a home directory is the user-level one every session reads. */
function isHomeLevel(segments: string[], hostIndex: number): boolean {
  const before = segments.slice(0, hostIndex);
  return before.length <= 3 && (before.includes('users') || before.includes('home') || before.length <= 1);
}

function relativeDisplay(filePath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return filePath;
  return relative.replace(/\\/g, '/');
}
