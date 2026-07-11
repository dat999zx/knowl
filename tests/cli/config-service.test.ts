import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';
import { getConfigValue, resetConfigValue, setConfigValue } from '../../src/cli/config/service.js';
import { ConfigPrompts, runConfigUi } from '../../src/cli/config/ui.js';

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
