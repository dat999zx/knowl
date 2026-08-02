import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';
import { getConfigValue, resetConfigValue, setConfigValue, setConfigValues } from '../../src/cli/config/service.js';
import { CONFIG_UI_BACK, CONFIG_UI_QUIT, ConfigFieldView, ConfigPrompts, runConfigUi } from '../../src/cli/config/ui.js';

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
    let seen: ConfigFieldView[] = [];
    const prompts: ConfigPrompts = {
      selectCategory: async () => 'Search',
      selectField: async fields => { seen = fields; return CONFIG_UI_BACK; },
      inputValue: async () => '',
      confirmSave: async () => false,
      continueEditing: async () => false,
    };
    await runConfigUi(ROOT, { ...prompts, selectCategory: async () => seen.length ? CONFIG_UI_QUIT : 'Search' });

    expect(seen.find(field => field.key === 'search.vector.enabled')?.type).toBe('boolean');
    const dtype = seen.find(field => field.key === 'search.vector.dtype');
    expect(dtype?.type).toBe('enum');
    expect(dtype?.values).toEqual(['q4', 'q8', 'fp16', 'fp32']);
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
