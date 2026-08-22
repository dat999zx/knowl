import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString } from './profile.js';

const CURSOR_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'turn-start',
  preToolUse: 'tool-precheck',
  afterShellExecution: 'session-event',
  postToolUse: 'session-event',
  postToolUseFailure: 'session-event',
  afterFileEdit: 'session-event',
  preCompact: 'checkpoint',
  stop: 'turn-stop',
  sessionEnd: 'session-stop',
};

/**
 * `beforeReadFile` is mapped nowhere on purpose.
 *
 * It would be the obvious place to record reads, and it is the wrong one twice over: it is a
 * *pre* hook on the hottest path in a session, so it spawns a hook process before every file
 * the agent opens, and its payload carries the file's entire `content`. `postToolUse` already
 * fires for the same reads, after the fact, with only the path.
 */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'preToolUse', 'afterShellExecution', 'postToolUse', 'postToolUseFailure',
  'afterFileEdit', 'preCompact', 'stop', 'sessionEnd',
] as const;

export const cursorProfile: HostProfile = {
  host: 'cursor',
  hookEvents: CURSOR_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: true,
  // Emitted below but not surfaced to the model upstream, so nothing may treat Cursor as
  // already-notified. Flip to true once an upstream release is confirmed to show it.
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'flat-commands',
  hookFileExtraKeys: { version: 1 },
  hookEntryTimeout: 30,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id),
      externalTurnId: hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return CURSOR_EVENT_MAP[hostEvent];
  },
  // Two ways in, because Cursor says it two ways. `afterFileEdit` names the action and carries
  // a path with no tool name; `preToolUse` and `postToolUse` name the tool. Cursor's own names
  // are `Write`, `Edit` and `Read` -- the same words Claude uses, which is why this host looked
  // like it worked under the old shared fallback for tool events and silently did not for
  // `afterFileEdit`.
  writesFiles(hostEvent, toolName) {
    return hostEvent === 'afterFileEdit'
      || ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName);
  },
  readsFiles(_hostEvent, toolName) {
    return ['Read', 'NotebookRead'].includes(toolName);
  },
  isShellEvent(hostEvent) {
    return hostEvent === 'afterShellExecution';
  },
  startContext(_event, context) {
    return { additional_context: context, sessionStart: true };
  },
  // Cursor documents additional_context on postToolUse, and its hooks accept and log
  // it, but open upstream reports say it is not surfaced to the model. Emitting costs
  // nothing and starts working when that is fixed.
  midTurnContext(text) {
    return { additional_context: text };
  },
  // **Cursor's own verdict shape, and it is nobody else's.** `permission`, not
  // `permissionDecision`, and the reason is split in two: `user_message` is shown in the client
  // and `agent_message` is what reaches the model. Both get the whole reason -- the person
  // seeing a blocked edit needs to know why as much as the agent does.
  //
  // This host was written off as ungatable because it has no `beforeFileEdit`. It does not need
  // one: `preToolUse` fires before *every* tool with `tool_name` and `tool_input`, which is the
  // same shape Claude's gate already reads.
  denyToolCall(reason) {
    return { permission: 'deny', user_message: reason, agent_message: reason };
  },
  // Cursor's stop cannot withhold the stop -- it is documented fire-and-forget. What it can do
  // is hand back `followup_message`, which Cursor submits as the user's next message. That
  // reaches the model, which is the only thing the capture nudge actually requires, and it is
  // arguably the better shape: the agent is asked rather than blocked.
  stopContext(reason) {
    return { followup_message: reason };
  },
};
