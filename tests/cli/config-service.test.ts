import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';
import { getConfigValue, resetConfigValue, setConfigValue } from '../../src/cli/config/service.js';

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
