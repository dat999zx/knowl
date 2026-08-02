import { existsSync } from 'node:fs';
import type { ProjectConfig } from '../../core/types.js';
import {
  VECTOR_PRESETS, fingerprintProfile, resolveVectorProfile, type VectorProfile,
} from '../../core/vector-profile.js';

/** The keys a named preset decides, and therefore overrides. */
const PRESET_SHADOWED_KEYS = new Set([
  'search.vector.model',
  'search.vector.dtype',
  'search.vector.pooling',
]);

export type ProfileChange = {
  changed: boolean;
  before: VectorProfile;
  after: VectorProfile;
};

/**
 * Compares resolved profiles rather than raw keys, so selecting a preset and
 * spelling out the same model by hand count as no change, while a dtype- or
 * pooling-only edit correctly counts as one.
 */
export function describeProfileChange(before: ProjectConfig, after: ProjectConfig): ProfileChange {
  const from = resolveVectorProfile(before);
  const to = resolveVectorProfile(after);
  return { changed: fingerprintProfile(from) !== fingerprintProfile(to), before: from, after: to };
}

/**
 * How many embedding rows the change affects.
 *
 * Opens and closes the database itself, and answers 0 on any failure: a config edit
 * must not fail because the store is unreadable, and the count only sizes a warning.
 */
export async function countAffectedEmbeddings(root: string): Promise<number> {
  try {
    const [{ initDb, closeDb }, { countStoredEmbeddings }, { resolveStorage }] = await Promise.all([
      import('../../store/database.js'),
      import('../../store/vector.js'),
      import('../../store/storage-roles.js'),
    ]);
    // Checked first because initDb bootstraps: counting rows must not be the thing that
    // creates a database in a repository that has none.
    if (!existsSync(resolveStorage(root).knowledge)) return 0;
    await initDb(root);
    try {
      return await countStoredEmbeddings();
    } finally {
      await closeDb();
    }
  } catch {
    return 0;
  }
}

/**
 * The extra lines a workspace member needs, or none.
 *
 * Federation breaking is a worse surprise than local degradation, and the fix is a
 * different command -- reindexing every repo would not help while the manifest still
 * pins the old model.
 */
export async function workspacePinNotice(root: string, after: ProjectConfig): Promise<string[]> {
  try {
    const [{ resolveWorkspace }, identity] = await Promise.all([
      import('../../workspace/resolve.js'),
      import('../../store/embedding-identity.js'),
    ]);
    const active = await resolveWorkspace(root, after).catch(() => null);
    if (!active) return [];
    const mine = identity.embeddingIdentityFromConfig(after);
    if (identity.sameEmbeddingIdentity(mine, active.manifest.embedding)) return [];

    return [
      '',
      `This repository is in workspace "${active.name}", which is pinned to `
      + `${identity.formatEmbeddingIdentity(active.manifest.embedding)}. Until they match, this repo's items and `
      + "its peers' items are invisible to each other.",
      'To move the whole workspace instead, run `knowl workspace repin-embedding`.',
    ];
  } catch {
    return [];
  }
}

/** Print the whole consequence of a profile change, or nothing when it did not change. */
export async function announceProfileChange(
  root: string,
  before: ProjectConfig,
  after: ProjectConfig,
  log: (message: string) => void = console.log,
): Promise<ProfileChange> {
  const change = describeProfileChange(before, after);
  if (!change.changed) return change;

  log('');
  log(formatProfileChangeWarning(change, await countAffectedEmbeddings(root)));
  for (const line of await workspacePinNotice(root, after)) log(line);
  return change;
}

/**
 * Say so when an edit lands on a key the active preset overrides.
 *
 * Setting `search.vector.model` was the only way to change models before presets existed,
 * and every repository `knowl init` creates now carries one -- so that command reports
 * success and changes nothing. `describeProfileChange` cannot cover this: it is silent
 * precisely because the resolved profile did not move, which is the problem.
 */
export function shadowedByPresetNotice(config: ProjectConfig, key: string): string[] {
  if (!PRESET_SHADOWED_KEYS.has(key)) return [];

  const preset = (config?.search?.vector as Record<string, unknown> | undefined)?.preset;
  // `custom` reads exactly these keys, and a config with no preset falls through to them
  // as well. Neither shadows anything, so neither earns a warning.
  if (typeof preset !== 'string' || !(preset in VECTOR_PRESETS)) return [];

  const profile = resolveVectorProfile(config);
  return [
    '',
    `Note: ${key} has no effect while search.vector.preset is "${preset}".`,
    'The preset decides model, dtype and pooling together, so this repository still embeds with '
    + `${profile.model} (${profile.dtype}, ${profile.pooling} pooling).`,
    'To use a model of your own, run `knowl config set-model <name>`.',
  ];
}

export function formatProfileChangeWarning(change: ProfileChange, affectedRows: number): string {
  return [
    `Embedding model changed: ${change.before.model} (${change.before.dtype}, ${change.before.pooling} pooling)`,
    `                     ->  ${change.after.model} (${change.after.dtype}, ${change.after.pooling} pooling)`,
    '',
    `${affectedRows} stored embedding(s) were written by the old profile and no longer match.`,
    'Vector search falls back to keyword-only results until you run:',
    '  knowl reindex --vectors',
  ].join('\n');
}
