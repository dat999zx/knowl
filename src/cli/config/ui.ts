import { CONFIG_FIELDS, ConfigCategory, ConfigField, ConfigFieldType, getConfigField } from './schema.js';
import { getConfigValue, setConfigValues } from './service.js';
import {
  announceProfileChange, countAffectedEmbeddings, describeProfileChange, formatProfileChangeWarning,
  workspacePinNotice, type ProfileChange,
} from './profile-change.js';
import { loadConfig } from '../../core/config.js';
import { VECTOR_PRESETS } from '../../core/vector-profile.js';

/** Returned by `selectCategory` to leave the editor. */
export const CONFIG_UI_QUIT = '__knowl_config_quit__';
/** Returned by `selectField` to go back to the category list. */
export const CONFIG_UI_BACK = '__knowl_config_back__';

export interface ConfigFieldView {
  key: string;
  /** Human name. The dotted `key` is still carried, and still shown beside it. */
  label: string;
  /** One line on what the setting does, shown while editing. */
  description: string;
  current: unknown;
  /** `current` rendered for display, already redacted when secret. */
  currentText: string;
  secret?: boolean;
  type: ConfigFieldType;
  values?: readonly string[];
  /**
   * Set when another setting owns this value, naming it. A preset resolves ahead of the
   * flat keys, so editing an owned field writes to disk and changes nothing.
   */
  ownedBy?: { key: string; label: string };
  /** True when the value differs from this field's default. */
  modified: boolean;
}

export interface ConfigChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface ConfigPrompts {
  selectCategory(categories: string[]): Promise<string>;
  selectField(fields: ConfigFieldView[]): Promise<string>;
  /**
   * `null` abandons the edit and returns to the setting list without queueing anything.
   * Widening the return type keeps every implementation that returns a plain string.
   */
  inputValue(field: ConfigFieldView, current: unknown): Promise<string | null>;
  confirmSave(changes: ConfigChange[]): Promise<boolean>;
  continueEditing(): Promise<boolean>;
  /**
   * Asked when a setting owned by another one is selected. Returning true opens the
   * owner instead; without it the selection returns to the list, since editing the
   * owned field directly would write a value nothing reads.
   */
  openOwner?(field: ConfigFieldView): Promise<boolean>;
  /**
   * Shown when a value fails to parse. Implementing it turns a bad entry into a re-prompt;
   * without it the error propagates, which is the older behaviour and is what the tests
   * that supply a fixed value rely on.
   */
  reportError?(field: ConfigFieldView, message: string): Promise<void>;
  /**
   * Asked when the preset picker lands on `custom`. Returning null cancels back to
   * the field list, which is why the caller must not have written anything yet.
   */
  inputCustomModel?(): Promise<{ model: string; pooling: 'mean' | 'cls' } | null>;
  /**
   * Offered after a save that changed the embedding profile. Without it the caller only
   * prints the warning, which is what a non-interactive test harness wants.
   */
  confirmReindex?(change: ProfileChange, affectedRows: number): Promise<boolean>;
}

function formatCurrent(value: unknown, secret?: boolean) {
  if (secret && value) return '********';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (value === '' || value === undefined || value === null) return 'unset';
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value);
}

/** The preset id is an internal token; its own table already holds a readable name. */
function formatPreset(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === 'custom') return 'Custom model';
  const preset = VECTOR_PRESETS[value as keyof typeof VECTOR_PRESETS];
  if (!preset) return null;
  return `${preset.label.split(' — ')[0]} · ${preset.sizeMb} MB · ${preset.languages}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

/**
 * A named preset resolves ahead of the flat keys, so while one is set the fields it
 * covers are display-only. `custom` names no model of its own and therefore owns nothing.
 */
function ownerOf(field: ConfigField, currentByKey: Map<string, unknown>): ConfigFieldView['ownedBy'] {
  if (!field.derivedFrom) return undefined;
  const ownerValue = currentByKey.get(field.derivedFrom);
  if (typeof ownerValue !== 'string' || ownerValue === 'custom') return undefined;
  if (!(ownerValue in VECTOR_PRESETS)) return undefined;
  return { key: field.derivedFrom, label: getConfigField(field.derivedFrom).label };
}

/** Which part of a preset a derived key takes its value from. */
const PRESET_PART: Record<string, keyof (typeof VECTOR_PRESETS)[keyof typeof VECTOR_PRESETS]> = {
  'search.vector.model': 'model',
  'search.vector.dtype': 'dtype',
  'search.vector.pooling': 'pooling',
};

/**
 * What an owned field is actually running, which is not what its own key holds. A repo
 * that switched preset keeps whatever model string it had before, so showing the stored
 * value would name a model that has not been used since.
 */
function effectiveValue(key: string, presetId: unknown, stored: unknown): unknown {
  const part = PRESET_PART[key];
  if (!part || typeof presetId !== 'string') return stored;
  const preset = VECTOR_PRESETS[presetId as keyof typeof VECTOR_PRESETS];
  return preset ? preset[part] : stored;
}

const isUnset = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Whether someone moved this setting off what it would do untouched.
 *
 * A secret always reads back as the redaction, set or not, so there is nothing to
 * compare and the mark is withheld rather than guessed.
 */
function isModified(field: ConfigField, current: unknown, owned: boolean): boolean {
  if (owned || field.secret) return false;
  if (isUnset(current)) return false;
  if (field.defaultValue === undefined) return true;
  return !sameValue(current, field.defaultValue);
}

function fieldView(field: ConfigField, current: unknown, currentByKey: Map<string, unknown>): ConfigFieldView {
  const ownedBy = ownerOf(field, currentByKey);
  // What the setting actually does right now: the preset's value when one owns it, the
  // field default when nothing is written, and only then the stored value.
  const shown = ownedBy
    ? effectiveValue(field.key, currentByKey.get(ownedBy.key), current)
    : isUnset(current) ? field.defaultValue ?? current : current;
  const presetText = field.key === 'search.vector.preset' ? formatPreset(shown) : null;
  return {
    key: field.key,
    label: field.label,
    description: field.description,
    current,
    currentText: presetText ?? formatCurrent(shown, field.secret),
    secret: field.secret,
    type: field.type,
    values: field.values,
    ownedBy,
    modified: isModified(field, current, Boolean(ownedBy)),
  };
}

/** Text shown in a free-text box, so the current value can be edited rather than retyped. */
function editableDefault(current: unknown): string {
  if (current === undefined || current === null) return '';
  if (Array.isArray(current)) return current.join(', ');
  return String(current);
}

/** Sentinel for the `← Back` choice inside a value picker, never a real config value. */
const VALUE_CANCEL = '__knowl_value_cancel__';

/** Human name for a key in the save diff, falling back to the key for anything unknown. */
function describeKey(key: string): string {
  try { return getConfigField(key).label; } catch { return key; }
}

/** Right-hand note on a setting row: what is different, or what owns it. */
function statusNote(field: ConfigFieldView): string {
  if (field.ownedBy) return 'set by preset';
  return field.modified ? 'modified' : '';
}

/**
 * One row per setting: name, current value, and the dotted key. The key is kept because
 * it is what `knowl config set` takes, and a UI that only shows prose gives you no way
 * to find it.
 */
export function fieldRows(fields: ConfigFieldView[]): string[] {
  const nameWidth = Math.max(...fields.map(field => field.label.length));
  const valueWidth = Math.min(44, Math.max(...fields.map(field => field.currentText.length)));
  return fields.map(field => {
    const value = field.currentText.length > valueWidth
      ? `${field.currentText.slice(0, valueWidth - 1)}…`
      : field.currentText;
    const note = statusNote(field);
    return `${field.label.padEnd(nameWidth)}  ${value.padEnd(valueWidth)}  ${note.padEnd(13)} ${field.key}`;
  });
}

/** Preset choices carry the size and language already recorded beside each model. */
export function presetChoices(): Array<{ name: string; value: string; description: string }> {
  const entries = (Object.keys(VECTOR_PRESETS) as Array<keyof typeof VECTOR_PRESETS>).map(id => {
    const preset = VECTOR_PRESETS[id];
    const [name, note] = preset.label.split(' — ');
    // Several labels already name the language, so appending it again would read
    // "200+ languages, 32k context · 98 MB · 200+ languages".
    const parts = [note, `${preset.sizeMb} MB`];
    if (!note?.includes(preset.languages)) parts.push(preset.languages);
    return { name, value: id as string, description: parts.filter(Boolean).join(' · ') };
  });
  return [
    ...entries,
    { name: 'Custom model…', value: 'custom', description: 'Enter a Hugging Face model id' },
    { name: '← Back', value: VALUE_CANCEL, description: 'Leave this setting unchanged' },
  ];
}

export function createInquirerPrompts(): ConfigPrompts {
  return {
    selectCategory: async categories => (await import('@inquirer/prompts')).select({
      message: 'Settings',
      choices: [
        ...categories.map(category => ({ name: category, value: category })),
        { name: 'Quit', value: CONFIG_UI_QUIT },
      ],
    }),
    selectField: async fields => {
      const rows = fieldRows(fields);
      return (await import('@inquirer/prompts')).select({
        message: 'Setting',
        pageSize: Math.min(fields.length + 1, 14),
        choices: [
          ...fields.map((field, index) => ({
            name: rows[index],
            value: field.key,
            description: field.ownedBy
              ? `${field.description}  (chosen by ${field.ownedBy.label})`
              : field.description,
          })),
          { name: '← Back', value: CONFIG_UI_BACK, description: 'Return to the category list' },
        ],
      });
    },
    inputValue: async (field, current) => {
      const prompts = await import('@inquirer/prompts');
      if (field.secret) {
        const entered = await prompts.password({ message: `${field.label} (blank to cancel)` });
        return entered.trim() ? entered : null;
      }

      if (field.key === 'search.vector.preset') {
        console.log(`\n${field.description}\n`);
        const chosen = await prompts.select({
          message: field.label,
          pageSize: 8,
          choices: presetChoices(),
          default: typeof current === 'string' ? current : undefined,
        });
        return chosen === VALUE_CANCEL ? null : chosen;
      }

      if (field.type === 'boolean') {
        const chosen = await prompts.select({
          message: field.label,
          choices: [
            { name: 'On', value: 'true', description: field.description },
            { name: 'Off', value: 'false', description: field.description },
            { name: '← Back', value: VALUE_CANCEL, description: 'Leave this setting unchanged' },
          ],
          default: current === true ? 'true' : 'false',
        });
        return chosen === VALUE_CANCEL ? null : chosen;
      }

      if (field.type === 'enum' && field.values?.length) {
        const chosen = await prompts.select({
          message: field.label,
          choices: [
            ...field.values.map(value => ({ name: value, value, description: field.description })),
            { name: '← Back', value: VALUE_CANCEL, description: 'Leave this setting unchanged' },
          ],
          default: typeof current === 'string' ? current : undefined,
        });
        return chosen === VALUE_CANCEL ? null : chosen;
      }

      const entered = await prompts.input({
        message: field.type === 'list'
          ? `${field.label} (comma separated, blank to cancel)`
          : `${field.label} (blank to cancel)`,
        default: editableDefault(current),
      });
      return entered.trim() ? entered : null;
    },
    openOwner: async field => (await import('@inquirer/prompts')).confirm({
      message: `${field.label} is chosen by ${field.ownedBy?.label}, so editing it here would change nothing. Open ${field.ownedBy?.label} instead?`,
      default: true,
    }),
    confirmSave: async changes => (await import('@inquirer/prompts')).confirm({
      message: `Save these changes?\n${changes.map(change =>
        `  ${describeKey(change.key)}: ${formatCurrent(change.before)} → ${formatCurrent(change.after)}`).join('\n')}\n`,
      default: true,
    }),
    continueEditing: async () => (await import('@inquirer/prompts')).confirm({ message: 'Edit another setting?', default: false }),
    reportError: async (field, message) => {
      console.error(`  ${field.label} — ${message}`);
    },
    confirmReindex: async (_change, affectedRows) => (await import('@inquirer/prompts')).confirm({
      message: affectedRows > 0
        ? `Rebuild ${affectedRows} embedding(s) with the new model now?`
        : 'Build embeddings with the new model now?',
      default: true,
    }),
    inputCustomModel: async () => {
      const prompts = await import('@inquirer/prompts');
      const { verifyCustomModel } = await import('../../ai/model-probe.js');
      for (;;) {
        const model = await prompts.input({ message: 'Hugging Face model id (blank to cancel)' });
        if (!model.trim()) return null;

        const probe = await verifyCustomModel(model.trim());
        if (!probe.ok) {
          console.error(probe.reason);
          continue;
        }

        // Asked, never defaulted: an ONNX mirror without 1_Pooling/config.json gives
        // us nothing to infer from, and a wrong guess ranks badly with no error.
        const pooling = probe.pooling ?? await prompts.select({
          message: `${model} does not declare its pooling method. Which does it use?`,
          choices: [{ name: 'cls', value: 'cls' as const }, { name: 'mean', value: 'mean' as const }],
        });
        return { model: model.trim(), pooling };
      }
    },
  };
}

export async function runConfigUi(root: string, prompts: ConfigPrompts = createInquirerPrompts()) {
  const categories = [...new Set(CONFIG_FIELDS.map(field => field.category))];
  const changes: Array<ConfigChange & { raw: string }> = [];
  // Read before any edit: the comparison is between whole resolved profiles, so it
  // cannot be reconstructed from the individual key changes.
  const configBefore = await loadConfig(root).catch(() => null);

  let editing = true;
  while (editing) {
    const category = await prompts.selectCategory(categories);
    if (category === CONFIG_UI_QUIT) break;

    const fields = CONFIG_FIELDS.filter(field => field.category === category as ConfigCategory);
    // Ownership is read across the whole category, not per field: whether `model` is
    // editable depends on what `preset` currently holds.
    const currentByKey = new Map<string, unknown>(
      await Promise.all(CONFIG_FIELDS.map(async field => [field.key, await getConfigValue(root, field.key)] as const)),
    );
    const views = fields.map(field => fieldView(field, currentByKey.get(field.key), currentByKey));
    const selected = await prompts.selectField(views);
    // Back returns to the category list without forcing an edit. Previously entering a
    // category committed you to changing something in it.
    if (selected === CONFIG_UI_BACK) continue;

    let view = views.find(candidate => candidate.key === selected)!;
    // An owned field is display-only while its owner holds a named preset. Offering the
    // owner keeps the interaction going somewhere useful instead of dead-ending.
    if (view.ownedBy) {
      const owner = view.ownedBy;
      if (!prompts.openOwner || !(await prompts.openOwner(view))) continue;
      view = fieldView(getConfigField(owner.key), currentByKey.get(owner.key), currentByKey);
    }

    const key = view.key;
    const field = getConfigField(key);

    let raw = '';
    let parsed: unknown;
    let cancelled = false;
    for (;;) {
      const entered = await prompts.inputValue(view, view.current);
      // Null is a deliberate exit from the value prompt, not a value to parse.
      if (entered === null) { cancelled = true; break; }
      raw = entered;
      try {
        parsed = field.parse(raw);
        break;
      } catch (error) {
        // Without a reporter there is nothing to show and nothing would change on a
        // retry, so surface the error instead of looping forever.
        if (!prompts.reportError) throw error;
        await prompts.reportError(view, error instanceof Error ? error.message : String(error));
      }
    }
    if (cancelled) continue;

    // `custom` names no model on its own, so the follow-up is asked here and queued
    // with it. Cancelling queues nothing, which is why it is asked before the push.
    if (key === 'search.vector.preset' && parsed === 'custom') {
      if (!prompts.inputCustomModel) {
        throw new Error('Custom models need an interactive prompt. Use `knowl config set-model <name>`.');
      }
      const custom = await prompts.inputCustomModel();
      if (!custom) continue; // cancelled: nothing queued, nothing written
      changes.push({ key, before: view.current, after: parsed, raw });
      changes.push({ key: 'search.vector.model', before: '', after: custom.model, raw: custom.model });
      changes.push({ key: 'search.vector.pooling', before: '', after: custom.pooling, raw: custom.pooling });
      editing = await prompts.continueEditing();
      continue;
    }

    changes.push({
      key,
      before: field.secret ? '********' : view.current,
      after: field.secret ? '********' : parsed,
      raw,
    });

    editing = await prompts.continueEditing();
  }

  const visibleChanges = changes.map(({ raw: _raw, ...change }) => change);
  // Quitting without touching anything should just exit, not ask about an empty diff.
  if (visibleChanges.length === 0) return { saved: false, changes: visibleChanges, reindexRequested: false };
  if (!(await prompts.confirmSave(visibleChanges))) {
    return { saved: false, changes: visibleChanges, reindexRequested: false };
  }

  // One save, not one per change: a custom preset is three keys, and a partial write
  // would leave `preset: custom` on disk with no model beside it.
  await setConfigValues(root, changes.map(change => ({ key: change.key, raw: change.raw })));

  const reindexRequested = await offerReindex(root, configBefore, prompts);
  return { saved: true, changes: visibleChanges, reindexRequested };
}

/**
 * Ask about rebuilding when the save moved the embedding profile.
 *
 * Returns false rather than printing nothing when there is no prompt to ask with: the
 * warning still goes out, so a scripted caller learns what changed even though it
 * cannot answer.
 */
async function offerReindex(
  root: string,
  configBefore: Awaited<ReturnType<typeof loadConfig>> | null,
  prompts: ConfigPrompts,
): Promise<boolean> {
  if (!configBefore) return false;
  const configAfter = await loadConfig(root).catch(() => null);
  if (!configAfter) return false;

  const change = describeProfileChange(configBefore, configAfter);
  if (!change.changed) return false;

  if (!prompts.confirmReindex) {
    await announceProfileChange(root, configBefore, configAfter);
    return false;
  }

  const affected = await countAffectedEmbeddings(root);
  console.log('');
  console.log(formatProfileChangeWarning(change, affected));
  for (const line of await workspacePinNotice(root, configAfter)) console.log(line);
  return prompts.confirmReindex(change, affected);
}
