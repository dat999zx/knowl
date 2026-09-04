import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';

const ANTIGRAVITY_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  PreToolUse: 'tool-precheck',
  PostToolUse: 'session-event',
  // Antigravity has no session-start and no prompt-submit event. `PreInvocation` fires before
  // every model invocation, which is the same slot a prompt event occupies: it is where the
  // turn's context has to arrive if it is going to arrive at all.
  PreInvocation: 'turn-start',
  PostInvocation: 'session-event',
  Stop: 'turn-stop',
};

export const ANTIGRAVITY_HOOK_EVENTS = [
  'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop',
] as const;

/**
 * The two events whose handlers wrap in `{matcher, hooks}`; the other three take a bare handler.
 *
 * Antigravity's reference is explicit that only the tool events have a matcher target and that
 * `PreInvocation`, `PostInvocation` and `Stop` are "Flat (list of handler objects directly)".
 * Writing the grouped shape there produces a file it parses and ignores, which is how the
 * integration shipped with three of its five events -- including the only one that starts a
 * session -- registered and dead.
 */
export const ANTIGRAVITY_GROUPED_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/**
 * The write tools, read off a real install's trajectory rather than guessed.
 *
 * The previous list was `write_file`, `edit_file`, `WriteFile`, `EditFile` and
 * `replace_file_content` -- four names Antigravity has never emitted and one it has. Its
 * reference says tool names are the step type lowercased with `CORTEX_STEP_TYPE_` stripped, so
 * the PascalCase half could not have been right; the two real names it was missing account for
 * more than a third of the writes in the transcripts these were read from.
 */
const ANTIGRAVITY_WRITE_TOOLS = ['replace_file_content', 'multi_replace_file_content', 'write_to_file'] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Antigravity's context channel: steps spliced into the conversation trajectory.
 *
 * `ephemeralMessage` is the transient variant -- the other two are `userMessage`, which would
 * put words in the person's mouth, and `toolCall`, which would have Knowl execute something on
 * the agent's behalf. Neither is what a memory card is.
 *
 * Only `PreInvocation` and `PostInvocation` read this field. It is still returned for the
 * post-tool card, where Antigravity ignores it -- an unknown key costs nothing, and
 * `midTurnDeliveryVerified` stays false so the MCP channel keeps talking either way.
 */
const injectEphemeral = (text: string) => ({ injectSteps: [{ ephemeralMessage: text }] });

/**
 * Google Antigravity 2.0 -- PascalCase events like Claude's, and nothing else like Claude's.
 *
 * Three differences, each of which silently produces a working-looking integration that does
 * nothing:
 *
 * 1. **The file is one level deeper.** `{"<hook-name>": {"PreToolUse": [{matcher, hooks}]}}`,
 *    not `{"hooks": {...}}`. Writing Claude's shape yields a file Antigravity parses and
 *    ignores. See `mergeAntigravityHookConfig`, which owns only the `"knowl"` key.
 * 2. **The verdict is `decision`, not `permissionDecision`.** Reusing `anthropicDenyToolCall`
 *    here would emit a field Antigravity does not read, so the refusal is computed, reported,
 *    and never applied.
 * 3. **Stop continues rather than blocks**, and its reason is documented as injected as a
 *    system message into the conversation -- which is the one thing a stop channel has to do
 *    for the capture nudge to be worth spending, so `stopContext` is declared.
 *
 * **There is no prompt-submit event and no session-start event**, which read at first as "no
 * context channel". Antigravity has one, shaped unlike anyone else's: `injectSteps` on the
 * invocation events splices steps into the conversation trajectory, and `PreInvocation` fires
 * before every model invocation -- the same slot a prompt event occupies. So bootstrap and the
 * per-turn card both ride `PreInvocation` here, rather than the host having neither.
 *
 * `midTurnDeliveryVerified` stays false regardless: nobody has watched one arrive, and the MCP
 * channel keeps talking until someone does.
 *
 * **Replaces the Gemini CLI adapter**, which was instructions-only and whose host was
 * discontinued. Its config still lives under `~/.gemini/config/` at global scope, which is the
 * only trace of that lineage that matters here.
 */
export const antigravityProfile: HostProfile = {
  host: 'antigravity',
  hookEvents: ANTIGRAVITY_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: true,
  lifecycleClaimable: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'antigravity-nested',
  // Observed, not guessed: `view_file` is the only read tool that names a single file, and the
  // three writes are the whole write vocabulary. `grep_search` and `list_dir` read too, but not
  // a file the read-set could record.
  readsFiles: (_event, tool) => tool === 'view_file',
  // The list, not a predicate: `toolWritesFile` and the pre-tool matcher then read the same
  // three names, so the gate can never want to refuse a tool the host was told not to announce.
  writeTools: ANTIGRAVITY_WRITE_TOOLS,
  /**
   * protojson, so every key is camelCase and the tool arrives as one object.
   *
   * `conversationId` is the session -- the previous three fallbacks (`session_id`,
   * `conversation_id`, `thread_id`) were snake_case and Antigravity sends none of them, so
   * every event failed the session-id check. The tool split is `toolCall: {name, args}` where
   * the rest of the pipeline reads `tool_name`/`tool_input`, and the arguments are PascalCase:
   * `TargetFile` on all three writes, `AbsolutePath` on the read, `CommandLine` on the shell.
   * `workspacePaths` is the root, and missing it is what threw on every event.
   */
  normalizePayload(raw) {
    const call = record(raw.toolCall);
    const args = record(call?.args) ?? {};
    const roots = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
    return {
      ...raw,
      ...(roots.length > 0 ? { workspace_roots: roots } : {}),
      ...(call?.name !== undefined ? { tool_name: call.name } : {}),
      // `Query` is `grep_search`'s pattern, and it is here for the same reason the shared
      // discriminator list exists: without it two searches inside the debounce window
      // normalise to one event and the second is dropped with its change card.
      ...(call ? { tool_input: { file_path: args.TargetFile ?? args.AbsolutePath, command: args.CommandLine, query: args.Query } } : {}),
    };
  },
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversationId) ?? hostString(raw.conversation_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return ANTIGRAVITY_EVENT_MAP[hostEvent];
  },
  // `run_command`, not `bash`/`shell`. The shared helper knows the two Anthropic-shaped names
  // and neither is Antigravity's, so every command it ran normalised to a nameless checkpoint:
  // no command text, no exit code, and nothing for the fleet to fingerprint a shared failure on.
  isShellEvent(_hostEvent, toolName) {
    return toolName === 'run_command' || toolNameIsShell(toolName);
  },
  startContext(_event, context) {
    return injectEphemeral(context);
  },
  midTurnContext(text) {
    return injectEphemeral(text);
  },
  denyToolCall(reason) {
    return { decision: 'deny', reason };
  },
  stopContext(reason) {
    return { decision: 'continue', reason };
  },
};
