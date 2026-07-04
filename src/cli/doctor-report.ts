import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { isKnowlAgentsGuidanceCurrent } from '../core/agents-guidance.js';
import { closeDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { queryKnowledgeForAgent } from '../store/agent-query.js';
import { KNOWL_MCP_TOOL_NAMES } from '../mcp/server.js';
import { getVectorSearchConfig, isVectorSearchEnabled } from '../ai/embeddings.js';

type DoctorStatus = 'OK' | 'WARN' | 'FAIL';

export type DoctorCheck = {
  status: DoctorStatus;
  message: string;
};

export type DoctorResult = {
  ready: boolean;
  checks: DoctorCheck[];
};

export async function runDoctor(startPath: string = process.cwd()): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  let dbOpen = false;

  try {
    const root = await findProjectRoot(startPath);
    const knowlDir = path.join(root, '.knowl');
    await fs.access(knowlDir);
    checks.push({ status: 'OK', message: `Repository initialized at ${knowlDir}` });

    const config = await loadConfig(root);
    checks.push({ status: 'OK', message: 'Config loaded' });

    const guidanceCurrent = await isKnowlAgentsGuidanceCurrent(root);
    checks.push({
      status: guidanceCurrent ? 'OK' : 'WARN',
      message: guidanceCurrent
        ? 'AGENTS.md Knowl guidance current'
        : 'AGENTS.md Knowl guidance missing or stale; run knowl init',
    });

    await initDb(root);
    dbOpen = true;

    const project = await getProjectByRootPath(root);
    if (!project) {
      checks.push({ status: 'FAIL', message: 'Project not registered in Knowl database' });
    } else {
      checks.push({ status: 'OK', message: `Project registered: ${project.name}` });

      const queryResults = await queryKnowledgeForAgent(project.id, {
        status: 'active',
        limit: 3,
      });
      checks.push({
        status: queryResults.length > 0 ? 'OK' : 'WARN',
        message: queryResults.length > 0
          ? `Agent query returned ${queryResults.length} item(s)`
          : 'Agent query returned no active items; store durable project knowledge',
      });
    }

    const hasQuery = KNOWL_MCP_TOOL_NAMES.includes('knowl_query');
    const hasAsk = (KNOWL_MCP_TOOL_NAMES as readonly string[]).includes('knowl_ask');
    checks.push({
      status: hasQuery && !hasAsk ? 'OK' : 'FAIL',
      message: hasQuery && !hasAsk
        ? 'MCP tools expose knowl_query and hide knowl_ask'
        : 'MCP tool surface should expose knowl_query and hide knowl_ask',
    });

    if (isVectorSearchEnabled(config)) {
      const vector = getVectorSearchConfig(config);
      checks.push({
        status: 'OK',
        message: `Vector search enabled with ${vector.provider}/${vector.model}`,
      });
    } else {
      checks.push({
        status: 'OK',
        message: 'Vector search disabled; BM25 retrieval remains active',
      });
    }
  } catch (error: any) {
    checks.push({ status: 'FAIL', message: error.message });
  } finally {
    if (dbOpen) {
      await closeDb();
    }
  }

  return {
    ready: checks.every(check => check.status === 'OK'),
    checks,
  };
}

export function formatDoctorReport(result: DoctorResult): string {
  const lines = ['KNOWL AGENT READINESS', ''];

  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.message}`);
  }

  lines.push('');
  lines.push(`Result: ${result.ready ? 'READY' : 'NOT READY'}`);

  return lines.join('\n');
}
