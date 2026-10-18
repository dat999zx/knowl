import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { extractProse } from '../../src/transcripts/parse.js';
import {
  buildHermesRepoSessionMap,
  defaultHermesHomeDir,
  defaultHermesStateDbs,
  discoverTranscriptFiles,
  encodeProjectDir,
  hasIndexableArchive,
  isHermesSessionPath,
  readHermesCompactedSummaryText,
  readHermesProseFrom,
} from '../../src/transcripts/paths.js';
import { readMessageAt, readMessagesAt, readMessagesFor, readWithContext } from '../../src/transcripts/read.js';

let hermesHomeDir: string;
let copilotSessionsDir: string;
let codexSessionsDir: string;
let projectsDir: string;

const ROOT = path.resolve(process.platform === 'win32' ? 'd:\\coding\\knowl' : '/coding/knowl');
const OTHER = path.resolve(process.platform === 'win32' ? 'd:\\coding\\auction' : '/coding/auction');

beforeEach(async () => {
  hermesHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-hermes-'));
  copilotSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-'));
  codexSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-codex-'));
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-claude-'));
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(hermesHomeDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(copilotSessionsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(codexSessionsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(projectsDir, { recursive: true, force: true }).catch(() => {});
});

type SeedHermesMessage = {
  role: 'user' | 'assistant' | 'tool' | 'session_meta';
  content: string | null;
  timestamp?: number | string | null;
  active?: number;
  compacted?: number;
  compressedSummary?: number;
  messageUid?: string | null;
  displayKind?: string | null;
};

type SeedHermesSession = {
  id: string;
  source?: string;
  parentSessionId?: string | null;
  cwd?: string | null;
  gitRepoRoot?: string | null;
  systemPrompt?: string | null;
  systemPromptHash?: string | null;
  promptTableText?: string | null;
  title?: string | null;
  titleSource?: string | null;
  displayName?: string | null;
  startedAt?: number;
  lastActivityAt?: number | null;
  messages?: SeedHermesMessage[];
};

async function createHermesStateDb(
  dbPath: string,
  sessions: SeedHermesSession[],
): Promise<string> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const client = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS system_prompts (
        hash TEXT PRIMARY KEY,
        prompt TEXT NOT NULL
      );
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        parent_session_id TEXT,
        cwd TEXT,
        git_repo_root TEXT,
        system_prompt TEXT,
        system_prompt_hash TEXT,
        title TEXT,
        title_source TEXT,
        display_name TEXT,
        started_at REAL,
        ended_at REAL,
        last_activity_at REAL,
        message_count INTEGER DEFAULT 0
      );
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL,
        active INTEGER DEFAULT 1,
        compacted INTEGER DEFAULT 0,
        _compressed_summary INTEGER DEFAULT 0,
        message_uid TEXT,
        display_kind TEXT
      );
    `);

    for (const s of sessions) {
      if (s.systemPromptHash && s.promptTableText) {
        await client.execute({
          sql: 'INSERT OR REPLACE INTO system_prompts (hash, prompt) VALUES (?, ?)',
          args: [s.systemPromptHash, s.promptTableText],
        });
      }
      const msgs = s.messages ?? [];
      await client.execute({
        sql: `INSERT INTO sessions
                (id, source, parent_session_id, cwd, git_repo_root, system_prompt, system_prompt_hash,
                 title, title_source, display_name, started_at, last_activity_at, message_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          s.id,
          s.source ?? 'cli',
          s.parentSessionId ?? null,
          s.cwd ?? null,
          s.gitRepoRoot ?? null,
          s.systemPrompt ?? null,
          s.systemPromptHash ?? null,
          s.title ?? null,
          s.titleSource ?? 'derived',
          s.displayName ?? null,
          s.startedAt ?? 1792300000,
          s.lastActivityAt ?? s.startedAt ?? 1792300000,
          msgs.length,
        ],
      });
      for (const [idx, m] of msgs.entries()) {
        await client.execute({
          sql: `INSERT INTO messages
                  (session_id, role, content, timestamp, active, compacted, _compressed_summary, message_uid, display_kind)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            s.id,
            m.role,
            m.content,
            m.timestamp ?? (1792300000 + idx),
            m.active ?? 1,
            m.compacted ?? 0,
            m.compressedSummary ?? 0,
            m.messageUid ?? `uid-${s.id}-${idx + 1}`,
            m.displayKind ?? null,
          ],
        });
      }
    }
  } finally {
    client.close();
  }
  return dbPath;
}

describe('Hermes session transcript discovery and parsing', () => {
  it('discovers state.db in default Hermes home and profiles/<name>/state.db while skipping backups, even when HERMES_HOME points inside profiles/<name>', async () => {
    const rootDb = await createHermesStateDb(path.join(hermesHomeDir, 'state.db'), []);
    const profileDb = await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', 'engineer-agent-skills', 'state.db'),
      [],
    );
    const secondProfileDb = await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', 'naresh', 'state.db'),
      [],
    );
    await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', 'sdlc.backup-rename', 'state.db'),
      [],
    );
    await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', '.hidden', 'state.db'),
      [],
    );

    const dbsFromProfilePath = await defaultHermesStateDbs(
      path.join(hermesHomeDir, 'profiles', 'engineer-agent-skills'),
    );
    expect(dbsFromProfilePath.map(d => path.resolve(d)).sort()).toEqual([
      path.resolve(rootDb),
      path.resolve(profileDb),
      path.resolve(secondProfileDb),
    ].sort());
  });

  it('discovers sessions by sessions.cwd, sessions.git_repo_root, or system_prompts runtime cwd/root', async () => {
    const dbPath = await createHermesStateDb(path.join(hermesHomeDir, 'state.db'), [
      {
        id: '20261018_100001_aaaa11',
        cwd: ROOT,
        messages: [{ role: 'user', content: 'from sessions.cwd' }],
      },
      {
        id: '20261018_100002_bbbb22',
        cwd: null,
        gitRepoRoot: ROOT,
        messages: [{ role: 'user', content: 'from git_repo_root' }],
      },
      {
        id: '20261018_100003_cccc33',
        cwd: null,
        systemPromptHash: 'hash-1',
        promptTableText: `# Hermes runtime environment\nHost: Windows (11)\nCurrent working directory: ${ROOT}\n`,
        messages: [{ role: 'user', content: 'from system_prompts table cwd' }],
      },
      {
        id: '20261018_100004_dddd44',
        cwd: OTHER,
        messages: [{ role: 'user', content: 'other repo session' }],
      },
    ]);

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir,
      hermesHomeDir,
    });

    expect(found.map(f => f.sessionId).sort()).toEqual([
      '20261018_100001_aaaa11',
      '20261018_100002_bbbb22',
      '20261018_100003_cccc33',
    ]);
    for (const file of found) {
      expect(file.harness).toBe('hermes');
      expect(isHermesSessionPath(file.path)).toBe(true);
      expect(file.path).toContain(path.resolve(dbPath));
    }
  });

  it('normalizes pruned worktree CWDs and subpackage CWDs back to the repository root', async () => {
    await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', 'naresh', 'state.db'),
      [
        {
          id: '20261018_200001_wt0001',
          cwd: `${ROOT}.worktrees/feat-branch`,
          parentSessionId: '20261018_190000_parent',
          messages: [{ role: 'user', content: 'in worktree' }],
        },
      ],
    );

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir,
      hermesHomeDir,
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sessionId: '20261018_200001_wt0001',
      parentSessionId: '20261018_190000_parent',
      harness: 'hermes',
    });
  });

  it('cleans injected skill invocation bodies, # Agent Context blocks, and deduplicates message_uid across compaction', async () => {
    const dbPath = await createHermesStateDb(path.join(hermesHomeDir, 'state.db'), [
      {
        id: '20261018_300001_clean1',
        cwd: ROOT,
        title: 'Build Hermes session adapter',
        titleSource: 'llm',
        messages: [
          {
            role: 'user',
            messageUid: 'uid-u1',
            compacted: 1,
            active: 0,
            content: [
              '[System: The active model for this chat has changed to gemini-4-argon via provider github-copilot.]',
              '',
              '[IMPORTANT: The user has invoked the "autonomous-delivery" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
              '---',
              'name: autonomous-delivery',
              '---',
              '# Huge skill dump...',
              '',
              'The user has provided the following instruction alongside the skill invocation: build adapter for mining past hermes sessions',
              '',
              'PONYTAIL MODE ACTIVE — level: full',
              '# Ponytail',
              '',
              '# Agent Context: some recalled context',
              'Generated: 2026-10-18T15:49:10Z',
            ].join('\n'),
          },
          {
            role: 'assistant',
            messageUid: 'uid-a1',
            compacted: 1,
            active: 0,
            content: 'I will build src/transcripts/hermes.ts with full SQLite state.db support.',
          },
          // Duplicate row cloned during context compaction with same message_uid
          {
            role: 'user',
            messageUid: 'uid-u1',
            compacted: 0,
            active: 1,
            content: 'The user has provided the following instruction alongside the skill invocation: build adapter for mining past hermes sessions',
          },
          // Compaction summary message (_compressed_summary = 1) must be excluded from conversational prose
          {
            role: 'assistant',
            messageUid: 'uid-comp-summary',
            compressedSummary: 1,
            active: 1,
            content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.\n## Goal\nBuild Hermes adapter.\n## Key Decisions\n- Read state.db directly via @libsql/client.',
          },
          // Background process notification noise must not be indexed as user prose
          {
            role: 'user',
            messageUid: 'uid-bg-noise',
            active: 1,
            content: '[IMPORTANT: Background process proc_123 completed normally (exit code 0).\nCommand: python job.py]',
          },
          {
            role: 'user',
            messageUid: 'uid-u2',
            active: 1,
            content: 'ship the changes',
          },
          {
            role: 'assistant',
            messageUid: 'uid-a2',
            active: 1,
            content: 'Committed, merged PR, synced upstream, and deployed.',
          },
        ],
      },
    ]);

    const [file] = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir,
      hermesHomeDir,
    });
    expect(file).toBeDefined();

    const { messages } = await readHermesProseFrom(file.path, 0, 0);
    expect(messages.map(m => ({ role: m.role, text: m.text }))).toEqual([
      { role: 'user', text: 'build adapter for mining past hermes sessions' },
      { role: 'assistant', text: 'I will build src/transcripts/hermes.ts with full SQLite state.db support.' },
      { role: 'user', text: 'ship the changes' },
      { role: 'assistant', text: 'Committed, merged PR, synced upstream, and deployed.' },
    ]);

    // Compaction summary is extracted separately for candidate distillation (like Copilot checkpoints)
    const summaryText = await readHermesCompactedSummaryText(file.sessionId, file.path);
    expect(summaryText).toContain('## Goal');
    expect(summaryText).toContain('Build Hermes adapter.');
    expect(summaryText).toContain('## Key Decisions');

    // Read helpers (readMessageAt, readMessagesAt, readMessagesFor, readWithContext) work on virtual Hermes paths
    const secondLine = messages[1].line;
    expect((await readMessageAt(file.path, secondLine))?.text).toBe(
      'I will build src/transcripts/hermes.ts with full SQLite state.db support.',
    );
    const batch = await readMessagesAt(file.path, [messages[0].line, messages[2].line]);
    expect(batch.get(messages[0].line)?.text).toBe('build adapter for mining past hermes sessions');
    expect(batch.get(messages[2].line)?.text).toBe('ship the changes');

    const seeked = await readMessagesFor(file.path, [
      { line: secondLine, byteOffset: secondLine, chars: messages[1].text.length },
    ]);
    expect(seeked.get(secondLine)?.text).toBe(messages[1].text);

    const ctx = await readWithContext(file.path, secondLine, 1);
    expect(ctx.map(c => c.text)).toEqual([
      'build adapter for mining past hermes sessions',
      'I will build src/transcripts/hermes.ts with full SQLite state.db support.',
      'ship the changes',
    ]);
    expect(dbPath).toBeTruthy();
  });

  it('indexes Hermes sessions end-to-end in runIndexPass, preserves session titles and opening asks, and increments watermarks', async () => {
    const dbPath = await createHermesStateDb(path.join(hermesHomeDir, 'state.db'), [
      {
        id: '20261018_400001_idx001',
        cwd: ROOT,
        title: 'Custom Hermes Title',
        titleSource: 'user',
        messages: [
          { role: 'user', content: 'how do we index hermes sessions?' },
          { role: 'assistant', content: 'read state.db sessions and messages tables directly.' },
        ],
      },
    ]);

    const idxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-hermes-idx-'));
    try {
      const transcriptsDb = path.join(idxDir, 'transcripts.db');
      const pass1 = await runIndexPass({
        projectRoot: ROOT,
        dbPath: transcriptsDb,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
        hermesHomeDir,
      });

      expect(pass1.indexed).toBe(2);
      const client = await openTranscriptDb(transcriptsDb, { readOnly: true });
      const fileRows = (await client.execute(
        'SELECT session_id, harness, display_name, name_kind, opening FROM transcript_files',
      )).rows;
      expect(fileRows).toEqual([
        {
          session_id: '20261018_400001_idx001',
          harness: 'hermes',
          display_name: 'Custom Hermes Title',
          name_kind: 3,
          opening: 'how do we index hermes sessions?',
        },
      ]);

      // Second pass with no changes indexes 0 messages
      const pass2 = await runIndexPass({
        projectRoot: ROOT,
        dbPath: transcriptsDb,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
        hermesHomeDir,
      });
      expect(pass2.indexed).toBe(0);

      // Appending a new message to the Hermes session indexes only the new message
      const stateClient = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
      try {
        await stateClient.execute({
          sql: `INSERT INTO messages (session_id, role, content, timestamp, active, compacted, _compressed_summary, message_uid)
                VALUES ('20261018_400001_idx001', 'user', 'follow-up question', 1792300099, 1, 0, 0, 'uid-followup')`,
        });
        await stateClient.execute({
          sql: `UPDATE sessions SET message_count = 3, last_activity_at = 1792300099 WHERE id = '20261018_400001_idx001'`,
        });
      } finally {
        stateClient.close();
      }

      const pass3 = await runIndexPass({
        projectRoot: ROOT,
        dbPath: transcriptsDb,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
        hermesHomeDir,
      });
      expect(pass3.indexed).toBe(1);
    } finally {
      await closeTranscriptDbs();
      await fs.rm(idxDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('builds a repo-to-sessions map across all Hermes profiles in a single pass, including single-repo prompt hints for kanban/scratch sessions', async () => {
    await createHermesStateDb(
      path.join(hermesHomeDir, 'profiles', 'engineer-agent-skills', 'state.db'),
      [
        {
          id: '20261018_500001_direct',
          cwd: ROOT,
          messages: [
            { role: 'user', content: 'work on knowl' },
            { role: 'assistant', content: 'done' },
          ],
        },
        {
          id: '20261018_500002_kanban',
          cwd: path.join(hermesHomeDir, 'kanban', 'boards', 'local-setup', 'workspaces', 't_12345'),
          messages: [
            { role: 'user', content: `Please review changes in ${OTHER} and run tests.` },
            { role: 'assistant', content: 'reviewed' },
          ],
        },
        {
          id: '20261018_500003_global',
          cwd: os.homedir(),
          messages: [
            { role: 'user', content: 'general system question with no repo path' },
            { role: 'assistant', content: 'answer' },
          ],
        },
      ],
    );

    const map = await buildHermesRepoSessionMap(hermesHomeDir, [ROOT, OTHER]);
    const rootKey = process.platform === 'win32' || process.platform === 'darwin' ? ROOT.toLowerCase() : ROOT;
    const otherKey = process.platform === 'win32' || process.platform === 'darwin' ? OTHER.toLowerCase() : OTHER;

    expect(map.byRoot.get(rootKey)?.map(f => f.sessionId)).toEqual(['20261018_500001_direct']);
    expect(map.byRoot.get(otherKey)?.map(f => f.sessionId)).toEqual(['20261018_500002_kanban']);
    expect(map.unmapped.map(f => f.sessionId)).toEqual(['20261018_500003_global']);
  });

  it('merges Claude, Codex, Copilot and Hermes into one list', async () => {
    const claudeDir = path.join(projectsDir, encodeProjectDir(ROOT));
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'aaa.jsonl'), '{}\n');

    const codexTarget = path.join(
      codexSessionsDir,
      '2026/03/22/rollout-2026-03-22T21-16-47-019d15e7-ffff-7e93-886c-2429599f27cd.jsonl',
    );
    await fs.mkdir(path.dirname(codexTarget), { recursive: true });
    await fs.writeFile(
      codexTarget,
      `${JSON.stringify({ type: 'session_meta', payload: { id: '019d15e7-ffff-7e93-886c-2429599f27cd', cwd: ROOT } })}\n`,
    );

    const copilotDir = path.join(copilotSessionsDir, '01a0d081-401e-4b4d-950b-8d270c9243f6');
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(path.join(copilotDir, 'workspace.yaml'), `id: 01a0d081-401e-4b4d-950b-8d270c9243f6\ncwd: ${ROOT}\n`);
    await fs.writeFile(path.join(copilotDir, 'events.jsonl'), `${JSON.stringify({ type: 'session.start', data: {} })}\n`);

    await createHermesStateDb(path.join(hermesHomeDir, 'state.db'), [
      {
        id: '20261018_600001_hermes',
        cwd: ROOT,
        messages: [{ role: 'user', content: 'hello from hermes' }],
      },
    ]);

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir,
      hermesHomeDir,
    });

    expect(found.map(f => f.harness).sort()).toEqual(['claude', 'codex', 'copilot', 'hermes']);
    expect(defaultHermesHomeDir()).toBeTruthy();
    expect(extractProse({ role: 'user', content: 'jsonl hermes turn', timestamp: '2026-10-18T12:00:00Z' })).toEqual({
      role: 'user',
      text: 'jsonl hermes turn',
      timestamp: '2026-10-18T12:00:00Z',
    });
  });

  it('hasIndexableArchive detects a Hermes state.db when Claude, Codex, and Copilot are absent', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-hermes-home-'));
    const envBefore = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      HERMES_HOME: process.env.HERMES_HOME,
    };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.LOCALAPPDATA = path.join(fakeHome, 'AppData', 'Local');
    process.env.HERMES_HOME = path.join(fakeHome, 'custom-hermes-home');
    try {
      expect(await hasIndexableArchive(ROOT)).toBe(false);
      await createHermesStateDb(path.join(process.env.HERMES_HOME, 'state.db'), []);
      expect(await hasIndexableArchive(ROOT)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(envBefore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
