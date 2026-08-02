import { CONFIG_FIELDS, ConfigCategory, ConfigField, ConfigFieldType, getConfigField } from './schema.js';
import { getConfigValue, setConfigValues } from './service.js';
import {
  announceProfileChange, countAffectedEmbeddings, describeProfileChange, formatProfileChangeWarning,
  workspacePinNotice, type ProfileChange,
} from './profile-change.js';
import { loadConfig } from '../../core/config.js';

/** Returned by `selectCategory` to leave the editor. */
export const CONFIG_UI_QUIT = '__knowl_config_quit__';
/** Returned by `selectField` to go back to the category list. */
export const CONFIG_UI_BACK = '__knowl_config_back__';

export interface ConfigFieldView {
  key: string;
  label: string;
  current: unknown;
  secret?: boolean;
  type: ConfigFieldType;
  values?: readonly string[];
}

export interface ConfigChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface ConfigPrompts {
  selectCategory(categories: string[]): Promise<string>;
  selectField(fields: ConfigFieldView[]): Promise<string>;
  inputValue(field: ConfigFieldView, current: unknown): Promise<string>;
  confirmSave(changes: ConfigChange[]): Promise<boolean>;
  continueEditing(): Promise<boolean>;
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
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value ?? 'unset');
}

function fieldView(field: ConfigField, current: unknown): ConfigFieldView {
  return {
    key: field.key,
    label: `${field.key}: ${formatCurrent(current, field.secret)}`,
    current,
    secret: field.secret,
    type: field.type,
    values: field.values,
  };
}

/** Text shown in a free-text box, so the current value can be edited rather than retyped. */
function editableDefault(current: unknown): string {
  if (current === undefined || current === null) return '';
  if (Array.isArray(current)) return current.join(', ');
  return String(current);
}

export function createInquirerPrompts(): ConfigPrompts {
  return {
    selectCategory: async categories => (await import('@inquirer/prompts')).select({
      message: 'Category',
      choices: [
        ...categories.map(category => ({ name: category, value: category })),
        { name: 'Quit', value: CONFIG_UI_QUIT },
      ],
    }),
    selectField: async fields => (await import('@inquirer/prompts')).select({
      message: 'Setting',
      choices: [
        ...fields.map(field => ({ name: field.label, value: field.key })),
        { name: 'Back', value: CONFIG_UI_BACK },
      ],
    }),
    inputValue: async (field, current) => {
      const prompts = await import('@inquirer/prompts');
      if (field.secret) return prompts.password({ message: field.key });
      if (field.type === 'boolean') {
        return String(await prompts.select({
          message: field.key,
          choices: [{ name: 'true', value: true }, { name: 'false', value: false }],
          default: current === true,
        }));
      }
      if (field.type === 'enum' && field.values?.length) {
        return prompts.select({
          message: field.key,
          choices: field.values.map(value => ({ name: value, value })),
          default: typeof current === 'string' ? current : undefined,
        });
      }
      return prompts.input({
        message: field.type === 'list' ? `${field.key} (comma separated)` : field.key,
        default: editableDefault(current),
      });
    },
    confirmSave: async changes => (await import('@inquirer/prompts')).confirm({
      message: `Save changes?\n${changes.map(change => `- ${change.key}: ${String(change.before)} -> ${String(change.after)}`).join('\n')}`,
      default: true,
    }),
    continueEditing: async () => (await import('@inquirer/prompts')).confirm({ message: 'Edit another setting?', default: false }),
    reportError: async (field, message) => {
      console.error(`Invalid value for ${field.key}: ${message}`);
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
    const views = await Promise.all(fields.map(async field => fieldView(field, await getConfigValue(root, field.key))));
    const key = await prompts.selectField(views);
    // Back returns to the category list without forcing an edit. Previously entering a
    // category committed you to changing something in it.
    if (key === CONFIG_UI_BACK) continue;

    const field = getConfigField(key);
    const view = views.find(candidate => candidate.key === key)!;

    let raw: string;
    let parsed: unknown;
    for (;;) {
      raw = await prompts.inputValue(view, view.current);
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
