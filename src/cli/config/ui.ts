import { CONFIG_FIELDS, ConfigField, ConfigFieldType, getConfigField } from './schema.js';
import { getConfigValue, setConfigValues } from './service.js';
import {
  announceProfileChange, countAffectedEmbeddings, describeProfileChange, formatProfileChangeWarning,
  workspacePinNotice, type ProfileChange,
} from './profile-change.js';
import { loadConfig } from '../../core/config.js';
import { VECTOR_PRESETS, currentPresetId } from '../../core/vector-profile.js';
import { applyTranscriptConfigTransition, describeTranscriptTeardown } from '../../transcripts/teardown.js';

// One flat list of every setting, edited in place.
//
// The earlier build was a tree -- category, then setting, then value, with the keys a
// preset supplies hidden a level further down and refusing to open at all. Every level
// was somewhere to get lost and none of them was somewhere to change anything.
//
// This is the shape the good CLI flows use: one list, a hint on each row saying what the
// value is now, and a single uniform way to back out of anything.

/** Chosen from the settings list: leave without writing anything. */
export const CONFIG_UI_QUIT = '__knowl_config_quit__';
/** Chosen from the settings list: write what is queued. */
export const CONFIG_UI_SAVE = '__knowl_config_save__';

export interface ConfigFieldView {
  key: string;
  /** Human name. The dotted key is what `knowl config set` takes and stays out of the list. */
  label: string;
  /** One line on what the setting does. */
  description: string;
  /** The value in effect, including anything queued but not yet written. */
  current: unknown;
  /** `current` rendered for display, already redacted when secret. */
  currentText: string;
  secret?: boolean;
  type: ConfigFieldType;
  values?: readonly string[];
  /**
   * Set when a named preset currently supplies this value. Not a lock: editing the field
   * moves the profile to a custom one so the edit takes effect.
   */
  ownedBy?: { key: string; label: string; presetId: string };
  /** True when the value differs from this field's default. */
  modified: boolean;
  /** True when this setting has an edit queued but not yet written. */
  pending: boolean;
}

export interface ConfigChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface ConfigPrompts {
  /** Returns a setting key, `CONFIG_UI_SAVE`, or `CONFIG_UI_QUIT`. */
  selectSetting(fields: ConfigFieldView[]): Promise<string>;
  /** `null` backs out of the edit and returns to the list, queueing nothing. */
  inputValue(field: ConfigFieldView): Promise<string | null>;
  confirmSave(changes: ConfigChange[]): Promise<boolean>;
  /** Turns an unparseable value into a re-prompt; without it the error propagates. */
  reportError?(field: ConfigFieldView, message: string): Promise<void>;
  /** Asked when the model picker lands on `custom`. `null` queues nothing. */
  inputCustomModel?(): Promise<{ model: string; pooling: 'mean' | 'cls' } | null>;
  /** Offered after a save that moved the embedding profile. */
  confirmReindex?(change: ProfileChange, affectedRows: number): Promise<boolean>;
}

function formatCurrent(value: unknown, secret?: boolean): string {
  if (secret && value) return '********';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (value === '' || value === undefined || value === null) return 'not set';
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value);
}

/** The preset id is an internal token; its own table already holds a readable name. */
function formatPreset(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === 'custom') return 'Custom model';
  const preset = VECTOR_PRESETS[value as keyof typeof VECTOR_PRESETS];
  return preset ? `${preset.label.split(' — ')[0]} · ${preset.sizeMb} MB` : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

/**
 * Which named preset supplies this field's value, if any. `custom` names no model of its
 * own, so under it the flat keys are the real values and nothing supplies them.
 */
function ownerOf(field: ConfigField, valueOf: (key: string) => unknown): ConfigFieldView['ownedBy'] {
  if (!field.derivedFrom) return undefined;
  const owner = valueOf(field.derivedFrom);
  if (typeof owner !== 'string' || owner === 'custom' || !(owner in VECTOR_PRESETS)) return undefined;
  return { key: field.derivedFrom, label: getConfigField(field.derivedFrom).label, presetId: owner };
}

/** Which part of a preset a derived key takes its value from. */
const PRESET_PART = {
  'search.vector.model': 'model',
  'search.vector.dtype': 'dtype',
  'search.vector.pooling': 'pooling',
} as const;

/**
 * What a preset-supplied field is actually running, which is not what its own key holds:
 * switching preset never rewrites the flat keys, so the stored value can name a model
 * that has not been used since.
 */
function effectiveValue(key: string, presetId: unknown, stored: unknown): unknown {
  const part = PRESET_PART[key as keyof typeof PRESET_PART];
  if (!part || typeof presetId !== 'string') return stored;
  const preset = VECTOR_PRESETS[presetId as keyof typeof VECTOR_PRESETS];
  return preset ? preset[part] : stored;
}

const isUnset = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Whether someone moved this setting off what it would do untouched. A secret always
 * reads back as the redaction, so there is nothing to compare and the mark is withheld.
 */
function isModified(field: ConfigField, current: unknown, owned: boolean): boolean {
  if (owned || field.secret) return false;
  if (isUnset(current)) return false;
  if (field.defaultValue === undefined) return true;
  return !sameValue(current, field.defaultValue);
}

export function buildView(
  field: ConfigField,
  valueOf: (key: string) => unknown,
  resolvedPreset: string | null,
  pending: boolean,
): ConfigFieldView {
  // A repo initialised before presets existed has no `preset` key, so its own stored value
  // is not what identifies the model in use; `currentPresetId` matches the model string.
  const raw = valueOf(field.key);
  const stored = field.key === 'search.vector.preset' ? raw ?? resolvedPreset : raw;
  const ownedBy = ownerOf(field, valueOf);
  const shown = ownedBy
    ? effectiveValue(field.key, valueOf(ownedBy.key), stored)
    : isUnset(stored) ? field.defaultValue ?? stored : stored;
  return {
    key: field.key,
    label: field.label,
    description: field.description,
    current: shown,
    currentText: (field.key === 'search.vector.preset' ? formatPreset(shown) : null)
      ?? formatCurrent(shown, field.secret),
    secret: field.secret,
    type: field.type,
    values: field.values,
    ownedBy,
    modified: isModified(field, stored, Boolean(ownedBy)),
    pending,
  };
}

/**
 * Model choices, carrying the size and language recorded beside each one and marking
 * which is running now -- including for a config whose only evidence is its model string.
 */
export function presetChoices(current?: string): Array<{ value: string; label: string; hint: string }> {
  const entries = (Object.keys(VECTOR_PRESETS) as Array<keyof typeof VECTOR_PRESETS>).map(id => {
    const preset = VECTOR_PRESETS[id];
    const [label, note] = preset.label.split(' — ');
    const parts = [id === current ? 'current' : '', note?.replace(/^the /, ''), `${preset.sizeMb} MB`];
    if (!note?.includes(preset.languages)) parts.push(preset.languages);
    return { value: id as string, label, hint: parts.filter(Boolean).join(' · ') };
  });
  return [...entries, { value: 'custom', label: 'Custom model', hint: 'any Hugging Face model id' }];
}

/** Model ids behind the presets, for editing the raw key directly. */
export function modelChoices(): Array<{ value: string; label: string; hint: string }> {
  return (Object.keys(VECTOR_PRESETS) as Array<keyof typeof VECTOR_PRESETS>).map(id => ({
    value: VECTOR_PRESETS[id].model,
    label: VECTOR_PRESETS[id].model,
    hint: `${VECTOR_PRESETS[id].label.split(' — ')[0]} · ${VECTOR_PRESETS[id].sizeMb} MB`,
  }));
}

/** Text pre-filled into a free-text box, so a value is edited rather than retyped. */
function editableDefault(current: unknown): string {
  if (current === undefined || current === null) return '';
  if (Array.isArray(current)) return current.join(', ');
  return String(current);
}

export function createClackPrompts(): ConfigPrompts {
  return {
    selectSetting: async fields => {
      const clack = await import('@clack/prompts');
      const pc = (await import('picocolors')).default;
      const pending = fields.filter(field => field.pending).length;
      const chosen = await clack.select({
        message: pending ? `Settings ${pc.dim(`(${pending} unsaved)`)}` : 'Settings',
        maxItems: 12,
        options: [
          ...fields.map(field => ({
            value: field.key,
            label: field.pending ? `${field.label} ${pc.yellow('*')}` : field.label,
            hint: field.ownedBy ? `${field.currentText} — from ${field.ownedBy.label}` : field.currentText,
          })),
          {
            value: CONFIG_UI_SAVE,
            label: pending ? 'Save and exit' : 'Exit',
            hint: pending ? `write ${pending} change${pending === 1 ? '' : 's'}` : 'nothing to save',
          },
          { value: CONFIG_UI_QUIT, label: 'Discard and exit', hint: 'leave everything as it was' },
        ],
      });
      // One uniform escape. Ctrl+C anywhere lands here rather than tearing the process
      // down mid-edit, which is what makes backing out feel like part of the UI.
      return clack.isCancel(chosen) ? CONFIG_UI_QUIT : String(chosen);
    },

    inputValue: async field => {
      const clack = await import('@clack/prompts');
      const unwrap = (value: unknown) => (clack.isCancel(value) ? null : value);

      if (field.key === 'search.vector.preset') {
        const chosen = unwrap(await clack.select({
          message: field.label,
          maxItems: 8,
          options: presetChoices(typeof field.current === 'string' ? field.current : undefined),
          initialValue: typeof field.current === 'string' ? field.current : undefined,
        }));
        return chosen === null ? null : String(chosen);
      }

      if (field.key === 'search.vector.model') {
        const TYPE_IT = '__knowl_type_model__';
        const chosen = unwrap(await clack.select({
          message: field.label,
          maxItems: 8,
          options: [...modelChoices(), { value: TYPE_IT, label: 'Type another model id', hint: 'any Hugging Face id' }],
          initialValue: typeof field.current === 'string' ? field.current : undefined,
        }));
        if (chosen === null) return null;
        if (chosen !== TYPE_IT) return String(chosen);
        const typed = unwrap(await clack.text({ message: field.label, initialValue: editableDefault(field.current) }));
        return typed === null ? null : String(typed);
      }

      if (field.type === 'boolean') {
        const chosen = unwrap(await clack.confirm({ message: field.label, initialValue: field.current === true }));
        return chosen === null ? null : String(chosen);
      }

      if (field.type === 'enum' && field.values?.length) {
        const chosen = unwrap(await clack.select({
          message: field.label,
          options: field.values.map(value => ({ value, label: value })),
          initialValue: typeof field.current === 'string' ? field.current : undefined,
        }));
        return chosen === null ? null : String(chosen);
      }

      if (field.secret) {
        const entered = unwrap(await clack.password({ message: `${field.label} (blank to clear)` }));
        return entered === null ? null : String(entered);
      }

      const entered = unwrap(await clack.text({
        message: field.type === 'list' ? `${field.label} (comma separated)` : field.label,
        initialValue: editableDefault(field.current),
        // Without this an empty box refuses to submit, so a setting could never be cleared.
        defaultValue: '',
      }));
      return entered === null ? null : String(entered);
    },

    confirmSave: async changes => {
      const clack = await import('@clack/prompts');
      const describe = (key: string) => { try { return getConfigField(key).label; } catch { return key; } };
      clack.note(
        changes.map(change =>
          `${describe(change.key)}: ${formatCurrent(change.before)} → ${formatCurrent(change.after)}`).join('\n'),
        `${changes.length} change${changes.length === 1 ? '' : 's'}`,
      );
      const ok = await clack.confirm({ message: 'Write these to .knowl/config.json?', initialValue: true });
      return !clack.isCancel(ok) && ok === true;
    },

    reportError: async (field, message) => {
      const clack = await import('@clack/prompts');
      clack.log.error(`${field.label}: ${message}`);
    },

    confirmReindex: async (_change, affectedRows) => {
      const clack = await import('@clack/prompts');
      const ok = await clack.confirm({
        message: affectedRows > 0
          ? `Rebuild ${affectedRows} embedding(s) with the new model now?`
          : 'Build embeddings with the new model now?',
        initialValue: true,
      });
      return !clack.isCancel(ok) && ok === true;
    },

    inputCustomModel: async () => {
      const clack = await import('@clack/prompts');
      const { verifyCustomModel } = await import('../../ai/model-probe.js');
      for (;;) {
        const model = await clack.text({ message: 'Hugging Face model id' });
        if (clack.isCancel(model) || !String(model ?? '').trim()) return null;

        const probe = await verifyCustomModel(String(model).trim());
        if (!probe.ok) { clack.log.error(probe.reason); continue; }

        // Asked, never defaulted: an ONNX mirror without 1_Pooling/config.json gives us
        // nothing to infer from, and a wrong guess ranks badly with no error.
        let pooling = probe.pooling;
        if (!pooling) {
          const picked = await clack.select({
            message: `${String(model)} does not declare its pooling method. Which does it use?`,
            options: [{ value: 'cls', label: 'cls' }, { value: 'mean', label: 'mean' }],
          });
          if (clack.isCancel(picked)) return null;
          pooling = picked as 'mean' | 'cls';
        }
        return { model: String(model).trim(), pooling };
      }
    },
  };
}

export async function runConfigUi(root: string, prompts: ConfigPrompts = createClackPrompts()) {
  // Read before any edit: the reindex comparison is between whole resolved profiles, so
  // it cannot be reconstructed from the individual key changes.
  const configBefore = await loadConfig(root).catch(() => null);
  const resolvedPreset = configBefore ? currentPresetId(configBefore) : null;

  const stored = new Map<string, unknown>(
    await Promise.all(CONFIG_FIELDS.map(async field => [field.key, await getConfigValue(root, field.key)] as const)),
  );
  // Queued edits shadow the file, so the list shows an edit the moment it is made rather
  // than only after a save.
  const queued = new Map<string, { raw: string; value: unknown }>();
  const valueOf = (key: string) => (queued.has(key) ? queued.get(key)!.value : stored.get(key));

  for (;;) {
    const views = CONFIG_FIELDS.map(field => buildView(field, valueOf, resolvedPreset, queued.has(field.key)));
    const selected = await prompts.selectSetting(views);
    if (selected === CONFIG_UI_QUIT) return { saved: false, changes: [] as ConfigChange[], reindexRequested: false };
    if (selected === CONFIG_UI_SAVE) break;

    const field = getConfigField(selected);
    const view = views.find(candidate => candidate.key === selected)!;

    let raw: string | null = null;
    let parsed: unknown;
    for (;;) {
      const entered = await prompts.inputValue(view);
      if (entered === null) break; // backed out: nothing queued
      try {
        parsed = field.parse(entered);
        raw = entered;
        break;
      } catch (error) {
        // Without a reporter there is nothing to show and nothing would change on a
        // retry, so surface the error instead of looping forever.
        if (!prompts.reportError) throw error;
        await prompts.reportError(view, error instanceof Error ? error.message : String(error));
      }
    }
    if (raw === null) continue;

    // `custom` names no model on its own, so the follow-up is asked before anything is
    // queued -- cancelling it must not leave `preset: custom` with no model behind it.
    if (selected === 'search.vector.preset' && parsed === 'custom') {
      if (!prompts.inputCustomModel) {
        throw new Error('Custom models need an interactive prompt. Use `knowl config set-model <name>`.');
      }
      const custom = await prompts.inputCustomModel();
      if (!custom) continue;
      queued.set('search.vector.preset', { raw: 'custom', value: 'custom' });
      queued.set('search.vector.model', { raw: custom.model, value: custom.model });
      queued.set('search.vector.pooling', { raw: custom.pooling, value: custom.pooling });
      continue;
    }

    // Picking a model writes the whole profile. Writing the preset name alone was correct
    // only because `resolveVectorProfile` prefers it: the flat keys kept describing the
    // previous model, and a config with no `preset` key had nothing to prefer.
    if (selected === 'search.vector.preset' && typeof parsed === 'string' && parsed in VECTOR_PRESETS) {
      const preset = VECTOR_PRESETS[parsed as keyof typeof VECTOR_PRESETS];
      queued.set('search.vector.preset', { raw, value: parsed });
      queued.set('search.vector.model', { raw: preset.model, value: preset.model });
      queued.set('search.vector.dtype', { raw: preset.dtype, value: preset.dtype });
      queued.set('search.vector.pooling', { raw: preset.pooling, value: preset.pooling });
      continue;
    }

    // Editing a field a named preset supplies takes effect rather than being ignored: the
    // preset resolves ahead of the flat keys, so the profile moves to custom, keeps the
    // preset's other values, and the edited key wins.
    if (view.ownedBy) {
      const preset = VECTOR_PRESETS[view.ownedBy.presetId as keyof typeof VECTOR_PRESETS];
      queued.set('search.vector.preset', { raw: 'custom', value: 'custom' });
      for (const [key, value] of [
        ['search.vector.model', preset.model],
        ['search.vector.dtype', preset.dtype],
        ['search.vector.pooling', preset.pooling],
      ] as const) {
        if (key !== selected) queued.set(key, { raw: String(value), value });
      }
    }

    queued.set(selected, { raw, value: parsed });
  }

  const changes: ConfigChange[] = [...queued.entries()].map(([key, entry]) => ({
    key,
    before: getConfigField(key).secret ? '********' : stored.get(key),
    after: getConfigField(key).secret ? '********' : entry.value,
  }));
  if (changes.length === 0) return { saved: false, changes, reindexRequested: false };
  if (!(await prompts.confirmSave(changes))) return { saved: false, changes, reindexRequested: false };

  // One save, not one per change: a custom profile is three keys, and a partial write
  // would leave `preset: custom` on disk with no model beside it.
  await setConfigValues(root, [...queued.entries()].map(([key, entry]) => ({ key, raw: entry.raw })));

  const reindexRequested = await offerReindex(root, configBefore, prompts);

  // Symmetric with offerReindex, and for the same reason: the save has already landed, so this
  // reacts to what the config now says rather than to which key the user happened to edit.
  // Turning transcript search off deletes its index -- an index nothing will refresh, belonging
  // to the one user who explicitly declined to keep it.
  if (configBefore) {
    const teardown = describeTranscriptTeardown(
      await applyTranscriptConfigTransition(root, configBefore, await loadConfig(root).catch(() => configBefore)),
    );
    if (teardown) console.log(teardown);
  }

  return { saved: true, changes, reindexRequested };
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
