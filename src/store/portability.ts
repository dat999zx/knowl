import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { listKnowledgeItems } from './repository.js';
import { listAssertions } from './assertions.js';

export async function exportKnowledge(projectId: string, outputPath: string) {
  const items = (await listKnowledgeItems(projectId)).sort((a, b) => a.id.localeCompare(b.id));
  const records: unknown[] = [{ type: 'header', format: 'knowl-jsonl', version: 1, namespace: 'project' }];
  for (const item of items) { records.push({ type: 'item', item }); for (const assertion of await listAssertions(item.id)) records.push({ type: 'assertion', assertion }); }
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const manifest = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(outputPath, `${body}${JSON.stringify({ type: 'manifest', sha256: manifest })}\n`, 'utf8');
  return { items: items.length, sha256: manifest };
}
