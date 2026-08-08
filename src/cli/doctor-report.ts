import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { findProjectRoot, loadConfig } from '../core/config.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { workspaceDoctorChecks } from './workspace-report.js';
import { vectorCoverageCheck } from './vector-coverage.js';
import { isKnowlProjectGuidanceCurrent } from '../core/agents-guidance.js';
import { closeDb, getDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { runLexicalCoverage, runRetrievalProbe } from './retrieval-probe.js';
import { KNOWL_MCP_TOOL_NAMES } from '../core/knowl-guidance.js';
import { getVectorSearchConfig, isVectorSearchEnabled } from '../ai/embeddings.js';
import { fingerprintProfile, resolveVectorProfile } from '../core/vector-profile.js';
import { auditKnowledgeStore } from '../store/integrity.js';
import { assertKnowledgeDatabasePresent } from './database-presence.js';
import { createAgentRegistry } from './agents/registry.js';
import type { DoctorRemedy } from './doctor-remedy.js';

type DoctorStatus = 'OK' | 'WARN' | 'FAIL';

export type DoctorCheck = {
  status: DoctorStatus;
  message: string;
  /** Prose for a human to read and run. */
  fix?: string;
  /** The same repair in a form `doctor --fix` can execute. Absent where none is safe. */
  remedy?: DoctorRemedy;
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

    // FAIL, not WARN, and this is the one check where that distinction is worth arguing.
    //
    // Every other WARN here means an optional thing is not configured -- no vector provider, no
    // work loop, `.knowl` not gitignored. Guidance staleness is not optional-anything: the block
    // between the markers is owned by Knowl and rewritten wholesale by `installKnowlProjectGuidance`,
    // while anything outside it is preserved. So a difference there is never a preference. It is
    // always this project holding instructions some other version of Knowl wrote.
    //
    // Which makes READY a lie in the case that matters most. The lifecycle hook injects its
    // guidance card from the RUNNING build while the host reads KNOWL.md from disk, so a stale
    // file does not merely under-inform the agent -- it contradicts the card in the same session.
    // Measured 2026-08-08: a `knowl` command run against a stale `dist/` reverted guidance that
    // had just landed, and `doctor` went on reporting READY while agents were told to look for a
    // per-row `repo` field the response shape no longer had.
    //
    // The obvious objection -- that this flips every install that upgraded the CLI without
    // re-initialising -- was checked: `knowl upgrade` and `knowl init` both call
    // `installKnowlProjectGuidance`, so staleness survives neither. What is left is a project
    // nobody has upgraded, where NOT READY is the honest answer, and the remedy is already wired
    // here as `{ kind: 'guidance' }` for `doctor --fix`.
    const guidanceCurrent = await isKnowlProjectGuidanceCurrent(root);
    checks.push({
      status: guidanceCurrent ? 'OK' : 'FAIL',
      message: guidanceCurrent
        ? 'KNOWL.md and AGENTS.md guidance current'
        : 'KNOWL.md or AGENTS.md Knowl guidance missing or stale; agents are reading instructions this version did not write. Run knowl init',
      fix: guidanceCurrent ? undefined : 'run `knowl init` (or `knowl doctor --fix`)',
      remedy: guidanceCurrent ? undefined : { kind: 'guidance' },
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
      remedy: ignoresKnowl ? undefined : { kind: 'gitignore' },
    });

    // `doctor` is exempt from the preAction missing-database guard so it can run precisely when
    // something is wrong. That exemption was only ever meant to skip the *throw*, never to
    // license the write: `initDb` opens a libSQL `file:` URL, and opening one CREATES it. So
    // diagnosing a repository whose database had gone missing rebuilt an empty one, reported
    // `[OK] Local project store ready`, and from then on the guard could never fire again --
    // the file exists. `knowl-sync` runs doctor in every repository on this machine, which made
    // routine maintenance the trigger that turned a recoverable move into a certified-healthy
    // empty store. Ask the same question the guard asks, and let the catch below report it.
    assertKnowledgeDatabasePresent(root);

    await initDb(root);
    dbOpen = true;
    const integrity = await auditKnowledgeStore(config.security);
    // Report errors and warnings separately: the old message called everything a
    // "warning" while failing on errors, and pointed at "repair reported records" when
    // `knowl audit` is read-only and no repair command exists. A fix hint has to name
    // something the reader can actually run.
    const integrityErrors = integrity.findings.filter(finding => finding.severity === 'error').length;
    const integrityWarnings = integrity.findings.length - integrityErrors;
    checks.push({
      // A warning-only audit reports WARN rather than OK. It stamped [OK] and then printed a
      // Fix line under it, which is a report contradicting itself, and one of the findings it
      // hid this way is `missing-index-row` -- the exact condition the retrieval self-test
      // below fails on. Safe to say out loud only now that WARN no longer decides the verdict:
      // before, any integrity warning anywhere would have reported the whole repository broken.
      status: integrityErrors > 0 ? 'FAIL' : integrityWarnings > 0 ? 'WARN' : 'OK',
      message: integrity.findings.length === 0
        ? 'Knowledge integrity audit passed'
        : `Knowledge integrity audit found ${integrityErrors} error(s) and ${integrityWarnings} warning(s)`,
      fix: integrity.findings.length === 0
        ? undefined
        // Only name commands that exist: there is no `knowl update`, so a secret finding
        // is cleared either by retiring the item or by changing the security setting.
        : 'run `knowl audit` to list the records, then retire an item with `knowl supersede <itemId> <replacementId>` or adjust security settings with `knowl config`',
    });
    try {
      await (getDb() as any).all(sql`SELECT 1 FROM knowledge_embeddings LIMIT 1`);
      checks.push({ status: 'OK', message: 'Database schema includes knowledge_embeddings' });
    } catch {
      checks.push({ status: 'WARN', message: 'Database schema missing knowledge_embeddings; run knowl upgrade' });
    }
    try {
      await (getDb() as any).all(sql`SELECT 1 FROM code_symbols LIMIT 1`);
      checks.push({ status: 'OK', message: 'Code symbol index schema ready' });
    } catch {
      checks.push({ status: 'WARN', message: 'Code symbol index schema missing; run knowl upgrade' });
    }
    checks.push({ status: 'OK', message: 'Local viewer available through `knowl view`' });
    const configuredNamespaces = [config.memory?.organization, config.memory?.global].filter(entry => entry?.enabled).length;
    checks.push({ status: 'OK', message: `Memory namespaces ready (project/session plus ${configuredNamespaces} optional layer(s))` });
    try {
      await (getDb() as any).all(sql`SELECT 1 FROM memory_sessions LIMIT 1`);
      const stale = await (getDb() as any).all(sql`SELECT 1 FROM memory_sessions WHERE status = 'active' AND last_heartbeat_at < datetime('now', '-2 hours') LIMIT 1`);
      checks.push({
        status: stale.length ? 'WARN' : 'OK',
        message: stale.length ? 'Stale active memory sessions found; run knowl session recover' : 'Memory session schema ready with no stale active sessions',
        fix: stale.length ? 'run `knowl session recover`' : undefined,
        remedy: stale.length ? { kind: 'session-recover' } : undefined,
      });
    } catch {
      checks.push({ status: 'WARN', message: 'Database schema missing memory sessions; run knowl upgrade' });
    }

    // Resolved once. Both coverage checks below filter on the profile that search actually uses,
    // and a store where they disagreed about which profile that is would report a gap in one and
    // full coverage in the other. Null means vector search is off, which the lexical check reads
    // as "there is no semantic fallback".
    const vectorFingerprint = isVectorSearchEnabled(config)
      ? fingerprintProfile(resolveVectorProfile(config))
      : null;

    const project = await getProjectByRootPath(root);
    if (!project) {
      checks.push({ status: 'FAIL', message: 'Project not registered in Knowl database' });
    } else {
      checks.push({ status: 'OK', message: 'Local project store ready' });
      checks.push(await runLexicalCoverage(vectorFingerprint));
      checks.push(await runRetrievalProbe(project.id));
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

    let configuredAgentCount = 0;
    for (const adapter of createAgentRegistry().values()) {
      try {
        const detection = await adapter.detect(root);
        if (!detection.configured) continue;
        configuredAgentCount += 1;
        if (adapter.verifyInstructions) {
          const verified = await adapter.verifyInstructions(root);
          checks.push({
            status: verified ? 'OK' : 'WARN',
            message: verified
              ? `${adapter.name} native instructions configured`
              : `${adapter.name} native instructions missing or stale`,
            fix: verified ? undefined : `run \`knowl init ${adapter.name}\``,
            // Reached only inside `if (detection.configured)`, so an automatic repair can
            // never opt a repository into a host it has not chosen.
            remedy: verified ? undefined : { kind: 'host-init', host: adapter.name },
          });
        }
        const capability = await adapter.lifecycleCapability?.(root) ?? 'unsupported';
        if (capability === 'supported') {
          const verified = await adapter.verifyLifecycle?.(root) ?? false;
          checks.push({
            status: verified ? 'OK' : 'WARN',
            message: verified
              ? `${adapter.name} lifecycle hooks configured`
              : `${adapter.name} lifecycle hooks missing or stale`,
            fix: verified ? undefined : `run \`knowl init ${adapter.name}\``,
            remedy: verified ? undefined : { kind: 'host-init', host: adapter.name },
          });
        } else if (capability === 'degraded') {
          checks.push({
            status: 'WARN',
            message: `${adapter.name} lifecycle hooks degraded; MCP remains available`,
            fix: `run \`knowl init ${adapter.name}\``,
            remedy: { kind: 'host-init', host: adapter.name },
          });
        } else {
          checks.push({ status: 'OK', message: `${adapter.name} lifecycle hooks unsupported; MCP remains available` });
        }
      } catch (error: any) {
        // No remedy: the check itself failed, so what is wrong with the host is unknown and
        // re-running its registration is a guess.
        checks.push({ status: 'WARN', message: `${adapter.name} lifecycle check failed: ${error.message}`, fix: `run \`knowl init ${adapter.name}\`` });
      }
    }
    if (configuredAgentCount === 0) {
      checks.push({ status: 'OK', message: 'No agent MCP integration selected; run `knowl init` to configure one' });
    }

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
      // Coverage, not configuration. "Enabled" was always true and told the user nothing
      // about whether their knowledge is actually reachable by semantic search.
      //
      // Counted under the CURRENT profile fingerprint, because that is what search counts.
      // `searchKnowledgeEmbeddings` and `findEmbeddedItemIds` both filter on
      // `profile_fingerprint`, so a row written under a different model, dtype or pooling --
      // or under none, which is how a pre-migration `serve` process writes -- is unreachable
      // and its item is exactly as invisible as one with no row at all. This join had no
      // such predicate, so it counted those rows as coverage: eight active items in the
      // duckprep store carried a NULL fingerprint, were invisible to every query, and doctor
      // reported `all 470 active item(s) embedded`. A check written to turn a silent
      // permanent gap into a visible one could not see the gap it was written for.
      const fingerprint = vectorFingerprint!;
      const counts = await (getDb() as any).all(sql`
        SELECT
          (SELECT COUNT(*) FROM knowledge_items WHERE status = 'active') AS active,
          (SELECT COUNT(*) FROM knowledge_items i
             JOIN knowledge_embeddings e ON e.knowledge_item_id = i.id
           WHERE i.status = 'active' AND e.profile_fingerprint = ${fingerprint}) AS embedded
      `);
      checks.push(vectorCoverageCheck({
        enabled: true,
        model: `${vector.provider}/${vector.model}`,
        activeItems: Number(counts[0]?.active ?? 0),
        embeddedItems: Number(counts[0]?.embedded ?? 0),
        writeEmbeddingDisabled: process.env.KNOWL_DISABLE_WRITE_EMBEDDING === '1',
      }));
    } else {
      checks.push(vectorCoverageCheck({ enabled: false, model: '', activeItems: 0, embeddedItems: 0 }));
    }
    // Fan-out failures are all silent -- an absent peer, a moved manifest, a drifted
    // embedding identity. This is where they surface.
    checks.push(...workspaceDoctorChecks(await resolveWorkspace(root, config), config));
  } catch (error: any) {
    checks.push({ status: 'FAIL', message: error.message });
  } finally {
    if (dbOpen) {
      await closeDb();
    }
  }

  return {
    // WARN is advisory by definition, so it must not decide the verdict. The old gate was
    // `every(check => check.status === 'OK')`, which collapsed a three-level status into two
    // outcomes and made a freshly initialized repository -- every check OK except "no knowledge
    // stored yet" -- report NOT READY. `knowl init` printed "ready" and `knowl doctor` then
    // called the same install broken, which is how this was found. Advisory findings are not
    // lost: `formatDoctorReport` counts them on the verdict line and the sweep in
    // `upgrade-all.ts` prints each one under its repository.
    ready: checks.every(check => check.status !== 'FAIL'),
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

  // Counted on the verdict line because READY must not read as spotless now that warnings no
  // longer gate it: this is what carries an advisory finding to someone who reads only the last
  // line, which for a long report is most people.
  const warnings = result.checks.filter(check => check.status === 'WARN').length;
  const advisory = warnings > 0 ? ` (${warnings} advisory warning${warnings === 1 ? '' : 's'})` : '';

  lines.push('');
  lines.push(`Result: ${result.ready ? 'READY' : 'NOT READY'}${advisory}`);

  return lines.join('\n');
}
