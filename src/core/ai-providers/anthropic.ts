import type { AiProviderDescriptor } from './types.js';

export const anthropicProvider: AiProviderDescriptor = {
  id: 'anthropic',
  sdk: 'anthropic',
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    baseURL: baseUrl || undefined,
  }),
};
