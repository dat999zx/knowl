import type { HookHost, NormalizedHookEventName } from '../host-hook.js';

export const MAX_HOST_STRING = 2_000;

export type HostOutput = Record<string, unknown>;

export type HostIdentity = {
  externalSessionId?: string;
  externalTurnId?: string;
  agentId?: string;
  agentType?: string;
};

/**
 * Everything that differs between hosts. Core code asks a profile instead of
 * branching on the host name.
 *
 * Capability is expressed by return value: a host that cannot receive context
 * returns undefined, so no flag can claim support the envelope does not deliver.
 */
export interface HostProfile {
  readonly host: HookHost;
  /** Host-native lifecycle events `knowl init` registers. Empty means MCP-only. */
  readonly hookEvents: readonly string[];
  /** Host event carrying the prompt-time guidance card, if the host has one. */
  readonly promptEvent?: string;
  /** True when one session binding spans turns, so turn-stop closes only the turn. */
  readonly sharesSessionBinding: boolean;
  /** True when the CLI emits host-shaped JSON instead of the host-neutral result. */
  readonly nativeOutput: boolean;
  /**
   * True only when a mid-turn envelope is known to reach the model.
   *
   * Distinct from `midTurnContext` returning something, and the distinction is not
   * pedantic: Cursor accepts and logs `additional_context` but open upstream reports say
   * it never reaches the model. Anything deciding "is this host already telling the agent"
   * has to ask this, not whether an envelope exists -- inferring it from the envelope
   * silences the fallback channel for precisely the host that depends on it.
   */
  readonly midTurnDeliveryVerified: boolean;
  identity(raw: Record<string, unknown>): HostIdentity;
  normalizedEvent(hostEvent: string): NormalizedHookEventName | undefined;
  isShellEvent(hostEvent: string, toolName: string): boolean;
  startContext(event: NormalizedHookEventName, context: string): HostOutput | undefined;
  midTurnContext(text: string): HostOutput | undefined;
}

export const hostString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_HOST_STRING) : undefined;

/** Shared by hosts whose tool events name the tool rather than the channel. */
export const toolNameIsShell = (toolName: string): boolean =>
  toolName.toLocaleLowerCase() === 'bash' || toolName.toLocaleLowerCase() === 'shell';

export const agentIdentityFrom = (raw: Record<string, unknown>): Pick<HostIdentity, 'agentId' | 'agentType'> => ({
  agentId: hostString(raw.agent_id) ?? hostString(raw.agentId),
  agentType: hostString(raw.agent_type) ?? hostString(raw.agentType),
});
