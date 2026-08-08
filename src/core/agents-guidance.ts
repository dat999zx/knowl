import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_GUIDANCE_END_MARKER,
  KNOWL_GUIDANCE_START_MARKER,
  renderManagedKnowlGuidanceSection,
} from './knowl-guidance.js';

export type GuidanceInstallStatus = 'created' | 'updated' | 'unchanged';

export interface KnowlProjectGuidanceInstallResult {
  knowl: GuidanceInstallStatus;
  agents: GuidanceInstallStatus;
}

export function stripManagedKnowlGuidance(source: string): string {
  let current = source;
  while (true) {
    const start = current.indexOf(KNOWL_GUIDANCE_START_MARKER);
    if (start < 0) return current.replaceAll(KNOWL_GUIDANCE_END_MARKER, '');
    const end = current.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
    const replacementEnd = end < 0 ? current.length : end + KNOWL_GUIDANCE_END_MARKER.length;
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(replacementEnd).trimStart();
    current = [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
  }
}

/**
 * Line endings are not guidance.
 *
 * Everything here composes with `\n`, and a checkout with `core.autocrlf` holds `\r\n` — so an
 * exact comparison calls a perfectly current file stale on Windows, forever, with no action that
 * fixes it: writing LF makes the check pass until the next checkout restores CRLF. That is
 * survivable while staleness is advisory and not once it blocks `doctor`'s verdict, which is how
 * it was found — `doctor` reported NOT READY on this repository minutes after the severity
 * changed, while `docs:check`, which already normalised, called the same files current.
 */
function sameIgnoringLineEndings(left: string, right: string): boolean {
  return left.replaceAll('\r\n', '\n') === right.replaceAll('\r\n', '\n');
}

function normalizeManagedFile(source: string, managed: string): string {
  // Normalised to LF before anything is composed, and converted back once at the end.
  //
  // Skipping the first half turns `\r\n` into `\r\r\n`: the unmanaged half of a CRLF file already
  // carries `\r\n`, and re-expanding every `\n` doubles the carriage return on each of its lines.
  // The file then never compares equal to itself and `doctor` calls it stale forever. Same order
  // `scripts/generate-docs.ts` uses, for the same reason.
  const unmanaged = stripManagedKnowlGuidance(source.replaceAll('\r\n', '\n')).trimEnd();
  const next = unmanaged.length > 0 ? `${unmanaged}\n\n${managed}` : managed;
  // Written back in the endings the file already used, so refreshing guidance never rewrites
  // every line of a CRLF file as a side effect of touching the managed block.
  return source.includes('\r\n') ? next.replaceAll('\n', '\r\n') : next;
}

function isManagedFileCurrent(source: string, managed: string): boolean {
  const startCount = source.split(KNOWL_GUIDANCE_START_MARKER).length - 1;
  const endCount = source.split(KNOWL_GUIDANCE_END_MARKER).length - 1;
  return startCount === 1 && endCount === 1
    && sameIgnoringLineEndings(normalizeManagedFile(source, managed), source);
}

async function installManagedFile(
  filePath: string,
  createPrefix: string,
): Promise<GuidanceInstallStatus> {
  const managed = renderManagedKnowlGuidanceSection();
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === undefined) {
    await fs.writeFile(filePath, `${createPrefix}${managed}`, 'utf8');
    return 'created';
  }
  const next = normalizeManagedFile(existing, managed);
  // Same rule as the check: a file that differs only in line endings is already current, and
  // rewriting it would churn every line to no effect.
  if (sameIgnoringLineEndings(next, existing)) return 'unchanged';
  await fs.writeFile(filePath, next, 'utf8');
  return 'updated';
}

export async function installKnowlProjectGuidance(projectRoot: string): Promise<KnowlProjectGuidanceInstallResult> {
  return {
    knowl: await installManagedFile(path.join(projectRoot, 'KNOWL.md'), ''),
    agents: await installManagedFile(path.join(projectRoot, 'AGENTS.md'), '# Agent Instructions\n\n'),
  };
}

export async function isKnowlProjectGuidanceCurrent(projectRoot: string): Promise<boolean> {
  const managed = renderManagedKnowlGuidanceSection();
  try {
    const [knowl, agents] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'KNOWL.md'), 'utf8'),
      fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'),
    ]);
    return isManagedFileCurrent(knowl, managed) && isManagedFileCurrent(agents, managed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
