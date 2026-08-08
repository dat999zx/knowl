import { inlineUntrusted } from '../core/untrusted.js';
import { formatResumeBrief, listResumePoints, readResumePoint } from '../session/resume-points.js';

export type ResumeCommandResult = {
  /** `unknown-key` is the only failure; the caller turns it into a non-zero exit. */
  kind: 'brief' | 'list' | 'unknown-key';
  text: string;
};

/**
 * `knowl resume [key]`, as a function rather than inside the commander action.
 *
 * The minted instruction line reads `knowl resume <key>`, and a user will paste that into a
 * terminal as readily as into a chat. A command that did not exist would make the line Knowl
 * itself handed them look broken.
 *
 * The key is passed to `readResumePoint` exactly as typed. It normalizes quotes, casing and a
 * leading `knowl resume `, so a user who quoted the whole line still lands on their brief.
 */
export async function runCliResume(input: {
  /** Only needed to list what is parked *here*; resuming by key never consults it. */
  projectRoot?: string;
  key?: string;
}): Promise<ResumeCommandResult> {
  if (input.key) {
    // No project filter, deliberately: the key is held by the user, and the directory they
    // happen to be sitting in when they paste it says nothing about where they parked it.
    const point = await readResumePoint(input.key);
    if (!point) {
      return {
        kind: 'unknown-key',
        text: 'No parked workstream for that key. Run `knowl resume` with no key to list what is parked here.',
      };
    }
    return { kind: 'brief', text: formatResumeBrief(point) };
  }

  if (!input.projectRoot) {
    return {
      kind: 'list',
      text: 'Not inside a Knowl project, so there is nothing local to list. Paste a resume key to pick up parked work from anywhere.',
    };
  }

  const points = await listResumePoints(input.projectRoot);
  if (points.length === 0) {
    return { kind: 'list', text: 'Nothing is parked in this project.' };
  }

  return {
    kind: 'list',
    // One line per point is the format, so a goal carrying a newline would silently become two
    // and the second would start at column 0. Same containment as the MCP listing beside it.
    text: points.map(point => `${point.key}  ${inlineUntrusted(point.goal)}  (${point.createdAt})`).join('\n'),
  };
}
