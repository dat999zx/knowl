import path from 'node:path';

/**
 * Canonical form of a project root, for use as a storage or cache key.
 *
 * `path.resolve` alone is not enough on Windows. Its paths are case-insensitive but
 * case-preserving, and the same project arrives with different casing depending on where
 * the value came from: a hook payload's `cwd` reports `D:\project` while `process.cwd()`
 * in the hook process reports `d:\project`. A key built from the unfolded path therefore
 * splits one agent across two rows, each carrying its own change watermark and drift
 * counter — which made an agent's own writes look foreign on its next tool event.
 *
 * POSIX paths are case-sensitive, so `/tmp/Foo` and `/tmp/foo` are genuinely different
 * directories and must not be folded together.
 */
export function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
