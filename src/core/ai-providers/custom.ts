import type { AiProviderDescriptor } from './types.js';

// Any OpenAI-compatible endpoint; the long-tail escape.
export const customProvider: AiProviderDescriptor = {
  id: 'custom',
  sdk: 'openai',
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || '',
    baseURL: baseUrl,
  }),
};
