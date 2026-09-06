import type { HookHost, NormalizedHostHook } from '../../core/host-hook-types.js';
import type { HostProfile } from './profile.js';
import {
  KNOWL_CLAUDE_MODE_LINE, KNOWL_HOST_NEUTRAL_MODE_LINE, KNOWL_MANUAL_MODE_LINE,
} from '../../core/knowl-guidance.js';
import { claudeProfile } from './claude.js';
import { codexProfile } from './codex.js';
import { cursorProfile } from './cursor.js';
import { claudeDesktopProfile } from './claude-desktop.js';
import { genericProfile } from './generic.js';
import { copilotProfile } from './copilot.js';
import { openhandsProfile } from './openhands.js';
import { antigravityProfile } from './antigravity.js';
import { windsurfProfile } from './windsurf.js';
import { clineProfile } from './cline.js';
import { hermesProfile } from './hermes.js';
import { openclawProfile } from './openclaw.js';

export type { HostIdentity, HostOutput, HostProfile } from './profile.js';

export const HOST_PROFILES: Record<HookHost, HostProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
  cursor: cursorProfile,
  'claude-desktop': claudeDesktopProfile,
  generic: genericProfile,
  copilot: copilotProfile,
  openhands: openhandsProfile,
  antigravity: antigravityProfile,
  windsurf: windsurfProfile,
  cline: clineProfile,
  hermes: hermesProfile,
  openclaw: openclawProfile,
};

export function hostProfile(host: HookHost): HostProfile {
  const profile = HOST_PROFILES[host];
  if (!profile) throw new Error(`Unsupported hook host: ${host}`);
  return profile;
}

export function isHookHost(value: string): value is HookHost {
  return Object.prototype.hasOwnProperty.call(HOST_PROFILES, value);
}

/**
 * The lifecycle sentence the MCP `initialize` card should carry for this host.
 *
 * Without a host the card sends the neutral line -- *"verified hooks, when active, own lifecycle
 * ... otherwise use the manual fallback"* -- which hands the agent a conditional and leaves it to
 * work out which branch applies. The install already answered that: `knowl init` writes the
 * host's own MCP config and puts the name on the command line, so a Claude session can be told
 * its hooks own the lifecycle full stop, and Claude Desktop can be told it owns the loop full
 * stop. This is also what finally sends `KNOWL_CLAUDE_OPERATIONAL_CARD`, which has been built
 * and pinned by tests since PR #12 and never delivered.
 *
 * A plain string, because it arrives from a command line: an unrecognised host falls back to
 * neutral rather than throwing, since a hand-edited MCP config must not stop the server booting.
 */
export function mcpModeLineForHost(host?: string): string {
  if (!host) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  // Agents Knowl configures over MCP but never sends hook payloads from. They are not
  // `HookHost`s, so they have no profile to ask -- and they are precisely the hosts the manual
  // line exists for, so falling through to the conditional would leave the archetypal case
  // still inferring an answer this knows.
  if (MCP_ONLY_AGENTS.has(host)) return KNOWL_MANUAL_MODE_LINE;
  if (!isHookHost(host)) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  const profile = hostProfile(host);
  // Registered is not running: see `lifecycleClaimable`. Asked *before* the empty-events check,
  // because Cline is both -- it registers no file and still has a lifecycle, through a plugin
  // the person opts into. Telling it "you own the manual loop" would be as wrong as telling it
  // its hooks own the session.
  if (profile.lifecycleClaimable === false) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  if (profile.hookEvents.length === 0) return KNOWL_MANUAL_MODE_LINE;
  return KNOWL_CLAUDE_MODE_LINE.replace('Claude hooks', `${HOST_DISPLAY_NAMES[host] ?? host} hooks`);
}

/** Agent names Knowl configures over MCP that are not hook hosts. */
const MCP_ONLY_AGENTS = new Set(['opencode']);

/** Hosts whose key does not read as their own name in a sentence. */
const HOST_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  openhands: 'OpenHands',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
  generic: 'Your host’s',
  cline: 'Cline',
  hermes: 'Hermes',
};

/**
 * The tools whose paths become a read-set entry -- and the two that look like they belong here
 * and deliberately do not.
 *
 * A read-set row asserts "this session saw this text and holds a belief about it", and the
 * certain tier spends that assertion by interrupting the agent and, once the gate is enforcing,
 * refusing its write. So the
 * set is the tools that return *contents*: `Read`, and `NotebookRead`, whose target the host names
 * `notebook_path` rather than `file_path` -- which is why that key had to be added to `changedPaths`
 * and to the stdin allowlist in the same change, or this entry would have named a tool whose paths
 * never arrive.
 *
 * `Grep` and `Glob` are read-ish and are excluded. Their `path` argument is usually a directory,
 * which `normalizeLocator` already refuses -- but the case that decides this is the one where it
 * is a file. `Grep` returns matching lines and `Glob` returns names; recording either as a read
 * of that file would write one row per symbol in it, claiming the agent saw signatures it never
 * received. The next edit to any of those symbols then fires against a belief the session does
 * not hold: a fabricated false positive, pushed into tool-side context, which AgentNoiseBench
 * measures at ~20.8% mean accuracy cost to the agent receiving it. The trade is the one
 * `normalizeLocator`'s own directory heuristic already makes in this subsystem -- recall on a
 * tier allowed to be incomplete, never precision on the one tier allowed to interrupt.
 *
 * Matched verbatim and case-sensitively against the host's own name (`host-hook.ts:42` keeps it
 * raw for exactly this judgement). A host whose tool vocabulary has not been read is silent here
 * rather than guessed at, for the same asymmetry.
 */
const DEFAULT_READ_TOOLS = new Set(['Read', 'NotebookRead']);

/** The write tools whose paths trigger a re-index and certain-tier detection. */
const DEFAULT_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether this event read or wrote a file, in the vocabulary of the host that sent it.
 *
 * The two sets above are Claude Code's names, and they were consulted for every host. On any
 * other one they matched nothing: reads were never recorded, so the detector had no beliefs to
 * invalidate, and writes were never recognised, so `runWriteGate` returned "no opinion" before
 * it ever asked the profile whether it could refuse. A host could therefore declare a working
 * deny channel and be structurally unable to reach it.
 *
 * A declared predicate **replaces** the fallback rather than layering over it, so a host that
 * declares one is saying "these and nothing else". The fallback remains Claude Code's names,
 * which is what `claude`, `generic` and `claude-desktop` still use; every other host now
 * declares its own, including `codex`, whose tool is `apply_patch`.
 *
 * They live here rather than beside their first caller because there are now two -- the impact
 * subsystem and the fleet -- and a second copy of this rule is a second answer to "did this
 * event write a file", which is the question the write gate and the fleet's claim both turn on.
 */
export function toolReadsFile(input: Pick<NormalizedHostHook, 'host' | 'hostEvent' | 'toolName'>): boolean {
  const { readsFiles } = hostProfile(input.host);
  const toolName = input.toolName ?? '';
  return readsFiles
    ? readsFiles(input.hostEvent ?? '', toolName)
    : DEFAULT_READ_TOOLS.has(toolName);
}

export function toolWritesFile(input: Pick<NormalizedHostHook, 'host' | 'hostEvent' | 'toolName'>): boolean {
  const { writesFiles, writeTools } = hostProfile(input.host);
  const toolName = input.toolName ?? '';
  if (writesFiles) return writesFiles(input.hostEvent ?? '', toolName);
  // Preferred over the fallback set when a host declares it, so the gate and the pre-tool
  // matcher built from the same list can never disagree about what a write is.
  if (writeTools) return writeTools.includes(toolName);
  return DEFAULT_WRITE_TOOLS.has(toolName);
}
