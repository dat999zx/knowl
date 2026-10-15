import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { knowlHome } from '../../core/paths.js';
import type { ProjectConfig } from '../../core/types.js';
import { academicProfile } from './academic.js';
import { codeProfile } from './code.js';
import { generalProfile } from './general.js';
import type { DomainProfile } from './types.js';

const BUILT_IN: DomainProfile[] = [codeProfile, generalProfile, academicProfile];
export const BUILT_IN_PROFILES: Record<string, DomainProfile> = Object.fromEntries(BUILT_IN.map(p => [p.id, p]));

const PROFILE_ID = /^[a-z][a-z0-9-]*$/;

function profilesDir(): string {
  return path.join(knowlHome(), 'profiles');
}

/** File names in the user profile directory; none when it does not exist. */
function userEntries(): string[] {
  try {
    return fs.readdirSync(profilesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function userIds(): string[] {
  return userEntries()
    .filter(f => f.endsWith('.yaml') && PROFILE_ID.test(f.slice(0, -5)))
    .map(f => f.slice(0, -5))
    .filter(id => !Object.prototype.hasOwnProperty.call(BUILT_IN_PROFILES, id))
    .filter(id => {
      try {
        readUserProfile(id, `${id}.yaml`);
        return true;
      } catch {
        return false;
      }
    });
}

function optionalString(raw: Record<string, unknown>, field: string, file: string): string | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Domain profile ${file}: "${field}" must be a nonempty string.`);
  }
  return v;
}

function readUserProfile(id: string, entry: string): DomainProfile {
  const file = path.join(profilesDir(), entry);
  const doc = parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Domain profile ${entry}: expected a mapping of fields.`);
  }
  const raw = doc as Record<string, unknown>;
  if (raw.id !== undefined && raw.id !== id) {
    throw new Error(`Domain profile ${entry}: id "${String(raw.id)}" does not match the file name "${id}".`);
  }
  const filter = optionalString(raw, 'filter', entry);
  const extract = optionalString(raw, 'extract', entry);
  if (filter === undefined) throw new Error(`Domain profile ${entry}: "filter" is required.`);
  if (extract === undefined) throw new Error(`Domain profile ${entry}: "extract" is required.`);
  let deriveTruth: string | null = null;
  if (raw.deriveTruth !== null && raw.deriveTruth !== undefined) {
    deriveTruth = optionalString(raw, 'deriveTruth', entry) as string;
  }
  return {
    id,
    filter,
    extract,
    ask: optionalString(raw, 'ask', entry) ?? generalProfile.ask,
    deriveTruth,
    passDescription: optionalString(raw, 'passDescription', entry),
  };
}

/**
 * Resolves a domain profile by id: validate the id, then built-ins by own property,
 * then `<KNOWL_HOME>/profiles/<id>.yaml`. Throws for anything unknown.
 */
export function domainProfile(id: string): DomainProfile {
  const valid = PROFILE_ID.test(id);
  if (valid && Object.prototype.hasOwnProperty.call(BUILT_IN_PROFILES, id)) {
    return BUILT_IN_PROFILES[id];
  }
  if (valid) {
    const entry = userEntries().find(f => f === `${id}.yaml`);
    if (entry !== undefined) return readUserProfile(id, entry);
  }
  const available = [...Object.keys(BUILT_IN_PROFILES).sort(), ...(valid ? userIds().sort() : [])].join(', ');
  const hint = valid ? ` Add one as ${path.join(profilesDir(), `${id}.yaml`)}.` : '';
  throw new Error(`Unknown domain profile "${id}". Available: ${available}.${hint}`);
}

/** The profile governing a store: `ai.profile`, else `code` for a project and `general` for the global store. */
export function resolveDomainProfile(config?: ProjectConfig, store: 'project' | 'global' = 'project'): DomainProfile {
  return domainProfile(config?.ai?.profile ?? (store === 'global' ? 'general' : 'code'));
}
