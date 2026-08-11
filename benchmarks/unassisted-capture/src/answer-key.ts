import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AnswerKey } from './types.js';

const DEFAULT_ANSWER_KEY = path.join('benchmarks', 'unassisted-capture', 'answer-key', 'gold.ndjson');

const GoldItemSchema = z.object({
  targetId: z.string().min(1),
  canonicalFact: z.string().trim().min(1),
  mark: z.enum(['findable', 'thinking-only']),
});

const AnswerKeySchema = z.object({
  sessionId: z.string().min(1),
  targets: z.array(GoldItemSchema),
});

export function parseAnswerKey(ndjson: string): AnswerKey[] {
  const keys: AnswerKey[] = [];
  const seenSessions = new Set<string>();
  const seenTargets = new Set<string>();

  // Line numbers are the ones in the file, counted before blank lines are skipped. This key is
  // hand-written; an error that points at the wrong line costs more than it saves.
  const rawLines = ndjson.split('\n');
  for (const [index, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const lineNumber = index + 1;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new Error(`Answer key line ${lineNumber} is not valid JSON: ${(error as Error).message}`, { cause: error });
    }

    const parsed = AnswerKeySchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Answer key line ${lineNumber} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    const key = parsed.data;
    if (seenSessions.has(key.sessionId)) {
      throw new Error(`Answer key line ${lineNumber}: duplicate session ${key.sessionId}`);
    }
    seenSessions.add(key.sessionId);
    for (const target of key.targets) {
      if (seenTargets.has(target.targetId)) {
        throw new Error(`Answer key line ${lineNumber}: duplicate targetId ${target.targetId}`);
      }
      seenTargets.add(target.targetId);
    }
    keys.push(key);
  }

  return keys;
}

export async function loadAnswerKey(file: string = DEFAULT_ANSWER_KEY): Promise<AnswerKey[]> {
  return parseAnswerKey(await fs.readFile(file, 'utf8'));
}
