import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listKnowledgeItems } from './repository.js';
import { listAssertions } from './assertions.js';
import { getClient } from './database.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { listEvidenceForItem } from './evidence-repository.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';
import { listTombstones } from './tombstones.js';
import {
  classifyIncomingItem,
  DEFAULT_DIVERGENCE_POLICY,
  DivergencePolicy,
  resolveDivergence,
} from './import-policy.js';
import type { KnowledgeItem } from '../core/types.js';

async function skillFiles(root: string, directory: string, base = directory): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await skillFiles(root, full, base));
    else if (entry.isFile()) files.push({ path: full.slice(base.length + 1).replace(/\\/g, '/'), content: await fs.readFile(full, 'utf8') });
  }
  return files;
}

export async function exportKnowledge(projectId: string, outputPath: string, projectRoot?: string) {
  const items = (await listKnowledgeItems()).sort((a, b) => a.id.localeCompare(b.id));
  const records: unknown[] = [{ type: 'header', format: 'knowl-jsonl', version: 1, namespace: 'project' }];
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
  applied: boolean;
  divergent: Array<{ id: string; title: string; taken: 'incoming' | 'local' }>;
  /** Present only on a dry run: what the counts WOULD have been. */
  wouldApply?: { inserted: number; identical: number; updated: number; keptLocal: number };
};

const ITEM_COLUMNS = 'id, category, status, title, content, reasoning, alternatives, tags, source, source_commit, affected_paths, content_hash, freshness, confidence, conflict_key, conflict_scope, conflict_exclusive, superseded_by_id, version, created_at, updated_at';

/** Column order matches ITEM_COLUMNS; `id` first so the update path can drop it. */
function itemArgs(item: any): any[] {
  return [
    item.id, item.category, item.status, item.title, item.content, item.reasoning ?? null,
    item.alternatives ? JSON.stringify(item.alternatives) : null,
    item.tags ? JSON.stringify(item.tags) : null,
    item.source ?? null, item.sourceCommit ?? null,
    item.affectedPaths ? JSON.stringify(item.affectedPaths) : null,
    item.contentHash ?? null, item.freshness, item.confidence, item.conflictKey ?? null,
    item.conflictScope ? JSON.stringify(item.conflictScope) : null,
    item.conflictExclusive ? 1 : 0, item.supersededById ?? null, item.version,
    item.createdAt, item.updatedAt,
  ];
}

export async function importKnowledge(
  inputPath: string,
  options: { dryRun?: boolean; projectRoot?: string; onDivergence?: DivergencePolicy } = {},
): Promise<ImportResult> {
  const source = await fs.readFile(inputPath, 'utf8');
  const lines = source.split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('Invalid Knowl JSONL stream.');
  const manifest = JSON.parse(lines.at(-1)!);
  const body = `${lines.slice(0, -1).join('\n')}\n`;
  if (manifest.type !== 'manifest' || manifest.sha256 !== crypto.createHash('sha256').update(body).digest('hex')) throw new Error('JSONL manifest checksum mismatch.');
  const records = lines.slice(0, -1).map(line => JSON.parse(line));
  const header = records.shift();
  if (header?.type !== 'header' || header.format !== 'knowl-jsonl' || header.version !== 1) throw new Error('Unsupported Knowl JSONL format.');
  const items = records.filter(record => record.type === 'item').map(record => record.item);
  const assertions = records.filter(record => record.type === 'assertion').map(record => record.assertion);
  const evidence = records.filter(record => record.type === 'evidence').map(record => record.evidence);
  const links = records.filter(record => record.type === 'knowledge_evidence').map(record => record.link);
  const skills = records.filter(record => record.type === 'skill_package');
  const tombstones = records.filter(record => record.type === 'tombstone').map(record => record.tombstone);
  const policy: DivergencePolicy = options.onDivergence ?? DEFAULT_DIVERGENCE_POLICY;
  const client = getClient();

  const plan: Array<{ item: any; action: 'insert' | 'update' | 'identical' | 'keep-local' }> = [];
  const divergent: ImportResult['divergent'] = [];
  let conflicts = 0;

  for (const item of items) {
    validateKnowledgeWrite({ title: item.title, content: item.content, reasoning: item.reasoning, source: item.source, affectedPaths: item.affectedPaths });
    const existing = (await client.execute({
      sql: 'SELECT id, content_hash, updated_at, version FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0];

    const local = existing
      ? {
        id: String(existing.id),
        contentHash: existing.content_hash === null ? null : String(existing.content_hash),
        updatedAt: String(existing.updated_at),
        version: Number(existing.version),
      }
      : undefined;

    const classification = classifyIncomingItem(item, local);
    if (classification === 'new') { plan.push({ item, action: 'insert' }); continue; }
    if (classification === 'identical') { plan.push({ item, action: 'identical' }); continue; }

    // Divergent. `fail` is the only policy that abandons the whole import; every other
    // policy resolves per item so unrelated new knowledge still lands.
    if (policy === 'fail') { conflicts += 1; plan.push({ item, action: 'keep-local' }); continue; }
    const taken = resolveDivergence(policy, item, local!);
    divergent.push({ id: item.id, title: String(item.title ?? ''), taken });
    plan.push({ item, action: taken === 'incoming' ? 'update' : 'keep-local' });
  }

  const counts = {
    inserted: plan.filter(entry => entry.action === 'insert').length,
    identical: plan.filter(entry => entry.action === 'identical').length,
    updated: plan.filter(entry => entry.action === 'update').length,
    keptLocal: plan.filter(entry => entry.action === 'keep-local').length,
  };

  // A dry run and the `fail` policy both write nothing, so every count reports zero
  // rather than describing writes that did not happen. The old shape reported a non-zero
  // `inserted` beside `applied: false`, which read as partial success.
  if (conflicts > 0 || options.dryRun) {
    return {
      inserted: 0, identical: 0, updated: 0, keptLocal: 0, deleted: 0,
      conflicts, applied: false,
      divergent: options.dryRun ? divergent : [],
      ...(options.dryRun ? { wouldApply: counts } : {}),
    };
  }
  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');
  const written: KnowledgeItem[] = [];
  let deleted = 0;
  await client.execute('BEGIN;');
  try {
    for (const entry of plan) {
      if (entry.action === 'insert') {
        written.push(entry.item as KnowledgeItem);
        await client.execute({
          sql: `INSERT INTO knowledge_items (${ITEM_COLUMNS}) VALUES (${new Array(21).fill('?').join(', ')})`,
          args: itemArgs(entry.item),
        });
      } else if (entry.action === 'update') {
        // Verbatim: the peer's own content_hash, version and updated_at, so the next
        // round classifies this as identical. Going through updateKnowledgeItem would set
        // updatedAt = now and bump version, making this copy newer than the peer's and
        // leaving the two machines to ping-pong a fresh winner forever.
        written.push(entry.item as KnowledgeItem);
        await client.execute({
          sql: `UPDATE knowledge_items SET category = ?, status = ?, title = ?, content = ?, reasoning = ?,
            alternatives = ?, tags = ?, source = ?, source_commit = ?, affected_paths = ?, content_hash = ?,
            freshness = ?, confidence = ?, conflict_key = ?, conflict_scope = ?, conflict_exclusive = ?,
            superseded_by_id = ?, version = ?, created_at = ?, updated_at = ? WHERE id = ?`,
          args: [...itemArgs(entry.item).slice(1), entry.item.id],
        });
      }
    }
    for (const entry of evidence) await client.execute({ sql: 'INSERT OR IGNORE INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [entry.id, entry.type, entry.locator, entry.contentHash ?? null, entry.excerpt ?? null, entry.observedAt, entry.metadata ? JSON.stringify(entry.metadata) : null] });
    for (const assertion of assertions) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id, conflict_key, conflict_scope, conflict_exclusive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [assertion.id, assertion.knowledgeItemId, assertion.content, assertion.validFrom, assertion.validTo ?? null, assertion.recordedAt, assertion.replacedAt ?? null, assertion.confidence, assertion.sourceEvidenceId ?? null, assertion.conflictKey ?? null, assertion.conflictScope ? JSON.stringify(assertion.conflictScope) : null, assertion.conflictExclusive ? 1 : 0] });
    for (const link of links) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [link.knowledgeItemId, link.evidenceId, link.relationship] });

    // A local edit made after the remote delete wins. The tombstone is recorded either
    // way, so the same decision does not have to be made again next round.
    for (const tombstone of tombstones) {
      const local = (await client.execute({
        sql: 'SELECT updated_at FROM knowledge_items WHERE id = ?',
        args: [tombstone.id],
      })).rows[0];
      if (local && String(local.updated_at) < String(tombstone.deletedAt)) {
        await client.execute({ sql: 'DELETE FROM knowledge_items WHERE id = ?', args: [tombstone.id] });
        deleted += 1;
      }
      await client.execute({
        sql: `INSERT INTO knowledge_tombstones (id, deleted_at, reason) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason`,
        args: [tombstone.id, tombstone.deletedAt, tombstone.reason ?? null],
      });
    }

    for (const skill of skills) for (const file of skill.files) {
      const target = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name, file.path);
      const root = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid imported skill file path.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
    }
    await client.execute('COMMIT;');
  } catch (error) {
    await client.execute('ROLLBACK;');
    throw error;
  }

  // Every other write path indexes on write. Import wrote raw SQL and skipped this, so
  // imported knowledge was invisible to vector search -- the primary retrieval path --
  // until someone ran `knowl reindex --vectors` by hand. FTS was never affected because
  // bootstrap defines insert/update/delete triggers for it; vectors need a model, so no
  // trigger can cover them. Runs after COMMIT so a rolled-back import indexes nothing,
  // and stays best-effort: a project without vectors enabled simply stays on BM25.
  await indexKnowledgeItemsBestEffort('local', written);

  return { ...counts, deleted, conflicts: 0, applied: true, divergent };
}
