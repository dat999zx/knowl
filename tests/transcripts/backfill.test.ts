import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { rebuildTranscriptIndex } from '../../src/transcripts/backfill.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';

let dir: string;
let projectsDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-backfill-'));
  projectsDir = path.join(dir, 'projects');
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed: Windows keeps the database locked for the life of the process.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

async function writeConfig(enabled: boolean) {
  await fs.writeFile(
    path.join(dir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled }, vector: { enabled: false } },
    }),
  );
}

async function seedTranscript(lines = line('a durable finding')) {
  const repoDir = path.join(projectsDir, encodeProjectDir(path.resolve(dir)));
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'a.jsonl'), lines);
}

describe('rebuildTranscriptIndex', () => {
  it('refuses when the feature is disabled', async () => {
    await writeConfig(false);
    await seedTranscript();

    await expect(rebuildTranscriptIndex(dir, { projectsDir })).rejects.toThrow(/not enabled/i);
  });

  it('creates no database file when the feature is disabled', async () => {
    await writeConfig(false);
    await rebuildTranscriptIndex(dir, { projectsDir }).catch(() => {});

    await expect(fs.access(path.join(dir, '.knowl', 'transcripts.db'))).rejects.toThrow();
  });

  it('indexes transcripts when enabled', async () => {
    await writeConfig(true);
    await seedTranscript();

    const result = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(result.indexed).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('reports why embedding was skipped when vector search is off', async () => {
    await writeConfig(true);
    await seedTranscript();

    const result = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(result.embedded).toBe(0);
    expect(result.skippedEmbedding).toMatch(/vector search/i);
  });

  it('is idempotent', async () => {
    await writeConfig(true);
    await seedTranscript();

    await rebuildTranscriptIndex(dir, { projectsDir });
    const second = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(second.indexed).toBe(0);
  });

  // The budget is a stopping point, not a rollback: whatever finished stays indexed and the
  // next run resumes from the watermark.
  it('keeps what it indexed when the budget runs out', async () => {
    await writeConfig(true);
    await seedTranscript(Array.from({ length: 5_000 }, (_, i) => line(`finding ${i}`)).join(''));

    const stopped = await rebuildTranscriptIndex(dir, { projectsDir, budgetMinutes: 0.002 }); // ~120ms
    expect(stopped.complete).toBe(false);
    expect(stopped.indexed).toBeGreaterThan(0);
    expect(stopped.indexed).toBeLessThan(5_000);

    const resumed = await rebuildTranscriptIndex(dir, { projectsDir });
    expect(resumed.complete).toBe(true);
    expect(stopped.indexed + resumed.indexed).toBe(5_000);
  }, 60_000);
});
