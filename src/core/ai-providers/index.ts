import type { AiProviderDescriptor } from './types.js';
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';
import { ollamaProvider } from './ollama.js';
import { customProvider } from './custom.js';

/**
 * Adding a provider: one file here plus one entry in `ALL`. The guard in
 * `tests/ai/provider-registry.test.ts` fails if the entry is missing.
 *
 * Descriptors are pure data and import no SDK, so `core` (`hasAiConfigured`) can read them
 * without loading the AI SDK tree.
 */
const ALL: AiProviderDescriptor[] = [openaiProvider, anthropicProvider, ollamaProvider, customProvider];

export const AI_PROVIDERS: Record<string, AiProviderDescriptor> = Object.fromEntries(ALL.map(p => [p.id, p]));
export const AI_PROVIDER_IDS = ALL.map(p => p.id);

export function aiProvider(id: string): AiProviderDescriptor {
  const found = Object.prototype.hasOwnProperty.call(AI_PROVIDERS, id) ? AI_PROVIDERS[id] : undefined;
  if (!found) throw new Error(`Unknown AI provider "${id}". Registered providers: ${AI_PROVIDER_IDS.join(', ')}.`);
  return found;
}
