import { resolveMultiModelSdk, type AiProviderDescriptor } from './types.js';

// Any OpenAI/Anthropic-compatible endpoint; the long-tail escape.
export const customProvider: AiProviderDescriptor = {
  id: 'custom',
  sdk: 'openai',
  resolveSdk: resolveMultiModelSdk,
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || '',
    baseURL: baseUrl,
  }),
};
