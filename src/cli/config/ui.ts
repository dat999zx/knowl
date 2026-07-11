import { confirm, input, password, select } from '@inquirer/prompts';
import { CONFIG_FIELDS, ConfigCategory, ConfigField, getConfigField } from './schema.js';
import { getConfigValue, setConfigValue } from './service.js';

export interface ConfigFieldView {
  key: string;
  label: string;
  current: unknown;
  secret?: boolean;
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
}

function formatCurrent(value: unknown, secret?: boolean) {
  if (secret && value) return '********';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value ?? 'unset');
}

function fieldView(field: ConfigField, current: unknown): ConfigFieldView {
  return {
    key: field.key,
    label: `${field.key}: ${formatCurrent(current, field.secret)}`,
    current,
    secret: field.secret,
  };
}

export function createInquirerPrompts(): ConfigPrompts {
  return {
    selectCategory: categories => select({ message: 'Category', choices: categories }),
    selectField: fields => select({ message: 'Setting', choices: fields.map(field => ({ name: field.label, value: field.key })) }),
    inputValue: async (field, current) => field.secret
      ? password({ message: field.key })
      : input({ message: field.key, default: typeof current === 'string' ? current : String(current ?? '') }),
    confirmSave: changes => confirm({
      message: `Save changes?\n${changes.map(change => `- ${change.key}: ${String(change.before)} -> ${String(change.after)}`).join('\n')}`,
      default: true,
    }),
    continueEditing: () => confirm({ message: 'Edit another setting?', default: false }),
  };
}

export async function runConfigUi(root: string, prompts: ConfigPrompts = createInquirerPrompts()) {
  const categories = [...new Set(CONFIG_FIELDS.map(field => field.category))];
  const changes: Array<ConfigChange & { raw: string }> = [];

  do {
    const category = await prompts.selectCategory(categories);
    const fields = CONFIG_FIELDS.filter(field => field.category === category as ConfigCategory);
    const views = await Promise.all(fields.map(async field => fieldView(field, await getConfigValue(root, field.key))));
    const key = await prompts.selectField(views);
    const field = getConfigField(key);
    const view = views.find(candidate => candidate.key === key)!;
    const raw = await prompts.inputValue(view, view.current);
    const parsed = field.parse(raw);
    changes.push({
      key,
      before: field.secret ? '********' : view.current,
      after: field.secret ? '********' : parsed,
      raw,
    });
  } while (await prompts.continueEditing());

  const visibleChanges = changes.map(({ raw: _raw, ...change }) => change);
  if (!(await prompts.confirmSave(visibleChanges))) return { saved: false, changes: visibleChanges };

  for (const change of changes) await setConfigValue(root, change.key, change.raw);
  return { saved: true, changes: visibleChanges };
}
