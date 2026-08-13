import type { ProjectConfig } from '../core/types.js';
import { readAutoPushConsent } from '../cloud/consent.js';
import { computePushSnapshot, pushStaged } from '../cloud/publish.js';
import { cloudPointer } from '../core/cloud-pointer.js';

export type AutoPushOutcome =
  | { status: 'skipped'; reason: 'not-connected' | 'no-consent' | 'nothing-staged' }
  | { status: 'pushed'; created: number; updated: number }
  | { status: 'failed'; detail: string };

/**
 * Send what was just staged, when consent and the snapshot both agree.
 *
 * CLI-only, deliberately. Decision `9a2fe8a011d6423b` says an agent may stage and only a human
 * may send; consent is the human's standing answer to that, given once per machine, and the MCP
 * surface has no route to this function at all.
 *
 * Three conditions, all required:
 *
 * 1. a cloud pointer, or there is nothing to send to;
 * 2. **consent stored under `knowlHome()`** -- never read from project config, which is
 *    committable and would let one person enable this for a whole team;
 * 3. a snapshot that still matches. Consent replaces the PROMPT, not the binding -- an automatic
 *    push that sent whatever was in the queue at send time would reintroduce exactly the race
 *    the snapshot closes.
 *
 * There was a fourth: the default-branch gate. Removed 2026-08-13 with the gate itself, because
 * it silently dropped a colleague's non-code knowledge and reported only `gated` to a caller
 * that shows the user nothing.
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
