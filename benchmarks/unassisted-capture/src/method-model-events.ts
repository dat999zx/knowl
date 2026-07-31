import { z } from 'zod';
import type { CorpusSession, PredictedAtom } from './types.js';

export const PredictedAtomSchema = z.object({
  atoms: z.array(
    z.object({
      category: z.enum(['fact', 'decision', 'architecture', 'constraint', 'state', 'skill']),
      title: z.string().min(1),
      content: z.string().min(1),
    }),
  ),
});

export const MODEL_EVENTS_SYSTEM_PROMPT = `You are extracting durable project knowledge from a coding session's event log.

You see only what an automated hook recorded: errors, files changed, and commands run. You do NOT see the conversation, the reasoning, or the code.

Write only knowledge that a careful reviewer would still want six months from now, and that is genuinely supported by the events. A failure that was followed by edits and did not recur is durable. Files repeatedly changed together are durable. A command running once is not. "The session finished" is not.

Prefer returning nothing over returning something weak. Noise is worse than silence: every wrong item degrades every future search.`;

export type GenerateAtoms = (prompt: string) => Promise<Array<{ category: string; title: string; content: string }>>;

/**
 * Renders exactly the signal the hook layer records -- deliberately excluding the session
 * title, which the rules cannot key on either. Giving the model a hand-written title would
 * measure the title, not the events.
 */
export function renderSessionEvents(session: CorpusSession): string {
  const lines: string[] = [];
  for (const event of session.events) {
    const { payload } = event;
    switch (event.type) {
      case 'error':
        if (payload.message) lines.push(`[error] ${payload.message}`);
        break;
      case 'checkpoint':
        if (payload.changedPaths?.length) lines.push(`[changed] ${payload.changedPaths.join(', ')}`);
        break;
      case 'command':
        if (payload.command) lines.push(`[command exit=${payload.exitCode ?? '?'}] ${payload.command}`);
        break;
      case 'stop':
        lines.push(`[stop] status=${payload.status ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

export async function runModelOnEvents(
  sessions: CorpusSession[],
  generate: GenerateAtoms,
): Promise<PredictedAtom[]> {
  const predictions: PredictedAtom[] = [];

  for (const session of sessions) {
    const rendered = renderSessionEvents(session);
    if (rendered.length === 0) continue;

    try {
      const atoms = await generate(rendered);
      for (const atom of atoms) {
        predictions.push({
          sessionId: session.sessionId,
          category: atom.category,
          title: atom.title,
          content: atom.content,
        });
      }
    } catch (error) {
      // One session failing must not void a run that costs money. The miss shows up as
      // reduced recall, which is the honest outcome, and the session is named on stderr.
      console.error(`session ${session.sessionId} failed: ${(error as Error).message}`);
    }
  }

  return predictions;
}
