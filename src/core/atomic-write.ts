import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Replace a file's contents in one observable step.
 *
 * A direct `writeFile` truncates first, so an interrupted write leaves a half file that
 * `loadConfig` cannot parse, and two concurrent writers can interleave. The temporary lives in
 * the same directory so the rename stays on one filesystem, and the contents are flushed before
 * the rename makes them visible.
 *
 * `mode` is applied at create time and again after, because a permissive umask can widen the
 * mode passed to `open`.
 */
export async function writeFileAtomic(
  target: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = path.dirname(target);
  const staged = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(staged, 'w', options.mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.mode !== undefined) await fs.chmod(staged, options.mode).catch(() => {});
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}
