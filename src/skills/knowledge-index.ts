import * as repo from '../store/repository.js';
import { storeKnowledgeItemDeduped } from '../store/knowledge-writer.js';
import { SkillManifest, skillSourcePath } from './registry.js';

function skillContent(manifest: SkillManifest): string {
  const source = skillSourcePath(manifest.name);
  return [
    `File-backed learned skill package at \`${source}\`.`,
    `Purpose: ${manifest.purpose}`,
    `Use \`knowl_skill_read\` to inspect it and \`knowl_skill_run\` or \`knowl skill run ${manifest.name}\` to execute it.`,
  ].join('\n');
}

export async function indexSkillPackage(projectId: string, manifest: SkillManifest): Promise<void> {
  const source = skillSourcePath(manifest.name);
  await storeKnowledgeItemDeduped(projectId, {
    category: 'skill',
    title: manifest.name,
    content: skillContent(manifest),
    source,
    affectedPaths: [source, `.knowl/skills/${manifest.name}/skill.json`],
    tags: ['learned-skill', 'file-backed'],
    steps: [
      `Read ${source}`,
      `Run knowl_skill_run with name "${manifest.name}" or use knowl skill run ${manifest.name}`,
    ],
  }, `Create learned skill: ${manifest.name}`);
}

export async function recordSkillRun(projectId: string, name: string, succeeded: boolean): Promise<void> {
  const source = skillSourcePath(name);
  const items = await repo.listKnowledgeItems();
  const item = items.find(candidate =>
    candidate.category === 'skill' &&
    candidate.status === 'active' &&
    candidate.title === name &&
    candidate.source === source
  );
  if (!item) return;

  const metadata = await repo.getSkillMetadata(item.id);
  if (!metadata) return;

  await repo.updateSkillMetadata(item.id, {
    usageCount: metadata.usageCount + 1,
    successCount: metadata.successCount + (succeeded ? 1 : 0),
    lastUsed: new Date().toISOString(),
  });
}
