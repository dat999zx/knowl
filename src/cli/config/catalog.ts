import { loadConfig } from '../../core/config.js';
import { VECTOR_PRESETS, resolveVectorProfile } from '../../core/vector-profile.js';
import { getEffectiveConfigValue } from './service.js';
import { CONFIG_FIELDS, ConfigCategory, ConfigField } from './schema.js';

/**
 * The non-interactive rendering of `CONFIG_FIELDS`.
 *
 * These descriptions already existed and were reachable from exactly one place: the interactive
 * editor, which needs a TTY. So the question a new user actually has -- what can this do, and
 * what is on -- had no answer anywhere. `knowl status` reports item counts, capture health and
 * workspace; `knowl doctor` reports readiness. Neither enumerates a feature, and `knowl init`
 * points at `knowl status` and nowhere else.
 *
 * Rendering is kept apart from reading the config so it can be asserted directly, and so the
 * same rows can be rendered somewhere other than stdout later without the reader coming along.
 */
export interface CatalogRow {
  field: ConfigField;
  /** The effective value, resolved the way `knowl config get` resolves it. */
  value: unknown;
  /**
   * Set when a named preset owns this field's value. `resolveVectorProfile` reads the preset
   * before it ever looks at the flat keys, so offering `config set` here would be offering an
   * edit that writes the file and changes nothing.
   */
  shadowed?: boolean;
}

/**
 * When a change starts being obeyed, stated once rather than per field.
 *
 * Three gates re-read config from disk on every call and fail closed if either the captured or
 * the on-disk value says off -- the transcripts gate, `knowl_cloud` and `knowl_workspace`.
 * Everything else is the config the MCP server captured when it spawned. A per-field label was
 * the first design and was dropped: it would be a hand-maintained answer for 32 settings whose
 * consumer chains are not all traced, and a wrong "takes effect now" is worse than a rule the
 * reader applies themselves.
 */
const EFFECT_NOTICE = [
  'Transcript search, the cloud connection and workspace membership are obeyed immediately by a',
  'running agent session -- their gates re-read this file on every call. Every other setting is',
  'read when a session starts, so one already running keeps the value it started with.',
];

/**
 * Wraps to a fixed width with a hanging indent.
 *
 * Fixed rather than `process.stdout.columns`, so the same input renders the same bytes whether
 * it goes to a terminal, a pipe or a test. Several descriptions are 200-plus characters, and a
 * terminal left to break them puts the continuation in column one, where it reads as a setting.
 */
function wrap(text: string, indent: string, width = 96): string[] {
  const limit = width - indent.length;
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else { lines.push(indent + current); current = word; }
  }
  if (current) lines.push(indent + current);
  return lines;
}

/**
 * The value a three-mode ladder uses to spell its own off state.
 *
 * Every enum in `CONFIG_FIELDS` that HAS an off state spells it this way and lists it first --
 * `impact.gate`, `capture.nudge`, `capture.events` -- because the values are ordered by what
 * they cost the person running them. An enum without this in its list (`capture.scope`,
 * `ai.provider`, `search.vector.preset`) has no off state, and every value counts as on.
 */
const OFF = 'off';

/** Whether a row counts as switched on, which is what the marker and the hint key off. */
export function isOn(field: ConfigField, value: unknown): boolean {
  if (field.type === 'boolean') return value === true;
  // An enum sitting at `off` is off. Without this it rendered ● beside the literal word `off`
  // on the same line -- the marker contradicting the value it was printed next to -- and
  // counted toward "N of M on", so `knowl status` reported two disarmed features as armed.
  if (field.type === 'enum') return value !== OFF && value !== undefined && value !== null && value !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

/**
 * What to suggest for a setting that is off: `true` for a switch, and for a ladder the first
 * value above off.
 *
 * First-above-off rather than the last, deliberately: the mode lists are ordered "nothing, then
 * measurement, then refusal", so the cheapest step up is both the safest recommendation and the
 * one the schema comment says the modes are meant to be adopted in.
 */
function turnOnValue(field: ConfigField): string | undefined {
  if (field.type === 'boolean') return 'true';
  if (field.type === 'enum') return field.values?.find(candidate => candidate !== OFF);
  return undefined;
}

/**
 * Whether a field is a switch rather than a value to be filled in.
 *
 * Derived from `type` and `derivedFrom` rather than hand-marked, so a new setting is classified
 * by what it already declares. A preset-owned field is excluded whatever its type: it is an
 * internal of the preset that owns it, not a choice offered here.
 */
export function isSwitch(field: ConfigField): boolean {
  if (field.derivedFrom) return false;
  return field.type === 'boolean' || field.type === 'enum';
}

/**
 * A secret's value never reaches the terminal, only whether one is present. npm prints
 * `(protected)` in the same position for the same reason: a catalog gets pasted into issues.
 */
function displayValue(field: ConfigField, value: unknown): string {
  if (field.secret) return isOn(field, value) ? '(set)' : '(unset)';
  if (field.type === 'boolean') return value === true ? 'on' : 'off';
  if (Array.isArray(value)) return value.length ? `${value.length} pattern(s)` : '(none)';
  if (value === undefined || value === null || value === '') return '(unset)';
  return String(value);
}

/** Which part of a vector preset a derived key takes its value from. */
const PRESET_PART = {
  'search.vector.model': 'model',
  'search.vector.dtype': 'dtype',
  'search.vector.pooling': 'pooling',
} as const;

/**
 * Reads what each setting is actually running on.
 *
 * Kept separate from rendering so the values can be asserted without parsing text, and so the
 * preset resolution below has one home rather than being repeated by every future caller.
 */
export async function buildConfigCatalog(
  root: string,
  options: { all?: boolean } = {},
): Promise<CatalogRow[]> {
  const config = await loadConfig(root);
  const fields = options.all ? CONFIG_FIELDS : CONFIG_FIELDS.filter(isSwitch);
  const profile = resolveVectorProfile(config);
  const preset = config.search?.vector?.preset;
  // `custom` names no model of its own, so under it the flat keys ARE the real values and
  // nothing shadows them -- the same rule `ownerOf` applies in the interactive editor.
  const presetOwns = typeof preset === 'string' && preset !== 'custom' && preset in VECTOR_PRESETS;

  const rows: CatalogRow[] = [];
  for (const field of fields) {
    const part = PRESET_PART[field.key as keyof typeof PRESET_PART];
    const shadowed = Boolean(field.derivedFrom && presetOwns);
    rows.push({
      field,
      // The preset's value, not the stored key's: switching preset never rewrites the flat
      // keys, so the stored one can name a model that has not been used since. See 1453b1f2.
      value: shadowed && part ? profile[part] : await getEffectiveConfigValue(root, field.key),
      shadowed,
    });
  }
  return rows;
}

/**
 * The settings reference printed under `knowl config --help`.
 *
 * `gh config --help` lists every setting it respects with a description, its allowed values and
 * its default, and that help text is the reference people actually read -- so this is generated
 * from the same registry the editor and the catalog use, and cannot fall behind them.
 *
 * State is deliberately absent: help is printed without a repository, and a reference that
 * guessed at what was on would be wrong exactly where it mattered. `knowl config list` has it.
 */
export function renderConfigReference(): string[] {
  const fields = CONFIG_FIELDS.filter(isSwitch);
  const width = Math.max(0, ...fields.map(candidate => candidate.key.length));
  const hanging = ' '.repeat(width + 4);

  return fields.flatMap(candidate => {
    const values = candidate.type === 'enum' && candidate.values?.length
      ? ` {${candidate.values.join(' | ')}}`
      : '';
    const fallback = candidate.defaultValue === undefined ? '' : ` (default ${JSON.stringify(candidate.defaultValue)})`;
    // Wrapped under the description column rather than run out to 300 characters, which is
    // what several of these produce -- found by printing it, not by asserting on it.
    const [first, ...rest] = wrap(`${candidate.description}${values}${fallback}`, hanging);
    return [
      `  ${candidate.key.padEnd(width)}  ${first.trimStart()}`,
      ...rest,
    ];
  });
}

/**
 * The one line `knowl status` carries.
 *
 * A count and a pointer, not the catalog: status is already the longest screen the CLI prints,
 * and thirty settings there would bury the warnings it exists to surface. This is the whole of
 * the discoverability fix -- `knowl init` sends every new user to `knowl status` and nowhere
 * else, so a feature the product never mentions there is a feature nobody finds.
 */
export function formatFeatureSummary(rows: CatalogRow[]): string {
  const on = rows.filter(row => isOn(row.field, row.value)).length;
  return `${on} of ${rows.length} on · knowl config list`;
}

export interface RenderOptions {
  /** Prefix every `config set` hint, so a caller outside the repo can show a runnable command. */
  commandName?: string;
}

export function renderConfigCatalog(rows: CatalogRow[], options: RenderOptions = {}): string[] {
  const command = options.commandName ?? 'knowl';
  const lines: string[] = [];

  const byCategory = new Map<ConfigCategory, CatalogRow[]>();
  for (const row of rows) {
    const existing = byCategory.get(row.field.category);
    if (existing) existing.push(row);
    else byCategory.set(row.field.category, [row]);
  }

  const labelWidth = Math.max(0, ...rows.map(row => row.field.label.length));

  for (const [category, categoryRows] of byCategory) {
    if (lines.length) lines.push('');
    lines.push(category.toUpperCase());
    for (const row of categoryRows) {
      const { field } = row;
      const marker = isOn(field, row.value) ? '●' : '○';
      lines.push(`  ${marker} ${field.label.padEnd(labelWidth)}  ${displayValue(field, row.value)}`);
      lines.push(...wrap(field.description, '      '));
      lines.push(`      ${field.key}`);

      if (field.type === 'enum' && field.values?.length) {
        lines.push(`      one of: ${field.values.join(', ')}`);
      }

      if (row.shadowed && field.derivedFrom) {
        // Says who owns it instead of offering the edit, which is the whole point of the flag.
        lines.push(`      set by ${field.derivedFrom}; writing this key changes nothing`);
      } else if (!isOn(field, row.value)) {
        // Ladders get a hint too, not just switches. Gating this on `boolean` left the two
        // settings that most need one -- a disarmed `impact.gate` and `capture.events` -- with
        // no way shown to arm them, which is the one job this command has.
        const target = turnOnValue(field);
        if (target) lines.push(`      ${command} config set ${field.key} ${target}`);
      }
    }
  }

  if (lines.length) {
    lines.push('');
    lines.push(...EFFECT_NOTICE);
  }

  return lines;
}
