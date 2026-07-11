import { DEFAULT_CONFIG } from '../../core/config.js';

export type ConfigKey =
  | 'security.rejectSecrets'
  | 'security.secretPatterns'
  | 'search.vector.enabled'
  | 'search.vector.provider'
  | 'search.vector.model'
  | 'search.vector.dtype'
  | 'search.vector.cacheDir'
  | 'ai.provider'
  | 'ai.model'
  | 'ai.temperature'
  | 'ai.baseUrl'
  | 'ai.apiKey';

export type ConfigCategory = 'Search' | 'Security' | 'AI provider';

export interface ConfigField {
  key: ConfigKey;
  category: ConfigCategory;
  secret?: boolean;
  parse(raw: string): unknown;
  defaultValue?: unknown;
}

const booleanValue = (raw: string) => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('Expected true or false');
};

const enumValue = <T extends string>(values: readonly T[]) => (raw: string): T => {
  if (values.includes(raw as T)) return raw as T;
  throw new Error(`Expected one of: ${values.join(', ')}`);
};

const optionalNumber = (raw: string) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('Expected a number');
  return value;
};

const stringList = (raw: string) => raw.split(',').map(value => value.trim()).filter(Boolean);

export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'search.vector.enabled', category: 'Search', parse: booleanValue, defaultValue: DEFAULT_CONFIG.search?.vector?.enabled },
  { key: 'search.vector.provider', category: 'Search', parse: enumValue(['local'] as const), defaultValue: DEFAULT_CONFIG.search?.vector?.provider },
  { key: 'search.vector.model', category: 'Search', parse: String, defaultValue: DEFAULT_CONFIG.search?.vector?.model },
  { key: 'search.vector.dtype', category: 'Search', parse: enumValue(['q4', 'q8', 'fp16', 'fp32'] as const), defaultValue: DEFAULT_CONFIG.search?.vector?.dtype },
  { key: 'search.vector.cacheDir', category: 'Search', parse: String },
  { key: 'security.rejectSecrets', category: 'Security', parse: booleanValue, defaultValue: DEFAULT_CONFIG.security.rejectSecrets },
  { key: 'security.secretPatterns', category: 'Security', parse: stringList, defaultValue: DEFAULT_CONFIG.security.secretPatterns },
  { key: 'ai.provider', category: 'AI provider', parse: enumValue(['openai', 'anthropic', 'ollama', 'custom'] as const) },
  { key: 'ai.model', category: 'AI provider', parse: String },
  { key: 'ai.temperature', category: 'AI provider', parse: optionalNumber },
  { key: 'ai.baseUrl', category: 'AI provider', parse: String },
  { key: 'ai.apiKey', category: 'AI provider', parse: String, secret: true },
];

export function getConfigField(key: string): ConfigField {
  const field = CONFIG_FIELDS.find(candidate => candidate.key === key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  return field;
}
