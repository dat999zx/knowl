import type { ProjectConfig } from '../core/types.js';
import { readAutoPushConsent } from '../cloud/consent.js';
import { computePushSnapshot, pushStaged } from '../cloud/publish.js';
import { checkPublishGate } from '../cloud/publish-gate.js';
import { cloudPointer } from '../core/cloud-pointer.js';

export type AutoPushOutcome =
  | { status: 'skipped'; reason: 'not-connected' | 'no-consent' | 'gated' | 'nothing-staged' }
  | { status: 'pushed'; created: number; updated: number }
  | { status: 'failed'; detail: string };

/**
 * Send what was just staged, but only when every gate agrees.
 *
 * CLI-only, deliberately. Decision `9a2fe8a011d6423b` says an agent may stage and only a human
 * may send; consent is the human's standing answer to that, given once per machine, and the MCP
 * surface has no route to this function at all.
 *
 * Four conditions, all required:
 *
 * 1. a cloud pointer, or there is nothing to send to;
 * 2. **consent stored under `knowlHome()`** -- never read from project config, which is
 *    committable and would let one person enable this for a whole team;
 * 3. the publish gate, unrelaxed. Auto-push waits for the default branch like every other push;
 * 4. a snapshot that still matches. Consent replaces the PROMPT, not the binding -- an automatic
 *    push that sent whatever was in the queue at send time would reintroduce exactly the race
 *    the snapshot closes.
 */
export async function maybeAutoPush(input: {
  projectRoot: string;
  config: ProjectConfig;
}): Promise<AutoPushOutcome> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'skipped', reason: 'not-connected' };

  if (!await readAutoPushConsent(pointer.workspaceId)) {
    return { status: 'skipped', reason: 'no-consent' };
  }

  // Checked here as well as inside `pushStaged` so a skip can be reported as "waiting on the
  // branch" rather than as a failed push.
  if (!checkPublishGate(input.projectRoot).ok) return { status: 'skipped', reason: 'gated' };

  const snapshot = await computePushSnapshot({ projectRoot: input.projectRoot, config: input.config });
  if (snapshot.items.length === 0) return { status: 'skipped', reason: 'nothing-staged' };

  // Not strict: an atom staged between the snapshot and the send goes in the next push, which is
  // the correct outcome for an unattended one. A CHANGED atom still refuses.
  const result = await pushStaged({ projectRoot: input.projectRoot, config: input.config, snapshot });

  if (result.status === 'pushed') {
    return { status: 'pushed', created: result.created, updated: result.updated };
  }
  return { status: 'failed', detail: result.status };
}
