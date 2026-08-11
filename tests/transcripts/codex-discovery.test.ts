import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTranscriptFiles, scanTranscriptArchive } from '../../src/transcripts/paths.js';
import { extractProse, readOpeningAsk } from '../../src/transcripts/parse.js';

let codexSessionsDir: string;
let projectsDir: string;

const ROOT = path.resolve(process.platform === 'win32' ? 'd:\\coding\\knowl' : '/coding/knowl');
const OTHER = path.resolve(process.platform === 'win32' ? 'd:\\coding\\auction' : '/coding/auction');

beforeEach(async () => {
  codexSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-codex-'));
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-claude-'));
});

afterEach(async () => {
  await fs.rm(codexSessionsDir, { recursive: true, force: true });
  await fs.rm(projectsDir, { recursive: true, force: true });
});

/**
 * A session file in the real shape: date-partitioned path, `session_meta` first with the project
 * in `payload.cwd`, and `base_instructions` after it — the large field whose position is the
 * reason the header read is bounded rather than whole-line.
 */
async function writeSession(
  relative: string,
  cwd: string,
  lines: unknown[] = [],
  options: { padding?: number } = {},
) {
  const target = path.join(codexSessionsDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const meta = {
    timestamp: '2026-03-22T14:17:26.166Z',
    type: 'session_meta',
    payload: {
      id: '019d15e7-d37e-7e93-886c-2429599f27cd',
      timestamp: '2026-03-22T14:16:47.763Z',
      cwd,
      originator: 'codex_vscode',
      base_instructions: { text: 'x'.repeat(options.padding ?? 20_000) },
    },
  };
  const body = [meta, ...lines].map(line => JSON.stringify(line)).join('\n') + '\n';
  await fs.writeFile(target, body);
  return target;
}

const codexMessage = (role: string, text: string, kind = role === 'user' ? 'input_text' : 'output_text') => ({
  timestamp: '2026-03-22T14:18:00.000Z',
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: kind, text }] },
});

describe('Codex transcript discovery', () => {
  it('finds a session by the project recorded inside the file', async () => {
    // The whole reason Codex needs its own discovery: the path carries a date and a UUID and
    // says nothing about which project the session belongs to.
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-d37e-7e93-886c-2429599f27cd.jsonl', ROOT);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ harness: 'codex', parentSessionId: null });
  });

  it('takes the session id from the rollout name, dropping the date prefix', async () => {
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-d37e-7e93-886c-2429599f27cd.jsonl', ROOT);

    const [file] = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(file.sessionId).toBe('019d15e7-d37e-7e93-886c-2429599f27cd');
  });

  it('leaves another project\'s sessions alone', async () => {
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-aaaa-7e93-886c-2429599f27cd.jsonl', ROOT);
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-48-019d15e7-bbbb-7e93-886c-2429599f27cd.jsonl', OTHER);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(found.map(file => file.sessionId)).toEqual(['019d15e7-aaaa-7e93-886c-2429599f27cd']);
  });

  it('matches a cwd whose drive letter is cased differently', async () => {
    // Not hypothetical: one real archive held 128 sessions under `D:\coding\knowl` and 9 under
    // `d:\coding\knowl`, for one repository. The case follows however the agent was launched.
    const swapped = ROOT[0] === ROOT[0].toLowerCase()
      ? ROOT[0].toUpperCase() + ROOT.slice(1)
      : ROOT[0].toLowerCase() + ROOT.slice(1);
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-cccc-7e93-886c-2429599f27cd.jsonl', swapped);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(found).toHaveLength(1);
  });

  it('finds the cwd even when the header is far larger than the bounded read', async () => {
    // The fallback path. `cwd` precedes `base_instructions` in every real record, but a header
    // ordered the other way must degrade to a full-line parse rather than to silence.
    const target = path.join(codexSessionsDir, '2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-dddd-7e93-886c-2429599f27cd.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify({
      type: 'session_meta',
      payload: { base_instructions: { text: 'x'.repeat(40_000) }, cwd: ROOT },
    })}\n`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(found).toHaveLength(1);
  });

  it('skips a file with no readable header rather than claiming it', async () => {
    const target = path.join(codexSessionsDir, '2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-eeee-7e93-886c-2429599f27cd.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'not json at all\n');

    await expect(discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir })).resolves.toEqual([]);
  });

  it('reports an absent Codex archive as empty, not degraded', async () => {
    const scan = await scanTranscriptArchive(ROOT, {
      projectsDir,
      codexSessionsDir: path.join(codexSessionsDir, 'nope'),
    });

    expect(scan.files).toEqual([]);
    expect(scan.degraded).toBe(false);
  });

  it('does not read the real ~/.codex when the caller redirected the Claude archive', async () => {
    // The isolation rule. Without it, every discovery test in this repo silently returned this
    // machine's own sessions alongside its fixtures -- which is exactly what happened.
    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found).toEqual([]);
  });

  it('merges both harnesses into one list, each labelled', async () => {
    const { encodeProjectDir } = await import('../../src/transcripts/paths.js');
    const claudeDir = path.join(projectsDir, encodeProjectDir(ROOT));
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'aaa.jsonl'), '{}\n');
    await writeSession('2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-ffff-7e93-886c-2429599f27cd.jsonl', ROOT);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir, codexSessionsDir });

    expect(found.map(file => file.harness).sort()).toEqual(['claude', 'codex']);
  });
});

describe('Codex prose extraction', () => {
  it('reads a user message from input_text', () => {
    expect(extractProse(codexMessage('user', 'how do I add a harness?'))).toMatchObject({
      role: 'user', text: 'how do I add a harness?',
    });
  });

  it('reads an assistant message from output_text', () => {
    expect(extractProse(codexMessage('assistant', 'start with discovery.'))).toMatchObject({
      role: 'assistant', text: 'start with discovery.',
    });
  });

  it('ignores event_msg, which duplicates every assistant turn', () => {
    // Codex writes each assistant turn twice -- once for its UI stream, once as the item that
    // went to the model. Reading both would put every assistant message in the index twice.
    expect(extractProse({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'start with discovery.' },
    })).toBeNull();
  });

  it('ignores reasoning, which is not what was said', () => {
    expect(extractProse({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAA...' },
    })).toBeNull();
  });

  it('ignores the developer role, which is the injected preamble', () => {
    expect(extractProse(codexMessage('developer', '<permissions instructions>...', 'input_text'))).toBeNull();
  });

  it('still reads a Claude record, because the two shapes are disjoint', () => {
    expect(extractProse({
      type: 'user',
      message: { content: [{ type: 'text', text: 'claude side still works' }] },
      timestamp: '2026-03-22T00:00:00.000Z',
    })).toMatchObject({ role: 'user', text: 'claude side still works' });
  });

  it('does not title a session by the environment preamble Codex opens with', () => {
    // Every Codex session's first user item is this block. Left in, every session in the
    // directory would carry the same opening.
    expect(readOpeningAsk('<environment_context>\n  <cwd>d:\\coding\\knowl</cwd>\n</environment_context>')).toBeNull();
    expect(readOpeningAsk('i need to make a realtime database')).toBe('i need to make a realtime database');
  });
});
