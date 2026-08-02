import { loadConfig } from '../core/config.js';
import { installKnowlProjectGuidance } from '../core/agents-guidance.js';
import { installKnowlGitignoreEntry } from '../core/gitignore.js';
import { closeDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { recoverAbandonedSessions } from '../store/session-repository.js';
import { repairUnnormalizedConflictKeys } from '../store/conflicts.js';
import { reindexKnowledgeEmbeddings } from '../store/vector-index.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { runAgentInitFlow } from './init-flow.js';
import type { DoctorCheck } from './doctor-report.js';
import { remedyLabel, type DoctorRemedy } from './doctor-remedy.js';

export type DoctorFixOptions = {
  /** Re-embed unembedded items. Off by default: the cost scales with the store's size. */
  reindex?: boolean;
};

export type DoctorFixResult = {
  applied: string[];
  /** Remedies this run deliberately did not attempt, by label. */
  deferred: string[];
  failed: Array<{ remedy: string; error: string }>;
  /** Messages of findings with no safe automatic answer, so a caller cannot mistake them for handled. */
  unfixable: string[];
};

async function runRemedy(projectRoot: string, remedy: DoctorRemedy): Promise<void> {
  switch (remedy.kind) {
    case 'guidance':
      await installKnowlProjectGuidance(projectRoot);
      return;

    case 'gitignore':
      await installKnowlGitignoreEntry(projectRoot);
      return;

    case 'session-recover':
      await initDb(projectRoot);
      try {
        await recoverAbandonedSessions();
      } finally {
        await closeDb();
      }
      return;

    case 'conflict-key-normalize':
      await initDb(projectRoot);
      try {
        await repairUnnormalizedConflictKeys();
      } finally {
        await closeDb();
      }
      return;

    case 'host-init':
      // The same call `knowl init <host> -y` makes. Safe to repeat for a host the repo
      // already uses, which is the only kind doctor ever names.
      await runAgentInitFlow(projectRoot, { agentNames: [remedy.host], yes: true, interactive: false });
      return;

    case 'reindex-vectors': {
      const config = await loadConfig(projectRoot);
      if (!isVectorSearchEnabled(config)) {
        throw new Error('Vector search is not enabled for this repository.');
      }
      const embedder = await createLocalEmbeddingProvider(config, projectRoot);
      await initDb(projectRoot);
      try {
        const project = await getProjectByRootPath(projectRoot);
        if (!project) throw new Error('Project not registered in the Knowl database.');
        await reindexKnowledgeEmbeddings(project.id, embedder);
      } finally {
        await closeDb();
      }
      return;
    }
  }
}

/**
 * Apply the remedies a doctor run produced, for one repository.
 *
 * Every remedy is attempted even if an earlier one failed: the repairs are independent, and
 * one unwritable file should not abandon the rest. Failures are collected rather than thrown
 * so a sweep across repositories can report them together.
 *
 * Findings without a remedy are returned in `unfixable` rather than ignored. A caller that
 * reported success on the strength of `failed` being empty would otherwise call a repo with
 * an integrity error fixed.
 */
export async function applyDoctorRemedies(
  projectRoot: string,
  checks: DoctorCheck[],
  options: DoctorFixOptions = {},
): Promise<DoctorFixResult> {
  const result: DoctorFixResult = { applied: [], deferred: [], failed: [], unfixable: [] };
  const seen = new Set<string>();

  for (const check of checks) {
    if (check.status === 'OK') continue;

    if (!check.remedy) {
      result.unfixable.push(check.message);
      continue;
    }

    // Two checks can name one repair -- a host's instructions and its lifecycle hooks both
    // fail together -- and running it twice is wasted work with a second chance to fail.
    const label = remedyLabel(check.remedy);
    if (seen.has(label)) continue;
    seen.add(label);

    if (check.remedy.kind === 'reindex-vectors' && !options.reindex) {
      result.deferred.push(label);
      continue;
    }

    try {
      await runRemedy(projectRoot, check.remedy);
      result.applied.push(label);
    } catch (error: any) {
      result.failed.push({ remedy: label, error: error?.message ?? String(error) });
    }
  }

  return result;
}
