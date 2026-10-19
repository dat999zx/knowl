import type { AiProviderDescriptor } from './types.js';

export const ollamaProvider: AiProviderDescriptor = {
  id: 'ollama',
  sdk: 'openai',
  keyless: true,
  // Ollama's local API has a standard OpenAI compatibility endpoint
  settings: ({ baseUrl }) => ({
    apiKey: 'ollama',
    baseURL: baseUrl || 'http://localhost:11434/v1',
  }),
};
