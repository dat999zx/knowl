import fs from 'node:fs/promises';
import path from 'node:path';

export type GitignoreInstallStatus = 'created' | 'updated' | 'unchanged';

const KNOWL_IGNORE_ENTRY = '.knowl/';

export async function installKnowlGitignoreEntry(projectRoot: string): Promise<GitignoreInstallStatus> {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    const existing = await fs.readFile(gitignorePath, 'utf-8');
    const lines = existing.split(/\r?\n/).map(line => line.trim());
    if (lines.includes(KNOWL_IGNORE_ENTRY) || lines.includes('.knowl')) {
      return 'unchanged';
    }

    const separator = existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(gitignorePath, `${existing}${separator}${KNOWL_IGNORE_ENTRY}\n`, 'utf-8');
    return 'updated';
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await fs.writeFile(gitignorePath, `${KNOWL_IGNORE_ENTRY}\n`, 'utf-8');
    return 'created';
  }
}
