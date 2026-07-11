import { validateKnowledgeWrite } from '../../core/knowledge-validation.js';
import { SessionEventType } from '../../core/types.js';
import { LifecycleCapability, LifecycleEvent } from './types.js';

const capabilities: LifecycleCapability[] = ['supported', 'unsupported', 'degraded'];
const events: LifecycleEvent[] = ['session-start', 'session-event', 'session-stop', 'session-recover'];
const sessionEventTypes: SessionEventType[] = ['start', 'command', 'test', 'error', 'git', 'decision', 'checkpoint', 'stop'];

export function isLifecycleCapability(value: string): value is LifecycleCapability {
  return capabilities.includes(value as LifecycleCapability);
}

export function isLifecycleEvent(value: string): value is LifecycleEvent {
  return events.includes(value as LifecycleEvent);
}

export function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && sessionEventTypes.includes(value as SessionEventType);
}

export function parseLifecyclePayload(raw: string): Record<string, unknown> {
  if (raw.length > 4_000) throw new Error('Agent lifecycle payload exceeds the allowed length.');
  if (!raw.trim()) return {};
  validateKnowledgeWrite({ content: raw });
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Agent lifecycle payload must be a JSON object.');
  return value as Record<string, unknown>;
}

export async function readLifecyclePayload(stdin = process.stdin): Promise<Record<string, unknown>> {
  if (stdin.isTTY) return {};
  let raw = '';
  for await (const chunk of stdin) {
    raw += String(chunk);
    if (raw.length > 4_000) throw new Error('Agent lifecycle payload exceeds the allowed length.');
  }
  return parseLifecyclePayload(raw);
}

export function stringPayloadValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}
