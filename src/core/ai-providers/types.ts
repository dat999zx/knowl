export interface AiProviderSettingsInput { apiKey?: string; baseUrl?: string }

export interface AiProviderDescriptor {
  /** The `ai.provider` value. Matches the file name. */
  id: string;
  /** Which installed SDK builds the model. Only the two in package.json. */
  sdk: 'openai' | 'anthropic';
  /** Runs without an API key in config (`hasAiConfigured`). */
  keyless?: boolean;
  /** Settings handed to the SDK factory. Pure; may read process.env. */
  settings(input: AiProviderSettingsInput): { apiKey?: string; baseURL?: string };
}
