export interface AiProviderSettingsInput { apiKey?: string; baseUrl?: string }

export interface AiProviderDescriptor {
  /** The `ai.provider` value. Matches the file name. */
  id: string;
  /** Which installed SDK builds the model. Only the two in package.json. */
  sdk: 'openai' | 'anthropic';
  /** Optional per-model SDK selector for multi-model gateways (e.g. GitHub Copilot, custom). */
  resolveSdk?(model: string): 'openai' | 'anthropic';
  /** Runs without an API key in config (`hasAiConfigured`). */
  keyless?: boolean;
  /** Settings handed to the SDK factory. Pure; may read process.env. */
  settings(input: AiProviderSettingsInput): { apiKey?: string; baseURL?: string };
}

/**
 * Select the Anthropic Messages SDK when a gateway model ID targets Claude (`claude*`,
 * `anthropic/claude*`, or `anthropic.claude*`), and the OpenAI SDK otherwise.
 */
export function resolveMultiModelSdk(model: string): 'openai' | 'anthropic' {
  const lower = model.trim().toLowerCase();
  return /^(?:anthropic[/.])?claude(?:[-_.]|$)/.test(lower) ? 'anthropic' : 'openai';
}
