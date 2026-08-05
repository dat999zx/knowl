import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSkillFilePath, validateSkillName } from '../skills/registry.js';
import { createKnowledgeCommit, listKnowledgeItems } from './repository.js';
import { listAssertions } from './assertions.js';
import { getClient } from './database.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { listEvidenceForItem } from './evidence-repository.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';
import { listTombstones } from './tombstones.js';
import { hashKnowledgeLifecycle } from './freshness.js';
import {
  classifyIncomingItem,
  DEFAULT_DIVERGENCE_POLICY,
  DivergencePolicy,
  resolveDivergence,
} from './import-policy.js';
import type { CommitChange, KnowledgeItem } from '../core/types.js';

async function skillFiles(root: string, directory: string, base = directory): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await skillFiles(root, full, base));
    else if (entry.isFile()) files.push({ path: full.slice(base.length + 1).replace(/\\/g, '/'), content: await fs.readFile(full, 'utf8') });
  }
  return files;
}

/** Who wrote an export, as far as the writing store can prove it. */
export type ExportOrigin = { workspace: string; repo: string };

/**
 * The exporter's workspace identity, or null when it has none to give.
 *
 * `origin_repo` is a name, and a name only means something inside the workspace that issued
 * it. Without this, "server" in the file and "server" in the reading repo were the same
 * string and therefore the same owner -- which is how a stranger's export came to be treated
 * as the importer's own knowledge. An unlinked repo genuinely has no identity to declare, and
 * says so rather than guessing.
 *
 * Imported lazily so the store layer keeps no static dependency on the workspace layer, the
 * same reason `write-ownership` resolves it that way.
 */
async function exportOrigin(projectRoot?: string): Promise<ExportOrigin | null> {
  if (!projectRoot) return null;
  try {
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const active = await resolveWorkspace(projectRoot);
    return active ? { workspace: active.name, repo: active.repo } : null;
  } catch {
    return null; // a broken workspace makes the export anonymous, never unwritable
  }
}

export async function exportKnowledge(projectId: string, outputPath: string, projectRoot?: string) {
  const items = (await listKnowledgeItems()).sort((a, b) => a.id.localeCompare(b.id));
  const records: unknown[] = [{
    type: 'header', format: 'knowl-jsonl', version: EXPORT_FORMAT_VERSION, namespace: 'project',
    // Always emitted, null included: "this build knows about origin and there is none" is a
    // different fact from "this build predates origin", and only the first is safe to read as
    // an anonymous export rather than as an unknown one.
    origin: await exportOrigin(projectRoot),
  }];
  const seenEvidence = new Set<string>();
  for (const item of items) {
    records.push({ type: 'item', item });
    for (const assertion of await listAssertions(item.id)) records.push({ type: 'assertion', assertion });
    for (const evidence of await listEvidenceForItem(item.id)) {
      const { relationship, ...value } = evidence;
      if (!seenEvidence.has(value.id)) { records.push({ type: 'evidence', evidence: value }); seenEvidence.add(value.id); }
      records.push({ type: 'knowledge_evidence', link: { knowledgeItemId: item.id, evidenceId: value.id, relationship } });
    }
  }
  if (projectRoot) {
    const skillsDir = `${projectRoot}/.knowl/skills`;
    for (const entry of await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [] as any[])) {
      if (entry.isDirectory()) records.push({ type: 'skill_package', name: entry.name, files: await skillFiles(projectRoot, `${skillsDir}/${entry.name}`) });
    }
  }
  // Tombstones ride after the items so an older importer, which ignores unknown record
  // types, still reads a valid stream.
  const tombstones = await listTombstones();
  for (const tombstone of tombstones) records.push({ type: 'tombstone', tombstone });
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const manifest = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(outputPath, `${body}${JSON.stringify({ type: 'manifest', sha256: manifest })}\n`, 'utf8');
  return { items: items.length, tombstones: tombstones.length, sha256: manifest };
}

export type ImportResult = {
  inserted: number;
  identical: number;
  updated: number;
  keptLocal: number;
  deleted: number;
  conflicts: number;
  /**
   * Items a local tombstone refused to reinstate. Reported rather than folded into
   * `identical`, because "we already had it" and "we deliberately deleted it" are different
   * facts and only one of them means the export was stale.
   */
  blockedByTombstone: number;
  applied: boolean;
  divergent: Array<{ id: string; title: string; taken: 'incoming' | 'local' }>;
  /**
   * Whose knowledge this file was taken to be, and so whether its ownership and visibility
   * were honoured:
   * - `trusted`    the file names this repo's workspace, so its owners and visibility stand
   * - `claimed`    `--mine`: rows it introduced belong to this repo, at repo visibility
   * - `attributed` rows it introduced were stamped with the exporter's identity
   *
   * Reported because the stamping is otherwise invisible: a person importing a colleague's
   * dump would see only counts, and never learn that those rows are unpromotable here.
   */
  ownership: 'trusted' | 'claimed' | 'attributed';
  /** Present only on a dry run: what the counts WOULD have been. */
  wouldApply?: { inserted: number; identical: number; updated: number; keptLocal: number };
};

/**
 * The format this build writes, and the range it reads.
 *
 * Version 2 adds `origin_repo`, `visibility` and `lifecycle_hash`. Until then export emitted
 * all three -- it serialises whole item objects -- while import's column list omitted them, so
 * a round trip silently reset ownership to NULL and visibility to 'repo'. A reader that
 * accepted an unknown version would do the same thing to whatever the next version adds, which
 * is why the upper bound is enforced rather than assumed.
 *
 * Version 3 adds the header's `origin`: which workspace and repo wrote the file. Versions 1
 * and 2 carried owner names with nothing to say whose namespace those names belonged to, so
 * an imported row was indistinguishable from one this repo wrote itself -- and `join` claimed
 * it, `promote` published it, and there is no demote. A version-2 file is still read, but its
 * items are attributed to an unknown origin rather than to the importer.
 */
export const EXPORT_FORMAT_VERSION = 3;
const MIN_READABLE_FORMAT_VERSION = 1;

/**
 * Ownership marker for a row that arrived from a store this one cannot identify as itself.
 *
 * A repo name is `^[a-z0-9][a-z0-9-]*$`, so the colon makes this value unequal to every
 * possible repo name. That is what makes the whole workspace layer correct without changing
 * it: `backfillOriginRepo` claims `origin_repo IS NULL`, `promoteItems` selects `IS NULL OR
 * = me` and counts everything else as foreign, and `assertOwnedItem` refuses a non-null owner
 * that is not this repo. Each of those already does the right thing with a value that is
 * neither NULL nor a local name.
 */
const IMPORTED_ORIGIN_PREFIX = 'import:';

/** A version-1 or version-2 file, which names no exporter. Not NULL, because NULL means mine. */
export const UNKNOWN_IMPORT_ORIGIN = `${IMPORTED_ORIGIN_PREFIX}unknown`;

/** True for an owner stamped by import: a name no repo can hold and no repo can act on. */
export function isImportedOrigin(originRepo: string | null | undefined): boolean {
  return typeof originRepo === 'string' && originRepo.startsWith(IMPORTED_ORIGIN_PREFIX);
}

/**
 * What this repo will do with the file's ownership, decided once for the whole file.
 *
 * `null` means the file may be trusted verbatim. Otherwise `owner` is stamped on the rows the
 * file introduces -- which is the exporter's identity for a foreign file, and this repo's own
 * name (or NULL when it is in no workspace) when a person asserted the file is theirs.
 */
type ImportAttribution = { owner: string | null; reported: ImportResult['ownership'] } | null;

/** This repo's own name, or null when it is in no workspace and rows it writes hold NULL. */
async function localOwner(projectRoot?: string): Promise<string | null> {
  if (!projectRoot) return null;
  try {
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    return (await resolveWorkspace(projectRoot))?.repo ?? null;
  } catch {
    return null;
  }
}

/**
 * How to attribute this file: trust it, claim it, or stamp it.
 *
 * Trust is exactly one thing: the file declares a workspace and it is this repo's workspace.
 * Then its owner names are drawn from the same manifest as this repo's, so "server" means the
 * same repo on both sides -- the one-repo-two-machines case that promotion convergence depends
 * on. Anything else, including two unlinked repos and two repos in different workspaces, is a
 * separate namespace where an owner name carries no meaning that can be honoured here.
 *
 * `claimAsMine` is a person overriding that for the one case no file can settle: their own
 * export, from a machine that is off, wiped, or being restored from, written before this
 * format could carry an identity. It is checked AFTER same-workspace trust, because a file
 * that already proves it belongs here needs no assertion and carries a real promotion the
 * trusted path would apply. And it claims authorship only -- see `attributeImported`.
 */
async function importAttribution(
  header: any,
  formatVersion: number,
  options: { projectRoot?: string; claimAsMine?: boolean },
): Promise<ImportAttribution> {
  const origin = formatVersion >= 3 && header.origin && typeof header.origin === 'object' ? header.origin : null;
  const workspace = typeof origin?.workspace === 'string' ? origin.workspace : null;
  const repo = typeof origin?.repo === 'string' ? origin.repo : null;

  if (workspace && options.projectRoot) {
    try {
      const { resolveWorkspace } = await import('../workspace/resolve.js');
      const active = await resolveWorkspace(options.projectRoot);
      if (active?.name === workspace) return null;
    } catch {
      // Unreadable workspace means unproven sameness, and the safe answer to unproven is to
      // attribute the file elsewhere: a wrong stamp is recoverable, a false claim is not.
    }
  }

  if (options.claimAsMine) {
    return { owner: await localOwner(options.projectRoot), reported: 'claimed' };
  }
  return {
    owner: workspace && repo ? `${IMPORTED_ORIGIN_PREFIX}${workspace}/${repo}` : UNKNOWN_IMPORT_ORIGIN,
    reported: 'attributed',
  };
}

/**
 * Ownership and visibility for one incoming item from a file this repo is not taking on trust.
 *
 * Such a file may update content -- that is what divergence policy is for -- but it may never
 * say who owns a row or who may read it. So a row already here keeps the owner and visibility
 * it already had, and a row arriving for the first time takes the attribution's owner and
 * stays private. Importing a stranger's `visibility = 'workspace'` verbatim published it to
 * this repo's peers on import, with no join, no promote and no flag: peers read a repo's
 * database filtered on visibility alone.
 *
 * Visibility is forced to 'repo' under `--mine` as well, and that is the point rather than an
 * oversight. Authorship is something a person can know about their own export; whether it was
 * ever published, and to which workspace, is not carried by the claim and is not theirs to
 * assert on a file's behalf. Honouring the file's visibility under a flag would re-open the
 * leak above with one extra keystroke in front of it. Claiming is not publishing -- the same
 * line `backfillOriginRepo` draws when it claims a whole repo on join and leaves it private.
 *
 * The lifecycle hash is recomputed because it fingerprints these two fields. Left as the
 * file's, the row would carry a hash of values it does not hold, and the next import of the
 * same file would read that disagreement as a metadata divergence forever.
 */
function attributeImported(
  item: any,
  local: { originRepo: string | null; visibility: string } | undefined,
  attribution: ImportAttribution,
): any {
  if (!attribution) return item;
  const originRepo = local ? local.originRepo : attribution.owner;
  const visibility = local ? local.visibility : 'repo';
  if ((item.originRepo ?? null) === originRepo && (item.visibility ?? 'repo') === visibility) return item;
  const attributed = { ...item, originRepo, visibility };
  return { ...attributed, lifecycleHash: hashKnowledgeLifecycle(attributed) };
}

/**
 * Columns import writes, paired with how each is read off an exported item.
 *
 * One list rather than a string and a matching positional array: the placeholder count used to
 * be a hardcoded `new Array(21)`, so adding a column meant editing three things that agree only
 * by inspection.
 */
const ITEM_FIELDS: Array<[column: string, read: (item: any) => any]> = [
  ['id', item => item.id],
  ['category', item => item.category],
  ['status', item => item.status],
  ['title', item => item.title],
  ['content', item => item.content],
  ['reasoning', item => item.reasoning ?? null],
  ['alternatives', item => (item.alternatives ? JSON.stringify(item.alternatives) : null)],
  ['tags', item => (item.tags ? JSON.stringify(item.tags) : null)],
  ['source', item => item.source ?? null],
  ['source_commit', item => item.sourceCommit ?? null],
  ['affected_paths', item => (item.affectedPaths ? JSON.stringify(item.affectedPaths) : null)],
  ['content_hash', item => item.contentHash ?? null],
  // Derived when the file does not carry one, so importing a version-1 export leaves the row
  // fingerprinted rather than NULL. Writing NULL here would mean the row it just converged
  // still could not be compared on the next round.
  ['lifecycle_hash', item => item.lifecycleHash ?? hashKnowledgeLifecycle(item)],
  // A version-1 file carries neither, and that is not a loss of information: it was written
  // before ownership existed, so NULL and 'repo' are what it means.
  ['origin_repo', item => item.originRepo ?? null],
  ['visibility', item => item.visibility ?? 'repo'],
  ['freshness', item => item.freshness],
  ['confidence', item => item.confidence],
  ['conflict_key', item => item.conflictKey ?? null],
  ['conflict_scope', item => (item.conflictScope ? JSON.stringify(item.conflictScope) : null)],
  ['conflict_exclusive', item => (item.conflictExclusive ? 1 : 0)],
  ['superseded_by_id', item => item.supersededById ?? null],
  ['version', item => item.version],
  ['created_at', item => item.createdAt],
  ['updated_at', item => item.updatedAt],
];

const ITEM_COLUMNS = ITEM_FIELDS.map(([column]) => column).join(', ');
const ITEM_PLACEHOLDERS = ITEM_FIELDS.map(() => '?').join(', ');
/** `id` first, so the update path drops it and appends it to the WHERE clause. */
const ITEM_SET_CLAUSE = ITEM_FIELDS.slice(1).map(([column]) => `${column} = ?`).join(', ');

function itemArgs(item: any): any[] {
  return ITEM_FIELDS.map(([, read]) => read(item));
}

/** Lifecycle columns only, for a metadata-divergent item whose content already agrees. */
const LIFECYCLE_FIELDS = ITEM_FIELDS.filter(([column]) => [
  'status', 'freshness', 'superseded_by_id', 'origin_repo', 'visibility', 'lifecycle_hash',
  'version', 'updated_at',
].includes(column));

type SkillInstall = { target: string; content: string };

/**
 * Every path anchored to one fixed base the record cannot influence.
 *
 * The previous check derived the containment root from the same untrusted `skill.name` as the
 * target, so both moved together and `../../escape` satisfied it. The name is now validated
 * with the same rule package creation uses -- no dots, no separators -- which makes traversal
 * unrepresentable rather than merely detected, and the base is computed once outside the loop.
 */
function planSkillInstalls(projectRoot: string, skills: any[]): SkillInstall[] {
  const base = path.resolve(projectRoot, '.knowl', 'skills');
  const installs: SkillInstall[] = [];
  for (const skill of skills) {
    validateSkillName(skill.name);
    const skillDir = path.resolve(base, skill.name);
    if (path.dirname(skillDir) !== base) throw new Error(`Invalid imported skill name "${skill.name}".`);
    for (const file of skill.files ?? []) {
      if (typeof file?.content !== 'string') {
        throw new Error(`Invalid imported skill file content for "${file?.path}".`);
      }
      const normalized = normalizeSkillFilePath(file.path);
      const target = path.resolve(skillDir, ...normalized.split('/'));
      const relative = path.relative(skillDir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Invalid imported skill file path "${file.path}".`);
      }
      installs.push({ target, content: file.content });
    }
  }
  return installs;
}

export async function importKnowledge(
  inputPath: string,
  options: {
    dryRun?: boolean;
    projectRoot?: string;
    onDivergence?: DivergencePolicy;
    /**
     * A person asserting that this export came from this same repo, on a machine that cannot
     * be linked and re-exported -- off, wiped, or the backup being restored from. Never a
     * default and never inferred from the file: the whole point is that a file cannot be
     * trusted about its own ownership, so the only thing that can settle it is someone who
     * knows. Claims authorship, not publication.
     */
    claimAsMine?: boolean;
  } = {},
): Promise<ImportResult> {
  const source = await fs.readFile(inputPath, 'utf8');
  const lines = source.split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('Invalid Knowl JSONL stream.');
  const manifest = JSON.parse(lines.at(-1)!);
  const body = `${lines.slice(0, -1).join('\n')}\n`;
  if (manifest.type !== 'manifest' || manifest.sha256 !== crypto.createHash('sha256').update(body).digest('hex')) throw new Error('JSONL manifest checksum mismatch.');
  const records = lines.slice(0, -1).map(line => JSON.parse(line));
  const header = records.shift();
  if (header?.type !== 'header' || header.format !== 'knowl-jsonl') throw new Error('Unsupported Knowl JSONL format.');
  const formatVersion = Number(header.version);
  if (!Number.isInteger(formatVersion) || formatVersion < MIN_READABLE_FORMAT_VERSION || formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `Knowl JSONL format version ${header.version} is not supported; this build reads ` +
      `${MIN_READABLE_FORMAT_VERSION} to ${EXPORT_FORMAT_VERSION}. ` +
      'Upgrade Knowl to read it -- importing it here would drop the fields this build does not know about.',
    );
  }
  const items = records.filter(record => record.type === 'item').map(record => record.item);
  const assertions = records.filter(record => record.type === 'assertion').map(record => record.assertion);
  const evidence = records.filter(record => record.type === 'evidence').map(record => record.evidence);
  const links = records.filter(record => record.type === 'knowledge_evidence').map(record => record.link);
  const skills = records.filter(record => record.type === 'skill_package');
  const tombstones = records.filter(record => record.type === 'tombstone').map(record => record.tombstone);
  const policy: DivergencePolicy = options.onDivergence ?? DEFAULT_DIVERGENCE_POLICY;
  const attribution = await importAttribution(header, formatVersion, options);
  const ownership = attribution?.reported ?? 'trusted';
  const client = getClient();

  const plan: Array<{ item: any; action: 'insert' | 'update' | 'metadata' | 'identical' | 'keep-local' }> = [];
  const divergent: ImportResult['divergent'] = [];
  let conflicts = 0;
  let blockedByTombstone = 0;
  /**
   * Ids a tombstone refused. Their assertions and evidence links carry a foreign key to
   * `knowledge_items`, so letting those through while skipping the item itself fails the
   * constraint and rolls back the entire import -- including every unrelated item in it.
   */
  const blockedIds = new Set<string>();

  // Local deletes, consulted before planning an insert. Without this a stale export
  // reinstated knowledge that had since been deliberately removed: the import path checked
  // tombstones only when deciding whether to delete, never when deciding whether to create.
  const localTombstones = new Map<string, string>();
  for (const row of (await client.execute('SELECT id, deleted_at FROM knowledge_tombstones')).rows) {
    localTombstones.set(String(row.id), String(row.deleted_at));
  }

  for (const incoming of items) {
    validateKnowledgeWrite({ title: incoming.title, content: incoming.content, reasoning: incoming.reasoning, source: incoming.source, affectedPaths: incoming.affectedPaths });
    // The lifecycle fields come along so `classifyIncomingItem` can derive a fingerprint for
    // a row whose `lifecycle_hash` is NULL -- which is every row written before the column
    // was added, since it is not backfilled.
    const existing = (await client.execute({
      sql: `SELECT id, content_hash, lifecycle_hash, updated_at, version,
                   status, freshness, superseded_by_id, origin_repo, visibility
            FROM knowledge_items WHERE id = ?`,
      args: [incoming.id],
    })).rows[0];

    const local = existing
      ? {
        id: String(existing.id),
        contentHash: existing.content_hash === null ? null : String(existing.content_hash),
        lifecycleHash: existing.lifecycle_hash === null ? null : String(existing.lifecycle_hash),
        updatedAt: String(existing.updated_at),
        version: Number(existing.version),
        status: String(existing.status),
        freshness: String(existing.freshness),
        supersededById: existing.superseded_by_id === null ? null : String(existing.superseded_by_id),
        originRepo: existing.origin_repo === null ? null : String(existing.origin_repo),
        visibility: String(existing.visibility),
      }
      : undefined;

    // Attributed before it is classified, so one object carries the owner, the visibility and
    // the lifecycle hash that will actually be written. Classifying the file's version and
    // writing a different one is how a row ends up permanently metadata-divergent with itself.
    const item = attributeImported(incoming, local, attribution);

    const classification = classifyIncomingItem(item, local);
    if (classification === 'new') {
      // A tie favours the item, matching the delete path below, which keeps a local row whose
      // `updated_at` equals the tombstone rather than removing it. Knowledge that was deleted
      // and then legitimately re-recorded still lands, because its export is the newer fact.
      const deletedAt = localTombstones.get(String(item.id));
      if (deletedAt && String(item.updatedAt) < deletedAt) {
        blockedByTombstone += 1;
        blockedIds.add(String(item.id));
        continue;
      }
      plan.push({ item, action: 'insert' });
      continue;
    }
    if (classification === 'identical') { plan.push({ item, action: 'identical' }); continue; }

    // Divergent either way. `fail` is the only policy that abandons the whole import; every
    // other policy resolves per item so unrelated new knowledge still lands.
    if (policy === 'fail') { conflicts += 1; plan.push({ item, action: 'keep-local' }); continue; }
    const taken = resolveDivergence(policy, item, local!);
    divergent.push({ id: item.id, title: String(item.title ?? ''), taken });
    // A metadata-divergent winner touches only the lifecycle columns. Rewriting content that
    // already agrees would be a no-op at best, and at worst would rewrite `content_hash` and
    // leave the two sides trading updates forever.
    plan.push({
      item,
      action: taken === 'local' ? 'keep-local' : classification === 'metadata-divergent' ? 'metadata' : 'update',
    });
  }

  const counts = {
    inserted: plan.filter(entry => entry.action === 'insert').length,
    identical: plan.filter(entry => entry.action === 'identical').length,
    // A metadata convergence counts as an update: from the caller's side an item changed.
    // Splitting it into its own count would make every existing consumer of `updated`
    // silently under-report the promotions and retirements this change exists to deliver.
    updated: plan.filter(entry => entry.action === 'update' || entry.action === 'metadata').length,
    keptLocal: plan.filter(entry => entry.action === 'keep-local').length,
  };

  // A dry run and the `fail` policy both write nothing, so every count reports zero
  // rather than describing writes that did not happen. The old shape reported a non-zero
  // `inserted` beside `applied: false`, which read as partial success.
  if (conflicts > 0 || options.dryRun) {
    return {
      inserted: 0, identical: 0, updated: 0, keptLocal: 0, deleted: 0,
      conflicts, blockedByTombstone, applied: false, ownership,
      divergent: options.dryRun ? divergent : [],
      ...(options.dryRun ? { wouldApply: counts } : {}),
    };
  }
  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');
  // Planned before anything is written, so a malformed package cannot leave a half-written
  // filesystem behind a rolled-back database.
  const skillInstalls = options.projectRoot ? planSkillInstalls(options.projectRoot, skills) : [];
  const staging = skillInstalls.length > 0
    ? await fs.mkdtemp(path.join(path.resolve(options.projectRoot!, '.knowl'), 'import-skills-'))
    : null;
  if (staging) {
    for (const [index, install] of skillInstalls.entries()) {
      await fs.writeFile(path.join(staging, String(index)), install.content, 'utf8');
    }
  }
  const written: KnowledgeItem[] = [];
  /**
   * What to record in `knowledge_commits`, in the shape `promote` uses: ids and titles, never
   * content. Import was the one write path that logged nothing, so `readCommitHead` -- which
   * is `MAX(rowid)` of that table -- never moved, and a repo that had just received a hundred
   * facts told the next session it had changed nothing.
   */
  const committed: CommitChange[] = [];
  const changeOf = (item: any, action: CommitChange['action']): CommitChange => ({
    itemId: String(item.id),
    action,
    after: { id: String(item.id), category: item.category, title: String(item.title ?? '') },
  });
  let deleted = 0;
  await client.execute('BEGIN;');
  try {
    for (const entry of plan) {
      if (entry.action === 'insert') {
        written.push(entry.item as KnowledgeItem);
        committed.push(changeOf(entry.item, 'insert'));
        await client.execute({
          sql: `INSERT INTO knowledge_items (${ITEM_COLUMNS}) VALUES (${ITEM_PLACEHOLDERS})`,
          args: itemArgs(entry.item),
        });
      } else if (entry.action === 'update') {
        // Verbatim: the peer's own content_hash, version and updated_at, so the next
        // round classifies this as identical. Going through updateKnowledgeItem would set
        // updatedAt = now and bump version, making this copy newer than the peer's and
        // leaving the two machines to ping-pong a fresh winner forever.
        written.push(entry.item as KnowledgeItem);
        committed.push(changeOf(entry.item, 'update'));
        await client.execute({
          sql: `UPDATE knowledge_items SET ${ITEM_SET_CLAUSE} WHERE id = ?`,
          args: [...itemArgs(entry.item).slice(1), entry.item.id],
        });
      } else if (entry.action === 'metadata') {
        committed.push(changeOf(entry.item, 'update'));
        // Lifecycle columns only, and `content_hash` deliberately untouched -- it already
        // matches, and rewriting it is what would restart the ping-pong. Not indexed for
        // vectors either: the embedding is a function of content, which did not change.
        await client.execute({
          sql: `UPDATE knowledge_items SET ${LIFECYCLE_FIELDS.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`,
          args: [...LIFECYCLE_FIELDS.map(([, read]) => read(entry.item)), entry.item.id],
        });
      }
    }
    for (const entry of evidence) await client.execute({ sql: 'INSERT OR IGNORE INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [entry.id, entry.type, entry.locator, entry.contentHash ?? null, entry.excerpt ?? null, entry.observedAt, entry.metadata ? JSON.stringify(entry.metadata) : null] });
    // Dependents of a tombstoned item are dropped with it: both tables hold a foreign key to
    // knowledge_items, so inserting them without the item fails the constraint and rolls back
    // every unrelated item in the same import.
    for (const assertion of assertions.filter(entry => !blockedIds.has(String(entry.knowledgeItemId)))) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id, conflict_key, conflict_scope, conflict_exclusive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [assertion.id, assertion.knowledgeItemId, assertion.content, assertion.validFrom, assertion.validTo ?? null, assertion.recordedAt, assertion.replacedAt ?? null, assertion.confidence, assertion.sourceEvidenceId ?? null, assertion.conflictKey ?? null, assertion.conflictScope ? JSON.stringify(assertion.conflictScope) : null, assertion.conflictExclusive ? 1 : 0] });
    for (const link of links.filter(entry => !blockedIds.has(String(entry.knowledgeItemId)))) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [link.knowledgeItemId, link.evidenceId, link.relationship] });

    // A local edit made after the remote delete wins. The tombstone is recorded either
    // way, so the same decision does not have to be made again next round.
    for (const tombstone of tombstones) {
      const local = (await client.execute({
        // Title and category come along for the commit log: a delete has no `after`, so
        // `before` is the only thing that can name the item in a change card.
        sql: 'SELECT updated_at, title, category FROM knowledge_items WHERE id = ?',
        args: [tombstone.id],
      })).rows[0];
      if (local && String(local.updated_at) < String(tombstone.deletedAt)) {
        await client.execute({ sql: 'DELETE FROM knowledge_items WHERE id = ?', args: [tombstone.id] });
        committed.push({
          itemId: String(tombstone.id),
          action: 'delete',
          before: { id: String(tombstone.id), category: local.category as any, title: String(local.title) },
        });
        deleted += 1;
      }
      // Monotonic, same as `recordTombstone`: a peer that deleted the item earlier must not
      // rewind a delete recorded here later. Fixing only one of the two sites would leave the
      // bug reachable through ordinary GC.
      await client.execute({
        sql: `INSERT INTO knowledge_tombstones (id, deleted_at, reason) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
          WHERE excluded.deleted_at > knowledge_tombstones.deleted_at`,
        args: [tombstone.id, tombstone.deletedAt, tombstone.reason ?? null],
      });
    }

    // Inside the transaction, not after it. Drizzle wraps this same client, so the insert
    // joins the open transaction and a rolled-back import announces nothing -- the opposite
    // of the vector index below, which is best-effort precisely because it can be redone.
    // Skipped when nothing changed, so a re-import of the same file stays silent rather than
    // reporting a change that did not happen.
    if (committed.length > 0) {
      const noun = committed.length === 1 ? 'item' : 'items';
      await createKnowledgeCommit(
        'local',
        `Import ${committed.length} ${noun} (${ownership})`,
        committed,
      );
    }
    await client.execute('COMMIT;');
  } catch (error) {
    await client.execute('ROLLBACK;').catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // After COMMIT, and by rename rather than write: the contents were staged before the
  // transaction opened, so the only work left is the cheapest step that can still fail. It is
  // not swallowed -- the database is already committed by this point, and an import that
  // silently omitted its skill files would look like a success.
  if (staging) {
    try {
      for (const [index, install] of skillInstalls.entries()) {
        await fs.mkdir(path.dirname(install.target), { recursive: true });
        await fs.rename(path.join(staging, String(index)), install.target);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Every other write path indexes on write. Import wrote raw SQL and skipped this, so
  // imported knowledge was invisible to vector search -- the primary retrieval path --
  // until someone ran `knowl reindex --vectors` by hand. FTS was never affected because
  // bootstrap defines insert/update/delete triggers for it; vectors need a model, so no
  // trigger can cover them. Runs after COMMIT so a rolled-back import indexes nothing,
  // and stays best-effort: a project without vectors enabled simply stays on BM25.
  await indexKnowledgeItemsBestEffort('local', written);

  return { ...counts, deleted, conflicts: 0, blockedByTombstone, applied: true, divergent, ownership };
}
