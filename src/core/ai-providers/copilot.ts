import { resolveMultiModelSdk, type AiProviderDescriptor } from './types.js';

/** Default local GitHub Copilot / Headroom multi-model proxy endpoint. */
export const DEFAULT_COPILOT_BASE_URL = 'http://127.0.0.1:8794/v1';
export const DEFAULT_COPILOT_API_KEY = 'copilot-local-proxy';

export const copilotProvider: AiProviderDescriptor = {
  id: 'copilot',
  sdk: 'openai',
  resolveSdk: resolveMultiModelSdk,
  keyless: true,
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || process.env.COPILOT_API_KEY || DEFAULT_COPILOT_API_KEY,
    baseURL: baseUrl || process.env.COPILOT_BASE_URL || DEFAULT_COPILOT_BASE_URL,
  }),
};
