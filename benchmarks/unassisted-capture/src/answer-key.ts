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
  exclusions: z.array(z.string()).default([]),
});

export function parseAnswerKey(ndjson: string): AnswerKey[] {
  const keys: AnswerKey[] = [];
  const seenSessions = new Set<string>();
  const seenTargets = new Set<string>();

  const lines = ndjson.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const parsed = AnswerKeySchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Answer key line ${index + 1} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    const key = parsed.data;
    if (seenSessions.has(key.sessionId)) {
      throw new Error(`Answer key line ${index + 1}: duplicate session ${key.sessionId}`);
    }
    seenSessions.add(key.sessionId);
    for (const target of key.targets) {
      if (seenTargets.has(target.targetId)) {
        throw new Error(`Answer key line ${index + 1}: duplicate targetId ${target.targetId}`);
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
