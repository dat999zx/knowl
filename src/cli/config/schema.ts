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
  /**
   * Human name shown in the picker, and the only name shown in a category's main list.
   * The dotted key appears under `Advanced settings…`, where someone is already looking
   * for what to pass to `knowl config set`.
   */
  label: string;
  /** One line on what the setting does, shown while editing it. */
  description: string;
  /**
   * Kept out of the category's main list and shown under `Advanced settings…`.
   *
   * These are the knobs a preset already sets correctly. Listing them beside the two
   * settings people actually change buries those two, and every one of them can still
   * be reached with `knowl config set <key> <value>`.
   */
  advanced?: boolean;
  /**
   * The setting that owns this one's value. `resolveVectorProfile` reads a named preset
   * before it ever looks at the flat keys, so while one is set these fields can be
   * written to disk and still change nothing. Marking the relationship lets the UI say
   * so instead of offering an edit that quietly does not take.
   */
  derivedFrom?: ConfigKey;
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
  {
    key: 'search.vector.preset', category: 'Search', type: 'enum', values: PRESET_IDS,
    parse: enumValue(PRESET_IDS), defaultValue: DEFAULT_PRESET_ID,
    label: 'Embedding model',
    description: 'Which local model produces the vectors. Every preset is 384-dimension, so switching never changes the stored vector width.',
  },
  {
    key: 'search.vector.enabled', category: 'Search', type: 'boolean',
    parse: booleanValue, defaultValue: DEFAULT_CONFIG.search?.vector?.enabled,
    label: 'Semantic search',
    description: 'Rank by meaning as well as keywords. Off falls back to keyword search alone.',
  },
  {
    key: 'search.vector.provider', advanced: true, category: 'Search', type: 'enum', values: VECTOR_PROVIDERS,
    parse: enumValue(VECTOR_PROVIDERS), defaultValue: DEFAULT_CONFIG.search?.vector?.provider,
    label: 'Embedding provider',
    description: 'Where embeddings are computed. Local runs on this machine and sends nothing out.',
  },
  {
    key: 'search.vector.model', advanced: true, category: 'Search', type: 'string',
    parse: String, defaultValue: DEFAULT_CONFIG.search?.vector?.model,
    label: 'Model name', derivedFrom: 'search.vector.preset',
    description: 'The Hugging Face model id behind the chosen preset.',
  },
  {
    key: 'search.vector.dtype', advanced: true, category: 'Search', type: 'enum', values: VECTOR_DTYPES,
    parse: enumValue(VECTOR_DTYPES), defaultValue: DEFAULT_CONFIG.search?.vector?.dtype,
    label: 'Quantization', derivedFrom: 'search.vector.preset',
    description: 'Weight precision. Lower is smaller and faster; higher is more accurate.',
  },
  {
    key: 'search.vector.pooling', advanced: true, category: 'Search', type: 'enum', values: VECTOR_POOLINGS,
    parse: enumValue(VECTOR_POOLINGS),
    label: 'Pooling method', derivedFrom: 'search.vector.preset',
    description: 'How token vectors collapse into one. A wrong value ranks badly with no error, which is why presets carry it.',
  },
  {
    key: 'search.vector.cacheDir', advanced: true, category: 'Search', type: 'string', parse: String,
    label: 'Model cache folder',
    description: 'Where downloaded model files are kept. Blank uses the default location.',
  },
  {
    key: 'security.rejectSecrets', category: 'Security', type: 'boolean',
    parse: booleanValue, defaultValue: DEFAULT_CONFIG.security.rejectSecrets,
    label: 'Reject secrets in writes',
    description: 'Refuse any knowledge write containing credentials, keys or tokens.',
  },
  {
    key: 'security.secretPatterns', category: 'Security', type: 'list',
    parse: stringList, defaultValue: DEFAULT_CONFIG.security.secretPatterns,
    label: 'Extra secret patterns',
    description: 'Additional regular expressions to reject, beyond the built-in ones.',
  },
  {
    key: 'ai.provider', category: 'AI provider', type: 'enum', values: AI_PROVIDERS,
    parse: enumValue(AI_PROVIDERS),
    label: 'AI provider',
    description: 'Used only for explicitly requested ingestion and synthesis. Capture never calls it.',
  },
  {
    key: 'ai.model', category: 'AI provider', type: 'string', parse: String,
    label: 'AI model',
    description: 'Model name to send to that provider.',
  },
  {
    key: 'ai.temperature', advanced: true, category: 'AI provider', type: 'number', parse: optionalNumber,
    label: 'Temperature',
    description: 'Sampling randomness, 0 to 2. Lower is more repeatable.',
  },
  {
    key: 'ai.baseUrl', advanced: true, category: 'AI provider', type: 'string', parse: String,
    label: 'API base URL',
    description: 'Override the provider endpoint, for a proxy or a self-hosted server.',
  },
  {
    key: 'ai.apiKey', category: 'AI provider', type: 'string', parse: String, secret: true,
    label: 'API key',
    description: 'Stored redacted. An environment-variable placeholder is preserved as written.',
  },
  {
    key: 'memory.organization.enabled', category: 'Memory namespaces', type: 'boolean',
    parse: booleanValue, defaultValue: false,
    label: 'Organization memory',
    description: 'Share a knowledge namespace across repositories in your organization.',
  },
  {
    key: 'memory.organization.path', advanced: true, category: 'Memory namespaces', type: 'string', parse: String,
    label: 'Organization memory path',
    description: 'Folder holding the organization namespace database.',
  },
  {
    key: 'memory.global.enabled', category: 'Memory namespaces', type: 'boolean',
    parse: booleanValue, defaultValue: false,
    label: 'Personal global memory',
    description: 'Keep personal knowledge that follows you across every project.',
  },
  {
    key: 'memory.global.path', advanced: true, category: 'Memory namespaces', type: 'string', parse: String,
    label: 'Personal global memory path',
    description: 'Folder holding your personal namespace database.',
  },
];

export function getConfigField(key: string): ConfigField {
  const field = CONFIG_FIELDS.find(candidate => candidate.key === key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  return field;
}
