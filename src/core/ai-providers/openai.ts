import type { AiProviderDescriptor } from './types.js';

export const openaiProvider: AiProviderDescriptor = {
  id: 'openai',
  sdk: 'openai',
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || process.env.OPENAI_API_KEY,
    baseURL: baseUrl || undefined,
  }),
};
