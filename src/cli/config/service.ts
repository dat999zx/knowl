import fs from 'node:fs/promises';
import path from 'node:path';
import { NEW_PROJECT_CONFIG, saveConfig } from '../../core/config.js';
import { ProjectConfig } from '../../core/types.js';
import { getConfigField } from './schema.js';

/**
 * The config exactly as it sits on disk.
 *
 * `Partial`, because nothing here validates the file against `ProjectConfig` -- a config
 * written by an older build, or by hand, may be missing keys this one calls required.
 * `Record<string, unknown>` on top, because keys this build has never heard of have to
 * survive being edited: every write is a keyed edit of the parsed file, not a
 * re-serialisation of a `ProjectConfig`, so anything it does not recognise is carried
 * through untouched rather than dropped.
 */
type ConfigRecord = Partial<ProjectConfig> & Record<string, unknown>;

function getAtPath(config: ConfigRecord, key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as ConfigRecord)[segment];
  }, config);
}

function setAtPath(config: ConfigRecord, key: string, value: unknown) {
  const parts = key.split('.');
  let current = config;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[part] = {};
    current = current[part] as ConfigRecord;
  }
  current[parts.at(-1)!] = value;
}

function deleteAtPath(config: ConfigRecord, key: string) {
  const parts = key.split('.');
  let current: ConfigRecord | undefined = config;
  for (const part of parts.slice(0, -1)) {
    const next: unknown = current?.[part];
    current = next && typeof next === 'object' && !Array.isArray(next) ? next as ConfigRecord : undefined;
  }
  if (current) delete current[parts.at(-1)!];
}

function configPath(root: string) {
  return path.join(root, '.knowl', 'config.json');
}

async function loadRawConfig(root: string): Promise<ConfigRecord> {
  return JSON.parse(await fs.readFile(configPath(root), 'utf8')) as ConfigRecord;
}

async function backupConfig(root: string) {
  const source = configPath(root);
  await fs.copyFile(source, `${source}.backup`);
}

/**
 * `saveConfig` asks for a whole `ProjectConfig`; what it does with one is read `ai.apiKey`
 * optionally and serialise the rest. So an incomplete record is safe to hand it, and has to
 * be: filling in the missing keys here would turn every `knowl config set` into a silent
 * upgrade of the file, which is `upgradeConfigDefaults`'s job and no one else's.
 */
async function saveRawConfig(root: string, config: ConfigRecord) {
  await saveConfig(root, config as ProjectConfig);
}

export async function getConfigValue(root: string, key: string): Promise<unknown> {
  const field = getConfigField(key);
  if (field.secret) return '********';
  return getAtPath(await loadRawConfig(root), key);
}

export async function setConfigValue(root: string, key: string, raw: string): Promise<unknown> {
  const field = getConfigField(key);
  const config = await loadRawConfig(root);
  const value = field.parse(raw);
  setAtPath(config, key, value);
  await backupConfig(root);
  await saveRawConfig(root, config);
  return value;
}

/**
 * Write several keys as one unit.
 *
 * A custom embedding profile is three keys, and writing them one at a time can
 * leave `preset: custom` on disk with no verified model beside it -- a state any
 * command running in between would resolve and act on. Every entry is parsed
 * before anything is written, so an invalid one changes nothing.
 */
export async function setConfigValues(
  root: string,
  entries: Array<{ key: string; raw: string }>,
): Promise<void> {
  const parsed = entries.map(entry => ({
    key: entry.key,
    value: getConfigField(entry.key).parse(entry.raw),
  }));

  const config = await loadRawConfig(root);
  for (const entry of parsed) setAtPath(config, entry.key, entry.value);
  await backupConfig(root);
  await saveRawConfig(root, config);
}

export async function resetConfigValue(root: string, key: string): Promise<void> {
  const field = getConfigField(key);
  const config = await loadRawConfig(root);
  if (field.defaultValue === undefined) deleteAtPath(config, key);
  else setAtPath(config, key, structuredClone(field.defaultValue));
  await backupConfig(root);
  await saveRawConfig(root, config);
}

export async function resetAllConfig(root: string): Promise<void> {
  await backupConfig(root);
  // Already a ProjectConfig; there is no on-disk record to preserve here, only to replace.
  await saveConfig(root, structuredClone(NEW_PROJECT_CONFIG));
}
