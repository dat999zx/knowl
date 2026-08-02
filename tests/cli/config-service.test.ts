import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';
import { getConfigValue, resetConfigValue, setConfigValue, setConfigValues } from '../../src/cli/config/service.js';
import { CONFIG_UI_ADVANCED, CONFIG_UI_BACK, CONFIG_UI_QUIT, ConfigFieldView, ConfigPrompts, presetChoices, runConfigUi } from '../../src/cli/config/ui.js';

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

describe('config UI', () => {
  it('edits a selected field and confirms the diff', async () => {
    await writeConfig();
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.enabled',
      inputValue: async () => 'false',
      confirmSave: async changes => changes[0]?.key === 'search.vector.enabled',
      continueEditing: async () => false,
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
  });

  it('does not save when confirmation is rejected', async () => {
    await writeConfig();
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.enabled',
      inputValue: async () => 'false',
      confirmSave: async () => false,
      continueEditing: async () => false,
    };
    expect((await runConfigUi(ROOT, prompts)).saved).toBe(false);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('quits from the category list without asking about an empty diff', async () => {
    await writeConfig();
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let confirmCalled = false;
    const prompts: ConfigPrompts = {
      selectCategory: async () => CONFIG_UI_QUIT,
      selectField: async () => { throw new Error('should not reach field selection'); },
      inputValue: async () => { throw new Error('should not reach value entry'); },
      confirmSave: async () => { confirmCalled = true; return true; },
      continueEditing: async () => false,
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(confirmCalled).toBe(false);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('goes back to the category list instead of forcing an edit', async () => {
    await writeConfig();
    const categoriesSeen: string[] = [];
    let fieldPrompts = 0;
    const prompts: ConfigPrompts = {
      // Enter Search, back out, then quit. Entering a category used to commit you to
      // changing something in it.
      selectCategory: async () => {
        categoriesSeen.push('asked');
        return categoriesSeen.length === 1 ? 'Search' : CONFIG_UI_QUIT;
      },
      selectField: async () => { fieldPrompts += 1; return CONFIG_UI_BACK; },
      inputValue: async () => { throw new Error('should not reach value entry'); },
      confirmSave: async () => true,
      continueEditing: async () => false,
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(fieldPrompts).toBe(1);
    expect(categoriesSeen).toHaveLength(2);
    expect(result.saved).toBe(false);
  });

  it('re-prompts after an unparseable value instead of throwing', async () => {
    await writeConfig();
    const attempts: string[] = [];
    const reported: string[] = [];
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.enabled',
      inputValue: async () => {
        attempts.push('asked');
        return attempts.length === 1 ? 'yes' : 'false';
      },
      confirmSave: async () => true,
      continueEditing: async () => false,
      reportError: async (_field, message) => { reported.push(message); },
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(attempts).toHaveLength(2);
    expect(reported[0]).toMatch(/true or false/i);
    expect(result.saved).toBe(true);
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
  });

  it('exposes type metadata so values can be picked rather than typed', async () => {
    await writeConfig();
    let main: ConfigFieldView[] = [];
    let advanced: ConfigFieldView[] = [];
    let done = false;
    await runConfigUi(ROOT, {
      selectCategory: async () => (done ? CONFIG_UI_QUIT : 'Search'),
      selectField: async (fields, options) => {
        // Quantization is an advanced setting, so reaching it means opening that list.
        if (options?.advanced) { advanced = fields; done = true; return CONFIG_UI_BACK; }
        main = fields;
        // Backing out of advanced returns here, so stop asking for it once captured.
        return done ? CONFIG_UI_BACK : CONFIG_UI_ADVANCED;
      },
      inputValue: async () => '',
      confirmSave: async () => false,
      continueEditing: async () => false,
    });

    expect(main.find(field => field.key === 'search.vector.enabled')?.type).toBe('boolean');
    const dtype = advanced.find(field => field.key === 'search.vector.dtype');
    expect(dtype?.type).toBe('enum');
    expect(dtype?.values).toEqual(['q4', 'q8', 'fp16', 'fp32']);
  });

  it('writes model and pooling alongside a custom preset, in one save', async () => {
    await writeConfig();
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.preset',
      inputValue: async () => 'custom',
      inputCustomModel: async () => ({ model: 'someone/theirs-ONNX', pooling: 'cls' }),
      confirmSave: async () => true,
      continueEditing: async () => false,
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'custom', model: 'someone/theirs-ONNX', pooling: 'cls',
    });
  });

  it('writes nothing when the custom model prompt is cancelled', async () => {
    await writeConfig();
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let asked = 0;
    const prompts: ConfigPrompts = {
      selectCategory: async () => (asked === 0 ? 'Search' : CONFIG_UI_QUIT),
      selectField: async () => 'search.vector.preset',
      inputValue: async () => 'custom',
      inputCustomModel: async () => { asked += 1; return null; },
      confirmSave: async () => true,
      continueEditing: async () => false,
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(asked).toBe(1);
    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('offers a reindex when the save moved the embedding profile', async () => {
    await writeConfig();
    let offered: { affected: number } | null = null;
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.preset',
      inputValue: async () => 'bge-small-en',
      confirmSave: async () => true,
      continueEditing: async () => false,
      confirmReindex: async (_change, affectedRows) => { offered = { affected: affectedRows }; return true; },
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    expect(offered).not.toBeNull();
    expect(result.reindexRequested).toBe(true);
  });

  it('does not offer a reindex for an edit that leaves the profile alone', async () => {
    await writeConfig();
    let offered = false;
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async () => 'search.vector.cacheDir',
      inputValue: async () => 'D:/models',
      confirmSave: async () => true,
      continueEditing: async () => false,
      confirmReindex: async () => { offered = true; return true; },
    };

    const result = await runConfigUi(ROOT, prompts);

    expect(result.saved).toBe(true);
    expect(offered).toBe(false);
    expect(result.reindexRequested).toBe(false);
  });

  it('redacts secret values in the confirmation diff', async () => {
    await writeConfig({ ...DEFAULT_CONFIG, ai: { provider: 'openai', model: 'gpt-4o-mini' } });
    let displayed: unknown;
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'AI provider',
      selectField: async () => 'ai.apiKey',
      inputValue: async () => 'super-secret',
      confirmSave: async changes => { displayed = changes; return false; },
      continueEditing: async () => false,
    };
    await runConfigUi(ROOT, prompts);
    expect(JSON.stringify(displayed)).not.toContain('super-secret');
    expect(JSON.stringify(displayed)).toContain('********');
  });
});

describe('config UI presentation', () => {
  /**
   * Enter a category, capture either the main or the advanced field list, then quit.
   * Advanced settings are one level in, so reaching them means answering the main list
   * with CONFIG_UI_ADVANCED first.
   */
  async function viewsForCategory(category: string, advanced = false): Promise<ConfigFieldView[]> {
    let seen: ConfigFieldView[] = [];
    let asked = 0;
    await runConfigUi(ROOT, {
      selectCategory: async () => (asked++ === 0 ? category : CONFIG_UI_QUIT),
      selectField: async (fields, options) => {
        // Back out of the advanced list lands on the main one, so this must ask for
        // advanced only until it has what it came for, or the two bounce forever.
        if (advanced && !options?.advanced) {
          return seen.length ? CONFIG_UI_BACK : CONFIG_UI_ADVANCED;
        }
        seen = fields;
        return CONFIG_UI_BACK;
      },
      inputValue: async () => { throw new Error('should not reach value entry'); },
      confirmSave: async () => false,
      continueEditing: async () => false,
    });
    return seen;
  }

  it('names every setting and explains it, while still carrying the dotted key', async () => {
    await writeConfig();
    const views = await viewsForCategory('Search');

    const preset = views.find(field => field.key === 'search.vector.preset')!;
    expect(preset.label).toBe('Embedding model');
    expect(preset.description).toMatch(/384-dimension/);
    // The key stays available: it is what `knowl config set` takes.
    expect(views.every(field => field.key.includes('.'))).toBe(true);
    expect(views.every(field => field.label.length > 0 && !field.label.includes('.'))).toBe(true);
  });

  it('renders the preset as its readable name rather than the internal id', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'granite-97m-multilingual' } },
    } as typeof DEFAULT_CONFIG);
    const views = await viewsForCategory('Search');

    const preset = views.find(field => field.key === 'search.vector.preset')!;
    expect(preset.currentText).toContain('Granite 97M Multilingual');
    expect(preset.currentText).toContain('98 MB');
    expect(preset.currentText).not.toBe('granite-97m-multilingual');
  });

  it('marks the fields a named preset owns, and releases them under custom', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);
    const owned = await viewsForCategory('Search', true);

    for (const key of ['search.vector.model', 'search.vector.dtype', 'search.vector.pooling']) {
      expect(owned.find(field => field.key === key)?.ownedBy?.key).toBe('search.vector.preset');
    }
    // The preset itself stays in the main list, and is never owned.
    const main = await viewsForCategory('Search');
    expect(main.find(field => field.key === 'search.vector.preset')?.ownedBy).toBeUndefined();

    await fs.rm(ROOT, { recursive: true, force: true });
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'custom' } },
    } as typeof DEFAULT_CONFIG);
    const free = await viewsForCategory('Search', true);

    // `custom` names no model of its own, so the flat keys are the only thing to edit.
    expect(free.find(field => field.key === 'search.vector.model')?.ownedBy).toBeUndefined();
    expect(free.find(field => field.key === 'search.vector.pooling')?.ownedBy).toBeUndefined();
  });

  it('marks a value that differs from its default, and leaves a default value unmarked', async () => {
    // Only rejectSecrets is moved off its default; the pattern list is left as shipped.
    await writeConfig({
      ...DEFAULT_CONFIG,
      security: { rejectSecrets: false, secretPatterns: DEFAULT_CONFIG.security.secretPatterns },
    });
    const views = await viewsForCategory('Security');

    expect(views.find(field => field.key === 'security.rejectSecrets')?.modified).toBe(true);
    expect(views.find(field => field.key === 'security.secretPatterns')?.modified).toBe(false);
  });

  it('offers the owning setting instead of editing a field the preset controls', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);
    let edited: string | undefined;
    let asked = 0;
    const result = await runConfigUi(ROOT, {
      selectCategory: async () => (asked++ === 0 ? 'Search' : CONFIG_UI_QUIT),
      selectField: async () => 'search.vector.dtype',
      // Accepting the offer must redirect the edit to the preset, not the dtype.
      openOwner: async () => true,
      inputValue: async field => { edited = field.key; return 'minilm-l6-en'; },
      confirmSave: async () => true,
      continueEditing: async () => false,
    });

    expect(edited).toBe('search.vector.preset');
    // Picking a model writes the whole profile, so the flat keys cannot be left
    // describing the model that came before.
    expect(result.changes.map(change => change.key)).toEqual([
      'search.vector.preset', 'search.vector.model', 'search.vector.dtype', 'search.vector.pooling',
    ]);
    expect(await getConfigValue(ROOT, 'search.vector.preset')).toBe('minilm-l6-en');
    expect(await getConfigValue(ROOT, 'search.vector.model')).toBe('Xenova/all-MiniLM-L6-v2');
    expect(await getConfigValue(ROOT, 'search.vector.pooling')).toBe('mean');
  });

  it('writes nothing when the owner offer is declined', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search!.vector, preset: 'bge-small-en' } },
    } as typeof DEFAULT_CONFIG);
    let asked = 0;
    const result = await runConfigUi(ROOT, {
      selectCategory: async () => (asked++ === 0 ? 'Search' : CONFIG_UI_QUIT),
      selectField: async () => 'search.vector.model',
      openOwner: async () => false,
      inputValue: async () => { throw new Error('a preset-owned field must not open an editor'); },
      confirmSave: async () => true,
      continueEditing: async () => false,
    });

    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('cancelling a value prompt queues no change and returns to the setting list', async () => {
    await writeConfig();
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    let fieldPrompts = 0;
    let confirmCalled = false;
    let asked = 0;
    const result = await runConfigUi(ROOT, {
      selectCategory: async () => (asked++ === 0 ? 'Search' : CONFIG_UI_QUIT),
      selectField: async () => { fieldPrompts += 1; return 'search.vector.cacheDir'; },
      inputValue: async () => null,
      confirmSave: async () => { confirmCalled = true; return true; },
      continueEditing: async () => false,
    });

    expect(result.saved).toBe(false);
    expect(result.changes).toEqual([]);
    // Cancelling returns to the list rather than ending the session outright.
    expect(fieldPrompts).toBe(1);
    expect(confirmCalled).toBe(false);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('shows what an owned field is actually running, not the stale stored value', async () => {
    // The flat keys still hold MiniLM from before the preset was introduced.
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: {
        vector: {
          ...DEFAULT_CONFIG.search!.vector,
          preset: 'granite-small-en-r2',
          model: 'Xenova/all-MiniLM-L6-v2',
        },
      },
    } as typeof DEFAULT_CONFIG);
    const views = await viewsForCategory('Search', true);

    const model = views.find(field => field.key === 'search.vector.model')!;
    expect(model.currentText).toContain('granite');
    expect(model.currentText).not.toContain('MiniLM');
    // Pooling is absent from the file entirely; the preset is what decides it.
    expect(views.find(field => field.key === 'search.vector.pooling')?.currentText).toBe('cls');
    // A preset's doing is not someone's edit.
    expect(model.modified).toBe(false);
  });

  it('shows the default for an unwritten setting and does not call it modified', async () => {
    await writeConfig();
    const views = await viewsForCategory('Memory namespaces');

    const organization = views.find(field => field.key === 'memory.organization.enabled')!;
    expect(organization.currentText).toBe('off');
    expect(organization.modified).toBe(false);
  });

  it('never marks a secret modified, since it always reads back redacted', async () => {
    await writeConfig();
    const views = await viewsForCategory('AI provider');

    const apiKey = views.find(field => field.key === 'ai.apiKey')!;
    expect(apiKey.currentText).toBe('********');
    expect(apiKey.modified).toBe(false);
  });

  /**
   * The shape a repository initialised before presets existed still has on disk: no
   * `preset` key at all. Every preset-aware behaviour has to work from the model string
   * alone here, which is the case the first version of this UI silently did nothing for.
   */
  const PRE_PRESET_CONFIG = {
    version: 1,
    security: { rejectSecrets: false, secretPatterns: [] },
    search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' } },
  } as unknown as typeof DEFAULT_CONFIG;

  it('keeps a category list to the settings people open it to change', async () => {
    await writeConfig(PRE_PRESET_CONFIG);

    expect((await viewsForCategory('Search')).map(field => field.label))
      .toEqual(['Embedding model', 'Semantic search']);
    // The internals are still reachable, one level in.
    expect((await viewsForCategory('Search', true)).map(field => field.key)).toEqual([
      'search.vector.provider', 'search.vector.model',
      'search.vector.dtype', 'search.vector.pooling', 'search.vector.cacheDir',
    ]);
  });

  it('identifies the running model from its model string when no preset key exists', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    const views = await viewsForCategory('Search');

    const model = views.find(field => field.key === 'search.vector.preset')!;
    expect(model.currentText).toContain('MiniLM');
    // Nothing owns the flat keys here: with no preset, they are the real values.
    const advanced = await viewsForCategory('Search', true);
    expect(advanced.find(field => field.key === 'search.vector.model')?.ownedBy).toBeUndefined();
  });

  it('marks the running model as current in the picker', () => {
    const choices = presetChoices('minilm-l6-en');
    expect(choices.find(choice => choice.value === 'minilm-l6-en')?.description).toContain('current');
    expect(choices.find(choice => choice.value === 'bge-small-en')?.description).not.toContain('current');
  });

  it('picking a model repairs a config that has no preset key', async () => {
    await writeConfig(PRE_PRESET_CONFIG);
    let asked = 0;
    const result = await runConfigUi(ROOT, {
      selectCategory: async () => (asked++ === 0 ? 'Search' : CONFIG_UI_QUIT),
      selectField: async () => 'search.vector.preset',
      inputValue: async () => 'granite-small-en-r2',
      confirmSave: async () => true,
      continueEditing: async () => false,
    });

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'granite-small-en-r2',
      model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
      dtype: 'q8',
      pooling: 'cls',
    });
  });

  it('builds preset choices carrying size and language, with a way back', () => {
    const choices = presetChoices();

    const multilingual = choices.find(choice => choice.value === 'granite-97m-multilingual')!;
    expect(multilingual.name).toBe('Granite 97M Multilingual R2');
    expect(multilingual.description).toContain('98 MB');
    expect(multilingual.description).toContain('200+ languages');
    // No raw ids on show, and both escape hatches present. The two action rows are
    // matched loosely because their symbols fall back to ASCII on a plain terminal.
    expect(choices.every(choice => !choice.name.includes('-'))).toBe(true);
    expect(choices.some(choice => choice.name.startsWith('Custom model'))).toBe(true);
    expect(choices[choices.length - 1].name).toContain('Back');
    expect(choices[choices.length - 1].value).toBe('__knowl_value_cancel__');
  });
});
