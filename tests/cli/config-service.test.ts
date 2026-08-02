import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';
import { resolveVectorProfile } from '../../src/core/vector-profile.js';
import { CONFIG_FIELDS } from '../../src/cli/config/schema.js';
import { getConfigValue, resetConfigValue, setConfigValue, setConfigValues } from '../../src/cli/config/service.js';
import { CONFIG_UI_QUIT, CONFIG_UI_SAVE, ConfigFieldView, ConfigPrompts, modelChoices, presetChoices, runConfigUi } from '../../src/cli/config/ui.js';

const ROOT = path.resolve('.knowl-config-service-test');

afterEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

async function writeConfig(value = DEFAULT_CONFIG) {
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, '.knowl', 'config.json'),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

describe('config defaults', () => {
  it('enables local vector search by default', () => {
    expect(DEFAULT_CONFIG.search?.vector).toEqual({
      enabled: true,
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    });
  });

  it('preserves an explicit vector opt-out during upgrade', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { vector: { enabled: false } },
    }));

    await upgradeConfigDefaults(ROOT);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.enabled).toBe(false);
    expect(saved.search.vector.provider).toBe('local');
  });
});

describe('preset defaults', () => {
  it('keeps preset out of the upgrade merge baseline', () => {
    expect((DEFAULT_CONFIG.search?.vector as Record<string, unknown>).preset).toBeUndefined();
  });

  it('defaults new projects to the English Granite preset', () => {
    expect((NEW_PROJECT_CONFIG.search?.vector as Record<string, unknown>).preset)
      .toBe('granite-small-en-r2');
  });

  it('does not add a preset to an existing repository on upgrade', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' } },
    }));

    await upgradeConfigDefaults(ROOT);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.preset).toBeUndefined();
    expect(saved.search.vector.model).toBe('Xenova/all-MiniLM-L6-v2');
  });
});

describe('config service', () => {
  it('gets and validates known keys', async () => {
    await writeConfig();
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(true);
    await expect(getConfigValue(ROOT, 'search.unknown')).rejects.toThrow('Unknown config key');
  });

  it('sets typed values and creates a backup', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'search.vector.enabled', 'false');
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
    await expect(fs.access(path.join(ROOT, '.knowl', 'config.json.backup'))).resolves.toBeUndefined();
  });

  it('configures optional namespace paths without storing credentials', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'memory.organization.enabled', 'true');
    await setConfigValue(ROOT, 'memory.organization.path', 'D:/knowl/org.db');
    expect(await getConfigValue(ROOT, 'memory.organization.enabled')).toBe(true);
    expect(await getConfigValue(ROOT, 'memory.organization.path')).toBe('D:/knowl/org.db');
  });

  it('rejects invalid enum values', async () => {
    await writeConfig();
    await expect(setConfigValue(ROOT, 'search.vector.dtype', 'q2')).rejects.toThrow('Expected one of');
  });

  it('resets one key to its default', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'security.rejectSecrets', 'false');
    await resetConfigValue(ROOT, 'security.rejectSecrets');
    expect(await getConfigValue(ROOT, 'security.rejectSecrets')).toBe(true);
  });

  it('preserves env placeholders and redacts API keys', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      ai: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${OPENAI_API_KEY}' },
    });
    await setConfigValue(ROOT, 'search.vector.enabled', 'false');
    const raw = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(raw.ai.apiKey).toBe('${OPENAI_API_KEY}');
    expect(await getConfigValue(ROOT, 'ai.apiKey')).toBe('********');
  });
});

describe('setConfigValues', () => {
  it('writes every entry in one save', async () => {
    await writeConfig();
    await setConfigValues(ROOT, [
      { key: 'search.vector.preset', raw: 'custom' },
      { key: 'search.vector.model', raw: 'someone/theirs-ONNX' },
      { key: 'search.vector.pooling', raw: 'cls' },
    ]);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'custom', model: 'someone/theirs-ONNX', pooling: 'cls',
    });
  });

  it('persists nothing when any entry is invalid', async () => {
    await writeConfig();
    await expect(setConfigValues(ROOT, [
      { key: 'search.vector.preset', raw: 'custom' },
      { key: 'search.vector.pooling', raw: 'banana' },
    ])).rejects.toThrow(/Expected one of/);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.preset).toBeUndefined();
  });
});


/**
 * The shape a repository initialised before presets existed still has on disk: no
 * `preset` key at all. Every preset-aware behaviour has to work from the model string
 * alone here, which is the case an earlier build of this UI silently did nothing for.
 */
const PRE_PRESET_CONFIG = {
  version: 1,
  security: { rejectSecrets: false, secretPatterns: [] },
  search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' } },
} as unknown as typeof DEFAULT_CONFIG;

/** Drives the list: answer each visit in turn, then finish. */
function driver(steps: Array<{ pick: string; value?: string | null }>, finish = CONFIG_UI_SAVE) {
  let visit = 0;
  const seen: ConfigFieldView[][] = [];
  const prompts: ConfigPrompts = {
    selectSetting: async fields => {
      seen.push(fields);
      const step = steps[visit++];
      return step ? step.pick : finish;
    },
    inputValue: async () => {
      const step = steps[visit - 1];
      return step?.value === undefined ? null : step.value;
    },
    confirmSave: async () => true,
  };
  return { prompts, listAt: (index: number) => seen[index] };
}

describe('config UI', () => {
  it('lists every setting in one list, with no level to descend into', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const { prompts, listAt } = driver([]);
    await runConfigUi(ROOT, prompts);

    const keys = listAt(0).map(field => field.key);
    expect(keys).toEqual(CONFIG_FIELDS.map(field => field.key));
    // The two that used to be buried a level down.
    expect(keys).toContain('search.vector.dtype');
    expect(keys).toContain('memory.global.path');
  });

  it('shows what each setting is now, and names the model rather than its id', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const { prompts, listAt } = driver([]);
    await runConfigUi(ROOT, prompts);

    const byKey = (key: string) => listAt(0).find(field => field.key === key)!;
    expect(byKey('search.vector.preset').currentText).toContain('MiniLM L6 v2');
    expect(byKey('search.vector.preset').currentText).not.toContain('minilm-l6-en');
    expect(byKey('search.vector.enabled').currentText).toBe('on');
    expect(byKey('search.vector.cacheDir').currentText).toBe('not set');
  });

  it('opens an editor for every setting, refusing none', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);

    const opened: string[] = [];
    let visit = 0;
    const keys = CONFIG_FIELDS.map(field => field.key);
    await runConfigUi(ROOT, {
      selectSetting: async () => (visit < keys.length ? keys[visit++] : CONFIG_UI_QUIT),
      inputValue: async field => { opened.push(field.key); return null; },
      confirmSave: async () => false,
    });

    expect(opened).toEqual(keys);
  });

  it('reflects an edit in the list before anything is written', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const { prompts, listAt } = driver([{ pick: 'search.vector.enabled', value: 'false' }]);
    await runConfigUi(ROOT, prompts);

    // First visit is the file; the second already shows the queued edit and marks it.
    expect(listAt(0).find(field => field.key === 'search.vector.enabled')?.currentText).toBe('on');
    const after = listAt(1).find(field => field.key === 'search.vector.enabled')!;
    expect(after.currentText).toBe('off');
    expect(after.pending).toBe(true);
  });

  it('discards everything when the list is quit', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.enabled' : CONFIG_UI_QUIT),
      inputValue: async () => 'false',
      confirmSave: async () => { throw new Error('quitting must not ask about saving'); },
    });

    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('backing out of a value prompt queues nothing and returns to the list', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    let visits = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visits++ === 0 ? 'search.vector.cacheDir' : CONFIG_UI_SAVE),
      inputValue: async () => null,
      confirmSave: async () => { throw new Error('an empty diff must not be confirmed'); },
    });

    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(visits).toBe(2);
  });

  it('does not save when the confirmation is declined', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.enabled' : CONFIG_UI_SAVE),
      inputValue: async () => 'false',
      confirmSave: async () => false,
    });

    expect(result.saved).toBe(false);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('re-prompts after an unparseable value instead of throwing', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const attempts: string[] = [];
    const reported: string[] = [];
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.dtype' : CONFIG_UI_SAVE),
      inputValue: async () => { attempts.push('asked'); return attempts.length === 1 ? 'q2' : 'fp16'; },
      confirmSave: async () => true,
      reportError: async (_field, message) => { reported.push(message); },
    });

    expect(attempts).toHaveLength(2);
    expect(reported[0]).toMatch(/Expected one of/);
    expect(result.saved).toBe(true);
    expect(await getConfigValue(ROOT, 'search.vector.dtype')).toBe('fp16');
  });

  it('collects several edits and writes them in one save', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const { prompts } = driver([
      { pick: 'search.vector.enabled', value: 'false' },
      { pick: 'security.rejectSecrets', value: 'true' },
    ]);
    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    expect(result.changes.map(change => change.key))
      .toEqual(['search.vector.enabled', 'security.rejectSecrets']);
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
    expect(await getConfigValue(ROOT, 'security.rejectSecrets')).toBe(true);
  });

  it('picking a model writes the whole profile, repairing a config with no preset key', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const { prompts } = driver([{ pick: 'search.vector.preset', value: 'granite-small-en-r2' }]);
    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'granite-small-en-r2',
      model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
      dtype: 'q8',
      pooling: 'cls',
    });
  });

  it('editing a preset-supplied field takes effect by moving to a custom profile', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);
    const { prompts } = driver([{ pick: 'search.vector.dtype', value: 'fp16' }]);
    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'custom', model: 'Xenova/bge-small-en-v1.5', pooling: 'cls', dtype: 'fp16',
    });
    // The point of the exercise: the edit is what the resolver now reads.
    expect(resolveVectorProfile(saved).dtype).toBe('fp16');
  });

  it('opens a preset-supplied field on the value in effect, not the stale stored one', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);
    let offered: unknown;
    let visit = 0;
    await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.pooling' : CONFIG_UI_QUIT),
      inputValue: async field => { offered = field.current; return null; },
      confirmSave: async () => false,
    });

    // pooling is absent from the file; bge-small-en supplies cls.
    expect(offered).toBe('cls');
  });

  it('writes model and pooling alongside a custom preset, in one save', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.preset' : CONFIG_UI_SAVE),
      inputValue: async () => 'custom',
      inputCustomModel: async () => ({ model: 'someone/theirs-ONNX', pooling: 'cls' }),
      confirmSave: async () => true,
    });

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'custom', model: 'someone/theirs-ONNX', pooling: 'cls',
    });
  });

  it('queues nothing when the custom model prompt is cancelled', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let asked = 0;
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.preset' : CONFIG_UI_SAVE),
      inputValue: async () => 'custom',
      inputCustomModel: async () => { asked += 1; return null; },
      confirmSave: async () => { throw new Error('an empty diff must not be confirmed'); },
    });

    expect(asked).toBe(1);
    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('redacts secret values in the confirmation diff', async () => {
    await writeConfig({ ...DEFAULT_CONFIG, ai: { provider: 'openai', model: 'gpt-4o-mini' } });
    let displayed: unknown;
    let visit = 0;
    await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'ai.apiKey' : CONFIG_UI_SAVE),
      inputValue: async () => 'super-secret',
      confirmSave: async changes => { displayed = changes; return false; },
    });

    expect(JSON.stringify(displayed)).not.toContain('super-secret');
    expect(JSON.stringify(displayed)).toContain('********');
  });

  it('offers a reindex when the save moved the embedding profile', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    let offered = false;
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.preset' : CONFIG_UI_SAVE),
      inputValue: async () => 'bge-small-en',
      confirmSave: async () => true,
      confirmReindex: async () => { offered = true; return true; },
    });

    expect(result.saved).toBe(true);
    expect(offered).toBe(true);
    expect(result.reindexRequested).toBe(true);
  });

  it('does not offer a reindex for an edit that leaves the profile alone', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    let offered = false;
    let visit = 0;
    const result = await runConfigUi(ROOT, {
      selectSetting: async () => (visit++ === 0 ? 'search.vector.cacheDir' : CONFIG_UI_SAVE),
      inputValue: async () => 'D:/models',
      confirmSave: async () => true,
      confirmReindex: async () => { offered = true; return true; },
    });

    expect(result.saved).toBe(true);
    expect(offered).toBe(false);
  });
});

describe('config UI choices', () => {
  it('offers models by name with size and language, marking the current one', () => {
    const choices = presetChoices('minilm-l6-en');

    const multilingual = choices.find(choice => choice.value === 'granite-97m-multilingual')!;
    expect(multilingual.label).toBe('Granite 97M Multilingual R2');
    expect(multilingual.hint).toContain('98 MB');
    expect(multilingual.hint).toContain('200+ languages');
    expect(choices.find(choice => choice.value === 'minilm-l6-en')?.hint).toContain('current');
    expect(choices.find(choice => choice.value === 'bge-small-en')?.hint).not.toContain('current');
    // No internal ids on show, and custom is reachable.
    expect(choices.every(choice => !choice.label.includes('-'))).toBe(true);
    expect(choices.some(choice => choice.value === 'custom')).toBe(true);
  });

  it('offers the known model ids for the raw model key', () => {
    const choices = modelChoices();
    expect(choices.map(choice => choice.value)).toContain('Xenova/bge-small-en-v1.5');
    expect(choices.every(choice => choice.hint.includes('MB'))).toBe(true);
  });
});
