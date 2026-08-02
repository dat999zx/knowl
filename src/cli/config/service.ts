import fs from 'node:fs/promises';
import path from 'node:path';
import { NEW_PROJECT_CONFIG, saveConfig } from '../../core/config.js';
import { ProjectConfig } from '../../core/types.js';
import { getConfigField } from './schema.js';

type ConfigRecord = Record<string, unknown>;

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
    const next = current?.[part];
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
  await saveRawConfig(root, structuredClone(NEW_PROJECT_CONFIG) as ConfigRecord);
}
