import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import { lexicalRank, toMatchQuery } from '../../src/transcripts/search.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';
// Derived, not hardcoded: path.resolve is platform-dependent for this literal. See
// tests/transcripts/paths.test.ts.
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-lex-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, ENCODED_ROOT), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

async function seed(session: string, lines: string) {
  await fs.writeFile(path.join(projectsDir, ENCODED_ROOT, `${session}.jsonl`), lines);
}

async function indexed() {
  await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
  return openTranscriptDb(dbPath);
}

describe('toMatchQuery', () => {
  it('quotes each token so punctuation cannot become FTS5 syntax', () => {
    expect(toMatchQuery('embedding crash')).toBe('"embedding" OR "crash"');
  });

  it('escapes characters FTS5 would treat as operators instead of deleting them', () => {
    // Doubling the quote is the escape the FTS5 grammar defines; stripping it was what
    // destroyed the token before the tokenizer ever saw it.
    expect(toMatchQuery('OOM: why "now"?')).toBe('"OOM:" OR "why" OR """now""?"');
  });

  it('keeps a dotted or hyphenated token whole so the tokenizer can split it', () => {
    // The whole point: `"index-pass.ts"` is handed to the tokenizer, which produces the
    // phrase [index, pass, ts] -- what the index actually holds. The glued spelling rides
    // along so a search for `re-index` still finds a message that wrote `reindex`.
    expect(toMatchQuery('index-pass.ts')).toBe('"index-pass.ts" OR "indexpassts"');
    expect(toMatchQuery('src/transcripts')).toBe('"src/transcripts" OR "srctranscripts"');
  });

  it('leaves ordinary prose exactly as it was', () => {
    expect(toMatchQuery('the watermark logic')).toBe('"the" OR "watermark" OR "logic"');
  });

  it('returns null when nothing searchable remains', () => {
    expect(toMatchQuery('   ***   ')).toBeNull();
  });
});

describe('lexicalRank', () => {
  it('finds a message by its words', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'reindex memory', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].sessionId).toBe('a');
  });

  it('ranks a user message above an assistant message of equal relevance', async () => {
    await seed('a', line('assistant', 'quantization tradeoffs matter') + line('user', 'quantization tradeoffs matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'quantization tradeoffs', 10);

    expect(hits[0].role).toBe('user');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('scopes to one session by full id', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'alpha');

    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('alpha');
  });

  it('scopes to one session by unique id prefix', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'alp');

    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('alpha');
  });

  it('returns nothing for a session id that matches no transcript', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    const client = await indexed();

    expect(await lexicalRank(client, 'shared subject', 10, 'nosuchsession')).toEqual([]);
  });

  it('respects the limit', async () => {
    await seed('a', Array.from({ length: 10 }, (_, i) => line('user', `repeated topic number ${i}`)).join(''));
    const client = await indexed();

    expect(await lexicalRank(client, 'repeated topic', 3)).toHaveLength(3);
  });

  it('returns nothing for a query with no searchable tokens', async () => {
    await seed('a', line('user', 'anything'));
    const client = await indexed();

    expect(await lexicalRank(client, '***', 10)).toEqual([]);
  });

  // Unquoted user input is FTS5 *syntax*, not a term list: a bare `"` is a parse error and
  // NOT/AND/OR are operators. Quoting every token is what keeps a query from throwing.
  it('does not throw on input that is FTS5 syntax', async () => {
    await seed('a', line('user', 'the quoted phrase survives'));
    const client = await indexed();

    for (const hostile of ['"', 'NOT phrase', 'phrase AND', '*', 'a OR (b', 'coffee^2']) {
      await expect(lexicalRank(client, hostile, 5)).resolves.toBeDefined();
    }
  });
});

describe('sessionId scoping treats wildcards literally', () => {
  // `sessionId` arrives from an MCP argument. Before escaping, `%` turned "restrict to this
  // session" into "match every session" -- silently widening the thing the caller narrowed.
  it('does not let % match every session', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    expect(await lexicalRank(client, 'shared subject', 10, '%')).toEqual([]);
  });

  it('does not let _ stand in for a character', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    const client = await indexed();

    expect(await lexicalRank(client, 'shared subject', 10, '_lpha')).toEqual([]);
  });

  it('still scopes by a genuine prefix', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'alp');
    expect(hits.map(hit => hit.sessionId)).toEqual(['alpha']);
  });

  it('matches a session whose id genuinely contains an underscore', async () => {
    await seed('a_b', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'a_b');
    expect(hits.map(hit => hit.sessionId)).toEqual(['a_b']);
  });
});
