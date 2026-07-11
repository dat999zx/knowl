import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { isKnowlAgentsGuidanceCurrent } from '../core/agents-guidance.js';
import { closeDb, getDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { queryKnowledgeForAgent } from '../store/agent-query.js';
import { KNOWL_MCP_TOOL_NAMES } from '../mcp/server.js';
import { getVectorSearchConfig, isVectorSearchEnabled } from '../ai/embeddings.js';
import { auditKnowledgeStore } from '../store/integrity.js';

type DoctorStatus = 'OK' | 'WARN' | 'FAIL';

export type DoctorCheck = {
  status: DoctorStatus;
  message: string;
  fix?: string;
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
    checks.push({
      status: config.search?.vector?.provider ? 'OK' : 'WARN',
      message: config.search?.vector?.provider
        ? 'Config includes vector search defaults'
        : 'Config missing vector search defaults; run knowl upgrade',
    });

    const guidanceCurrent = await isKnowlAgentsGuidanceCurrent(root);
    checks.push({
      status: guidanceCurrent ? 'OK' : 'WARN',
      message: guidanceCurrent
        ? 'AGENTS.md Knowl guidance current'
        : 'AGENTS.md Knowl guidance missing or stale; run knowl init',
      fix: guidanceCurrent ? undefined : 'run `knowl init`',
    });

    const gitignorePath = path.join(root, '.gitignore');
    let ignoresKnowl = false;
    try {
      const gitignore = await fs.readFile(gitignorePath, 'utf-8');
      ignoresKnowl = gitignore
        .split(/\r?\n/)
        .map(line => line.trim())
        .some(line => line === '.knowl/' || line === '.knowl');
    } catch {
      ignoresKnowl = false;
    }
    checks.push({
      status: ignoresKnowl ? 'OK' : 'WARN',
      message: ignoresKnowl
        ? '.gitignore ignores .knowl/'
        : '.gitignore should ignore .knowl/; run knowl upgrade',
      fix: ignoresKnowl ? undefined : 'add `.knowl/` to `.gitignore` or run `knowl upgrade`',
    });

    await initDb(root);
    dbOpen = true;
    const integrity = await auditKnowledgeStore(config.security);
    checks.push({
      status: integrity.findings.some(finding => finding.severity === 'error') ? 'FAIL' : 'OK',
      message: integrity.findings.length === 0
        ? 'Knowledge integrity audit passed'
        : `Knowledge integrity audit found ${integrity.findings.length} warning(s)`,
      fix: integrity.findings.length === 0 ? undefined : 'run `knowl audit` and repair reported records',
    });
    try {
      await (getDb() as any).all(sql`SELECT 1 FROM knowledge_embeddings LIMIT 1`);
      checks.push({ status: 'OK', message: 'Database schema includes knowledge_embeddings' });
    } catch {
      checks.push({ status: 'WARN', message: 'Database schema missing knowledge_embeddings; run knowl upgrade' });
    }
    try {
      await (getDb() as any).all(sql`SELECT 1 FROM memory_sessions LIMIT 1`);
      const stale = await (getDb() as any).all(sql`SELECT 1 FROM memory_sessions WHERE status = 'active' AND last_heartbeat_at < datetime('now', '-2 hours') LIMIT 1`);
      checks.push({ status: stale.length ? 'WARN' : 'OK', message: stale.length ? 'Stale active memory sessions found; run knowl session recover' : 'Memory session schema ready with no stale active sessions', fix: stale.length ? 'run `knowl session recover`' : undefined });
    } catch {
      checks.push({ status: 'WARN', message: 'Database schema missing memory sessions; run knowl upgrade' });
    }

    const project = await getProjectByRootPath(root);
    if (!project) {
      checks.push({ status: 'FAIL', message: 'Project not registered in Knowl database' });
    } else {
      checks.push({ status: 'OK', message: 'Local project store ready' });

      const queryResults = await queryKnowledgeForAgent(project.id, {
        status: 'active',
        limit: 3,
      });
      checks.push({
        status: queryResults.length > 0 ? 'OK' : 'WARN',
        message: queryResults.length > 0
          ? `Agent query returned ${queryResults.length} item(s)`
          : 'Agent query returned no active items; store durable project knowledge',
        fix: queryResults.length > 0 ? undefined : 'store at least one durable fact, decision, constraint, architecture note, state item, or skill',
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

    const hasWorkLoop =
      KNOWL_MCP_TOOL_NAMES.includes('knowl_task_start') &&
      KNOWL_MCP_TOOL_NAMES.includes('knowl_task_checkpoint') &&
      KNOWL_MCP_TOOL_NAMES.includes('knowl_task_finish');
    checks.push({
      status: hasWorkLoop ? 'OK' : 'WARN',
      message: hasWorkLoop
        ? 'MCP tools expose work-loop task tools'
        : 'MCP tool surface should expose knowl_task_start, knowl_task_checkpoint, and knowl_task_finish',
    });

    const hasSkills =
      KNOWL_MCP_TOOL_NAMES.includes('knowl_skill_list') &&
      KNOWL_MCP_TOOL_NAMES.includes('knowl_skill_read') &&
      KNOWL_MCP_TOOL_NAMES.includes('knowl_skill_run');
    checks.push({
      status: hasSkills ? 'OK' : 'WARN',
      message: hasSkills
        ? 'MCP tools expose learned skill bridge tools'
        : 'MCP tool surface should expose knowl_skill_list, knowl_skill_read, and knowl_skill_run',
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
    if (check.fix) {
      lines.push(`      Fix: ${check.fix}`);
    }
  }

  lines.push('');
  lines.push(`Result: ${result.ready ? 'READY' : 'NOT READY'}`);

  return lines.join('\n');
}
