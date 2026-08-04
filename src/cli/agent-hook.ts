import { findProjectRoot } from '../core/config.js';
import { ProjectNotFoundError } from '../core/errors.js';
import { closeDb, initDb } from '../store/database.js';
import { getProjectByRootPath } from '../store/repository.js';
import { handleHostLifecycleEvent } from '../store/host-lifecycle.js';
import { assertKnowledgeDatabasePresent } from './database-presence.js';
import { readLifecyclePayload } from './agents/lifecycle.js';
import { IncompleteHostHookPayloadError, normalizeHostHook } from './agents/host-hook.js';
import { hostProfile } from './agents/hosts/index.js';

/**
 * The agent lifecycle hook, in its own module and off the CLI's import graph.
 *
 * This runs once per agent tool call, as a fresh process, so its cost is paid hundreds of
 * times a session -- and it is the only Knowl command with that property. Every other command
 * is typed by a human at most a few times an hour.
 *
 * Bundling the dependencies (the previous perf commit) took the process from ~2900ms to
 * ~175ms. What was left was the module graph the *entry* pulled in at import scope: the MCP
 * server surface, the viewer, the code indexer, the config UI, the AI pipeline and every
 * other command's transitive imports, all evaluated before commander had even looked at
 * argv. A hook needs the store, the host-hook normaliser and nothing else.
 *
 * So `src/index.ts` is now a dispatcher that imports this directly and the command surface
 * only when a command is actually being run. `catchUpTranscripts` stays a dynamic import
 * inside the one branch that uses it, because it reaches the embedding provider and only
 * turn-stop and session-stop events ever get there.
 */
export async function runAgentHook(host: string, event: string): Promise<void> {
  try {
    const payload = await readLifecyclePayload();
    const normalized = normalizeHostHook(host, event, payload);
    const root = await findProjectRoot(normalized.projectRoot);
    normalized.projectRoot = root;
    // Before the store is opened, because opening it is what creates it.
    assertKnowledgeDatabasePresent(root);
    await initDb(root);
    const project = await getProjectByRootPath(root);
    if (!project) throw new Error('Project not found in database.');
    const result = await handleHostLifecycleEvent(project.id, normalized);

    // Best-effort and gated: returns null when transcript search is off, and never throws.
    if (normalized.event === 'turn-stop' || normalized.event === 'session-stop') {
      const { catchUpTranscripts } = await import('../transcripts/catch-up.js');
      await catchUpTranscripts(root);
    }

    if (result.hostOutput) console.log(JSON.stringify(result.hostOutput));
    else if (!hostProfile(normalized.host).nativeOutput) console.log(JSON.stringify(result));
    await closeDb();
  } catch (error: any) {
    // Two silences, for two things that are not faults.
    //
    // An incomplete payload is a host event this build does not carry enough of to record.
    //
    // An unresolvable project is the ordinary case for a hook installed in a host's global
    // settings: it fires in every directory the agent visits, most of which are not Knowl
    // repositories, and a renamed or moved repository puts a session permanently in that
    // state. Reporting it printed an error and exited 1 on every single tool call, with no
    // way to turn it off -- a channel that cries wolf on a normal condition is a channel
    // nobody reads when something is actually wrong. A missing *database* still speaks up
    // (see `assertKnowledgeDatabasePresent`); that one is neither normal nor permanent.
    if (error instanceof IncompleteHostHookPayloadError || error instanceof ProjectNotFoundError) {
      await closeDb().catch(() => {});
      return;
    }
    console.error(`Error handling agent hook: ${error.message}`);
    await closeDb().catch(() => {});
    process.exit(1);
  }
}
