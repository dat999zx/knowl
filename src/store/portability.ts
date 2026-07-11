import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listKnowledgeItems } from './repository.js';
import { listAssertions } from './assertions.js';
import { getClient } from './database.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { listEvidenceForItem } from './evidence-repository.js';

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
  const items = (await listKnowledgeItems(projectId)).sort((a, b) => a.id.localeCompare(b.id));
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
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const manifest = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(outputPath, `${body}${JSON.stringify({ type: 'manifest', sha256: manifest })}\n`, 'utf8');
  return { items: items.length, sha256: manifest };
}

export type ImportResult = { inserted: number; skipped: number; conflicts: number; applied: boolean };

export async function importKnowledge(inputPath: string, options: { dryRun?: boolean; projectRoot?: string } = {}): Promise<ImportResult> {
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
  const client = getClient();
  let inserted = 0; let skipped = 0; let conflicts = 0;
  for (const item of items) {
    validateKnowledgeWrite({ title: item.title, content: item.content, reasoning: item.reasoning, source: item.source, affectedPaths: item.affectedPaths });
    const existing = await client.execute({ sql: 'SELECT content_hash FROM knowledge_items WHERE id = ?', args: [item.id] });
    if (existing.rows[0]) {
      if (String(existing.rows[0].content_hash ?? '') === String(item.contentHash ?? '')) skipped += 1;
      else conflicts += 1;
      continue;
    }
    inserted += 1;
  }
  if (conflicts > 0 || options.dryRun) return { inserted: options.dryRun ? 0 : inserted, skipped, conflicts, applied: false };
  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');
  await client.execute('BEGIN;');
  try {
    for (const item of items) {
      const existing = await client.execute({ sql: 'SELECT 1 FROM knowledge_items WHERE id = ?', args: [item.id] });
      if (existing.rows[0]) continue;
      await client.execute({ sql: `INSERT INTO knowledge_items (id, category, status, title, content, reasoning, alternatives, tags, source, source_commit, affected_paths, content_hash, freshness, confidence, conflict_key, conflict_scope, conflict_exclusive, superseded_by_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [item.id, item.category, item.status, item.title, item.content, item.reasoning ?? null, item.alternatives ? JSON.stringify(item.alternatives) : null, item.tags ? JSON.stringify(item.tags) : null, item.source ?? null, item.sourceCommit ?? null, item.affectedPaths ? JSON.stringify(item.affectedPaths) : null, item.contentHash ?? null, item.freshness, item.confidence, item.conflictKey ?? null, item.conflictScope ? JSON.stringify(item.conflictScope) : null, item.conflictExclusive ? 1 : 0, item.supersededById ?? null, item.version, item.createdAt, item.updatedAt] });
    }
    for (const entry of evidence) await client.execute({ sql: 'INSERT OR IGNORE INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [entry.id, entry.type, entry.locator, entry.contentHash ?? null, entry.excerpt ?? null, entry.observedAt, entry.metadata ? JSON.stringify(entry.metadata) : null] });
    for (const assertion of assertions) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id, conflict_key, conflict_scope, conflict_exclusive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [assertion.id, assertion.knowledgeItemId, assertion.content, assertion.validFrom, assertion.validTo ?? null, assertion.recordedAt, assertion.replacedAt ?? null, assertion.confidence, assertion.sourceEvidenceId ?? null, assertion.conflictKey ?? null, assertion.conflictScope ? JSON.stringify(assertion.conflictScope) : null, assertion.conflictExclusive ? 1 : 0] });
    for (const link of links) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [link.knowledgeItemId, link.evidenceId, link.relationship] });
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
  return { inserted, skipped, conflicts, applied: true };
}
