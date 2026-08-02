import { DEFAULT_CONFIG } from '../../core/config.js';
import { DEFAULT_PRESET_ID, PRESET_IDS } from '../../core/vector-profile.js';

export type ConfigKey =
  | 'security.rejectSecrets'
  | 'security.secretPatterns'
  | 'search.vector.enabled'
  | 'search.vector.preset'
  | 'search.vector.provider'
  | 'search.vector.model'
  | 'search.vector.dtype'
  | 'search.vector.pooling'
  | 'search.vector.cacheDir'
  | 'ai.provider'
  | 'ai.model'
  | 'ai.temperature'
  | 'ai.baseUrl'
  | 'ai.apiKey'
  | 'memory.organization.enabled'
  | 'memory.organization.path'
  | 'memory.global.enabled'
  | 'memory.global.path';

export type ConfigCategory = 'Search' | 'Security' | 'AI provider' | 'Memory namespaces';

/**
 * How a value should be asked for. Without this the UI had only `parse`, so every field
 * was a free-text box: booleans required typing the literal `true`, and enums required
 * knowing the allowed values by heart, with a throw on the first typo.
 */
export type ConfigFieldType = 'boolean' | 'enum' | 'number' | 'string' | 'list';

export interface ConfigField {
  key: ConfigKey;
  category: ConfigCategory;
  secret?: boolean;
  type: ConfigFieldType;
  /** Allowed values, for `enum` fields. */
  values?: readonly string[];
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

const VECTOR_PROVIDERS = ['local'] as const;
const VECTOR_DTYPES = ['q4', 'q8', 'fp16', 'fp32'] as const;
const VECTOR_POOLINGS = ['mean', 'cls'] as const;
const AI_PROVIDERS = ['openai', 'anthropic', 'ollama', 'custom'] as const;

export const CONFIG_FIELDS: ConfigField[] = [
  // The preset leads the Search list: it is the one setting most people should touch,
  // and it decides model, dtype and pooling together.
  { key: 'search.vector.preset', category: 'Search', type: 'enum', values: PRESET_IDS, parse: enumValue(PRESET_IDS), defaultValue: DEFAULT_PRESET_ID },
  { key: 'search.vector.enabled', category: 'Search', type: 'boolean', parse: booleanValue, defaultValue: DEFAULT_CONFIG.search?.vector?.enabled },
  { key: 'search.vector.provider', category: 'Search', type: 'enum', values: VECTOR_PROVIDERS, parse: enumValue(VECTOR_PROVIDERS), defaultValue: DEFAULT_CONFIG.search?.vector?.provider },
  { key: 'search.vector.model', category: 'Search', type: 'string', parse: String, defaultValue: DEFAULT_CONFIG.search?.vector?.model },
  { key: 'search.vector.dtype', category: 'Search', type: 'enum', values: VECTOR_DTYPES, parse: enumValue(VECTOR_DTYPES), defaultValue: DEFAULT_CONFIG.search?.vector?.dtype },
  { key: 'search.vector.pooling', category: 'Search', type: 'enum', values: VECTOR_POOLINGS, parse: enumValue(VECTOR_POOLINGS) },
  { key: 'search.vector.cacheDir', category: 'Search', type: 'string', parse: String },
  { key: 'security.rejectSecrets', category: 'Security', type: 'boolean', parse: booleanValue, defaultValue: DEFAULT_CONFIG.security.rejectSecrets },
  { key: 'security.secretPatterns', category: 'Security', type: 'list', parse: stringList, defaultValue: DEFAULT_CONFIG.security.secretPatterns },
  { key: 'ai.provider', category: 'AI provider', type: 'enum', values: AI_PROVIDERS, parse: enumValue(AI_PROVIDERS) },
  { key: 'ai.model', category: 'AI provider', type: 'string', parse: String },
  { key: 'ai.temperature', category: 'AI provider', type: 'number', parse: optionalNumber },
  { key: 'ai.baseUrl', category: 'AI provider', type: 'string', parse: String },
  { key: 'ai.apiKey', category: 'AI provider', type: 'string', parse: String, secret: true },
  { key: 'memory.organization.enabled', category: 'Memory namespaces', type: 'boolean', parse: booleanValue, defaultValue: false },
  { key: 'memory.organization.path', category: 'Memory namespaces', type: 'string', parse: String },
  { key: 'memory.global.enabled', category: 'Memory namespaces', type: 'boolean', parse: booleanValue, defaultValue: false },
  { key: 'memory.global.path', category: 'Memory namespaces', type: 'string', parse: String },
];

export function getConfigField(key: string): ConfigField {
  const field = CONFIG_FIELDS.find(candidate => candidate.key === key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  return field;
}
