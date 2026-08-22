import path from 'node:path';
import { KNOWL_GUIDANCE_START_MARKER } from '../../core/knowl-guidance.js';
import { stripManagedKnowlGuidance } from '../../core/agents-guidance.js';
import { MergeStatus, readTextIfExists, writeWithBackup } from './files.js';

export type NativeInstructionHost = 'claude';

const HOST_INSTRUCTIONS = {
  claude: { file: 'CLAUDE.md', importLine: '@KNOWL.md' },
} as const;

function hasActiveGuidanceImport(source: string): boolean {
  const withoutComments = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  let fenced = false;
  const visible: string[] = [];
  for (const line of withoutComments.split(/\r?\n/)) {
    if (/^(?: {4}|\t)/.test(line)) continue;
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) visible.push(line.replace(/(`+).*?\1/g, ''));
  }
  return /@(?:\.\/)?(?:KNOWL|AGENTS)\.md(?=$|[\s),;:!?'"\]}]|[.](?=\s|$))/.test(visible.join('\n'));
}

export async function installKnowlHostInstructions(
  projectRoot: string,
  host: NativeInstructionHost,
): Promise<MergeStatus> {
  const target = HOST_INSTRUCTIONS[host];
  const pathname = path.join(projectRoot, target.file);
  const existing = await readTextIfExists(pathname);
  if (existing === undefined) {
    await writeWithBackup(pathname, `${target.importLine}\n`);
    return 'configured';
  }
  const cleaned = stripManagedKnowlGuidance(existing);
  const next = hasActiveGuidanceImport(cleaned)
    ? cleaned
    : `${target.importLine}\n${cleaned.length > 0 ? `\n${cleaned}` : ''}`;
  if (next === existing) return 'unchanged';
  await writeWithBackup(pathname, next, existing);
  return 'updated';
}

export async function verifyKnowlHostInstructions(
  projectRoot: string,
  host: NativeInstructionHost,
): Promise<boolean> {
  const source = await readTextIfExists(path.join(projectRoot, HOST_INSTRUCTIONS[host].file));
  return source !== undefined
    && !source.includes(KNOWL_GUIDANCE_START_MARKER)
    && hasActiveGuidanceImport(source);
}
