import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { extractProse } from '../../src/transcripts/parse.js';
import {
  buildCopilotRepoSessionMap,
  defaultCopilotSessionsDir,
  discoverTranscriptFiles,
  encodeProjectDir,
  hasIndexableArchive,
  normalizeCopilotRepoCwd,
  readCopilotCheckpointsText,
  scanTranscriptArchive,
} from '../../src/transcripts/paths.js';

let copilotSessionsDir: string;
let codexSessionsDir: string;
let projectsDir: string;

const ROOT = path.resolve(process.platform === 'win32' ? 'd:\\coding\\knowl' : '/coding/knowl');
const OTHER = path.resolve(process.platform === 'win32' ? 'd:\\coding\\auction' : '/coding/auction');

beforeEach(async () => {
  copilotSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-'));
  codexSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-codex-'));
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-claude-'));
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(copilotSessionsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(codexSessionsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(projectsDir, { recursive: true, force: true }).catch(() => {});
});

async function writeCopilotSession(
  sessionId: string,
  options: {
    yamlCwd?: string | null;
    startCwd?: string | null;
    lines?: unknown[];
    writeEvents?: boolean;
    padding?: number;
  } = {},
) {
  const dir = path.join(copilotSessionsDir, sessionId);
  await fs.mkdir(dir, { recursive: true });

  if (options.yamlCwd !== undefined && options.yamlCwd !== null) {
    await fs.writeFile(
      path.join(dir, 'workspace.yaml'),
      [
        `id: ${sessionId}`,
        `cwd: ${options.yamlCwd}`,
        'summary_count: 0',
        'created_at: 2026-04-02T14:28:13.304Z',
        'updated_at: 2026-04-29T12:00:00.000Z',
      ].join('\n') + '\n',
    );
  }

  if (options.writeEvents !== false) {
    const startData: Record<string, unknown> = {
      sessionId,
      version: 1,
      producer: 'copilot-agent',
      startTime: '2026-04-02T14:28:13.304Z',
    };
    if (options.padding) {
      startData.padding = 'x'.repeat(options.padding);
    }
    if (options.startCwd !== undefined && options.startCwd !== null) {
      startData.context = { cwd: options.startCwd, branch: 'main' };
    }
    const startEvent = {
      type: 'session.start',
      data: startData,
      id: '26f29fb9-86c8-4310-a7c7-ea6952552e45',
      timestamp: '2026-04-02T14:28:13.304Z',
      parentId: null,
    };
    const body = [startEvent, ...(options.lines ?? [])].map(line => JSON.stringify(line)).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'events.jsonl'), body);
  }

  return path.join(dir, 'events.jsonl');
}

const copilotUserMessage = (content: string, extra: Record<string, unknown> = {}) => {
  const { data: extraData, ...rest } = extra;
  return {
    type: 'user.message',
    data: {
      content,
      transformedContent: `<current_datetime>2026-04-02T14:28:13.304Z</current_datetime>\n\n${content}`,
      ...(extraData as Record<string, unknown> | undefined),
    },
    id: '9352571e-a0b9-4774-8ecb-40bc58f86e94',
    timestamp: '2026-04-02T14:28:45.058Z',
    ...rest,
  };
};

const copilotAssistantMessage = (content: string, extra: Record<string, unknown> = {}) => {
  const { data: extraData, ...rest } = extra;
  return {
    type: 'assistant.message',
    data: {
      messageId: '6d5e99ef-0409-4812-b52a-96925935ee97',
      content,
      toolRequests: [],
      reasoningOpaque: 'encrypted-blob',
      reasoningText: 'internal reasoning that must not be indexed',
      ...(extraData as Record<string, unknown> | undefined),
    },
    id: '6d5e99ef-0409-4812-b52a-96925935ee97',
    timestamp: '2026-04-02T14:28:50.235Z',
    ...rest,
  };
};

describe('Copilot transcript discovery', () => {
  it('points defaultCopilotSessionsDir at ~/.copilot/session-state', () => {
    expect(defaultCopilotSessionsDir()).toBe(path.join(os.homedir(), '.copilot', 'session-state'));
  });

  it('finds a session by the cwd recorded in workspace.yaml even when session.start omits context.cwd', async () => {
    // 111 of 2,146 real Copilot sessions (agency-spawned) omit `data.context.cwd` in `session.start`
    // and record the project only in `workspace.yaml`.
    const id = '0427d585-36db-402f-baac-ff122e8d22f5';
    const expectedPath = await writeCopilotSession(id, { yamlCwd: ROOT, startCwd: null });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found).toEqual([
      {
        path: expectedPath,
        sessionId: id,
        parentSessionId: null,
        harness: 'copilot',
      },
    ]);
  });

  it('handles single-quoted Windows paths in workspace.yaml without corrupting backslashes', async () => {
    const id = '01bb0002-5350-471c-88b5-ec7a5e30931f';
    await writeCopilotSession(id, { yamlCwd: `'${ROOT}'`, startCwd: null });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found.map(f => f.sessionId)).toEqual([id]);
  });

  it('falls back to session.start data.context.cwd when workspace.yaml is absent', async () => {
    const id = '09371a50-9a50-484a-8743-5c696de1623a';
    await writeCopilotSession(id, { yamlCwd: null, startCwd: ROOT });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sessionId: id, harness: 'copilot', parentSessionId: null });
  });

  it('matches when workspace.yaml names the main repo and session.start names a worktree, or vice versa', async () => {
    // Observed in the live archive (`8b775f50-...`): `workspace.yaml` holds the main checkout
    // while `session.start` holds the `.worktrees/copilot-worktree-...` path.
    const id = '8b775f50-ef69-4193-ac67-edc2d06e2064';
    await writeCopilotSession(id, { yamlCwd: OTHER, startCwd: ROOT });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found.map(f => f.sessionId)).toEqual([id]);
  });

  it('skips a session directory that has workspace.yaml but no events.jsonl', async () => {
    // 466 of 2,613 directories in the live archive are empty shells with no events.jsonl.
    await writeCopilotSession('001f19ec-e83a-4a54-b41c-9214877bfa85', {
      yamlCwd: ROOT,
      writeEvents: false,
    });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found).toEqual([]);
  });

  it('leaves another project\'s sessions alone and ignores non-UUID directories', async () => {
    await writeCopilotSession('0119d3ac-7803-4343-95c1-7cc21808fa75', { yamlCwd: ROOT });
    await writeCopilotSession('012a445a-a001-4180-b8d6-ba50b0203b2e', { yamlCwd: OTHER });
    await writeCopilotSession('.session-operation-locks', { yamlCwd: ROOT });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found.map(f => f.sessionId)).toEqual(['0119d3ac-7803-4343-95c1-7cc21808fa75']);
  });

  it('matches a cwd whose drive letter is cased differently', async () => {
    const swapped = ROOT[0] === ROOT[0].toLowerCase()
      ? ROOT[0].toUpperCase() + ROOT.slice(1)
      : ROOT[0].toLowerCase() + ROOT.slice(1);
    await writeCopilotSession('016ee0da-b3dc-44e1-a3b1-3a572b389527', { yamlCwd: swapped });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found).toHaveLength(1);
  });

  it('finds the cwd in session.start even when the first line exceeds the bounded prefix read', async () => {
    const id = '01829378-106e-40e9-961e-9de3853bf7f4';
    await writeCopilotSession(id, { yamlCwd: null, startCwd: ROOT, padding: 20_000 });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found.map(f => f.sessionId)).toEqual([id]);
  });

  it('matches a worktree recorded under the un-resolved path', async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-real-'));
    const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
    try {
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.rm(real, { recursive: true, force: true }).catch(() => {});
      return;
    }

    try {
      const repo = path.join(real, 'repo');
      const worktree = path.join(real, 'repo-wt');
      await fs.mkdir(repo, { recursive: true });
      await fs.mkdir(worktree, { recursive: true });

      const id = '019265dd-c73a-4a47-9ffa-b7158fae782c';
      await writeCopilotSession(id, { yamlCwd: path.join(link, 'repo-wt') });

      const found = await discoverTranscriptFiles(
        path.join(link, 'repo'),
        {
          projectsDir,
          codexSessionsDir,
          copilotSessionsDir,
          roots: [path.join(link, 'repo'), worktree],
        },
      );

      expect(found).toHaveLength(1);
      expect(found[0].harness).toBe('copilot');
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => {});
      await fs.rm(real, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports an absent Copilot archive as empty, not degraded', async () => {
    const scan = await scanTranscriptArchive(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir: path.join(copilotSessionsDir, 'nope'),
    });

    expect(scan.files).toEqual([]);
    expect(scan.degraded).toBe(false);
  });

  it('does not read the real ~/.copilot when the caller redirected another archive', async () => {
    const found = await discoverTranscriptFiles(ROOT, { projectsDir });
    expect(found).toEqual([]);
  });

  it('merges Claude, Codex and Copilot into one list, each labelled', async () => {
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

    await writeCopilotSession('01a0d081-401e-4b4d-950b-8d270c9243f6', { yamlCwd: ROOT });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir, codexSessionsDir, copilotSessionsDir,
    });

    expect(found.map(f => f.harness).sort()).toEqual(['claude', 'codex', 'copilot']);
  });
});

describe('Copilot prose extraction', () => {
  it('reads a user turn from data.content and ignores transformedContent', () => {
    expect(extractProse(copilotUserMessage('review my staged changes'))).toEqual({
      role: 'user',
      text: 'review my staged changes',
      timestamp: '2026-04-02T14:28:45.058Z',
    });
  });

  it('reads an assistant turn from data.content and ignores reasoningText / reasoningOpaque', () => {
    expect(extractProse(copilotAssistantMessage('I checked the diff and found one issue.'))).toEqual({
      role: 'assistant',
      text: 'I checked the diff and found one issue.',
      timestamp: '2026-04-02T14:28:50.235Z',
    });
  });

  it('ignores tool-only assistant turns with empty data.content', () => {
    expect(extractProse(copilotAssistantMessage('   '))).toBeNull();
  });

  it('ignores subagent turns carrying agentId or parentAgentTaskId', () => {
    expect(extractProse(copilotUserMessage('subagent task prompt', {
      data: { content: 'subagent task prompt', parentAgentTaskId: 'b2805ed6-f4b3-46f4-92c2-623e5ec5e45c' },
    }))).toBeNull();
    expect(extractProse(copilotAssistantMessage('subagent reply', {
      agentId: '2568c79e-4025-4455-8bd6-c1c96d50361e',
    }))).toBeNull();
  });

  it('ignores model.message and tool execution events so turns are not duplicated', () => {
    expect(extractProse({
      type: 'model.message',
      timestamp: '2026-04-02T14:28:50.235Z',
      data: { message: { role: 'assistant', content: 'raw model output' } },
    })).toBeNull();
    expect(extractProse({
      type: 'tool.execution_complete',
      timestamp: '2026-04-02T14:28:50.235Z',
      data: { result: 'build succeeded' },
    })).toBeNull();
  });
});

describe('Copilot end-to-end indexing and cold-start probe', () => {
  it('indexes a Copilot session and preserves harness=copilot and opening ask', async () => {
    const id = '01a18f4c-89a7-466b-ad1c-83c8a6808422';
    await writeCopilotSession(id, {
      yamlCwd: ROOT,
      lines: [
        copilotUserMessage('how do we wire copilot session mining?'),
        copilotAssistantMessage('add discovery in paths.ts and prose extraction in parse.ts.'),
      ],
    });

    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-db-'));
    try {
      const dbPath = path.join(dbDir, 'transcripts.db');
      const result = await runIndexPass({
        projectRoot: ROOT,
        dbPath,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
      });

      expect(result.indexed).toBe(2);
      const client = await openTranscriptDb(dbPath, { readOnly: true });
      const files = (await client.execute('SELECT session_id, harness, opening FROM transcript_files')).rows;
      expect(files).toEqual([
        {
          session_id: id,
          harness: 'copilot',
          opening: 'how do we wire copilot session mining?',
        },
      ]);

      // An unreadable Claude archive must not wipe indexed Copilot rows (and vice versa).
      const second = await runIndexPass({
        projectRoot: ROOT,
        dbPath,
        projectsDir: path.join(dbDir, 'unreadable-claude'),
        codexSessionsDir,
        copilotSessionsDir: path.join(dbDir, 'unreadable-copilot'),
      });
      expect(second.removed).toBe(0);
      const surviving = (await client.execute('SELECT session_id FROM transcript_files')).rows;
      expect(surviving.map(r => r.session_id)).toEqual([id]);
    } finally {
      await closeTranscriptDbs();
      await fs.rm(dbDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('hasIndexableArchive detects a ~/.copilot/session-state directory when Claude and Codex are absent', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-home-'));
    const homeBefore = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      expect(await hasIndexableArchive(ROOT)).toBe(false);
      await fs.mkdir(path.join(fakeHome, '.copilot', 'session-state'), { recursive: true });
      expect(await hasIndexableArchive(ROOT)).toBe(true);
    } finally {
      process.env.HOME = homeBefore.HOME;
      process.env.USERPROFILE = homeBefore.USERPROFILE;
      if (homeBefore.HOME === undefined) delete process.env.HOME;
      if (homeBefore.USERPROFILE === undefined) delete process.env.USERPROFILE;
      await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('normalizes pruned worktree CWDs (<repo>.worktrees/*, <repo>/worktrees/*, worktrees/<repo>-<task>, <repo>-Task<id>) back to the parent repo', async () => {
    const repo = path.resolve(process.platform === 'win32' ? 'C:\\repos\\CRM.ICon.VIVR.Web' : '/repos/CRM.ICon.VIVR.Web');
    expect(normalizeCopilotRepoCwd(`${repo}.worktrees/Task6646044_provision_EU`)).toBe(repo);
    expect(normalizeCopilotRepoCwd(`${repo}/worktrees/wi-6648932`)).toBe(repo);
    expect(normalizeCopilotRepoCwd(`${repo}-Task6617582`)).toBe(repo);
    const siblingWt = path.resolve(
      process.platform === 'win32'
        ? 'C:\\repos\\worktrees\\CRM.ICon.VIVR.Web-6604101-api-contracts'
        : '/repos/worktrees/CRM.ICon.VIVR.Web-6604101-api-contracts',
    );
    expect(normalizeCopilotRepoCwd(siblingWt)).toBe(repo);

    // Also discovers sessions recorded inside a pruned worktree when scanning for ROOT
    const id1 = '11111111-2222-4333-8444-555555555551';
    const id2 = '11111111-2222-4333-8444-555555555552';
    await writeCopilotSession(id1, { yamlCwd: `${ROOT}.worktrees/feat-branch` });
    await writeCopilotSession(id2, { yamlCwd: `${OTHER}.worktrees/other-branch` });

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      codexSessionsDir,
      copilotSessionsDir,
    });
    expect(found.map(f => f.sessionId)).toEqual([id1]);
  });

  it('builds a repo-to-sessions map once and supports onlySessionIds without deleting other indexed sessions', async () => {
    const s1 = '22222222-3333-4444-8555-666666666661';
    const s2 = '22222222-3333-4444-8555-666666666662';
    const s3 = '22222222-3333-4444-8555-666666666663';
    await writeCopilotSession(s1, {
      yamlCwd: ROOT,
      lines: [copilotUserMessage('session one'), copilotAssistantMessage('reply one')],
    });
    await writeCopilotSession(s2, {
      yamlCwd: `${ROOT}.worktrees/task-two`,
      lines: [copilotUserMessage('session two in worktree'), copilotAssistantMessage('reply two')],
    });
    await writeCopilotSession(s3, {
      yamlCwd: OTHER,
      lines: [copilotUserMessage('other repo session'), copilotAssistantMessage('reply three')],
    });

    const map = await buildCopilotRepoSessionMap(copilotSessionsDir, [ROOT, OTHER]);
    const rootKey = process.platform === 'win32' || process.platform === 'darwin' ? ROOT.toLowerCase() : ROOT;
    expect(map.byRoot.get(rootKey)?.map(f => f.sessionId).sort()).toEqual([s1, s2]);

    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-copilot-scoped-'));
    try {
      const dbPath = path.join(dbDir, 'transcripts.db');
      const pass1 = await runIndexPass({
        projectRoot: ROOT,
        dbPath,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
        onlySessionIds: new Set([s1]),
      });
      expect(pass1.indexed).toBe(2);

      // Indexing only s2 next must not delete s1 from transcript_files
      const pass2 = await runIndexPass({
        projectRoot: ROOT,
        dbPath,
        projectsDir,
        codexSessionsDir,
        copilotSessionsDir,
        onlySessionIds: new Set([s2]),
      });
      expect(pass2.indexed).toBe(2);
      expect(pass2.removed).toBe(0);

      const client = await openTranscriptDb(dbPath, { readOnly: true });
      const rows = (await client.execute('SELECT session_id FROM transcript_files ORDER BY session_id')).rows;
      expect(rows.map(r => String(r.session_id))).toEqual([s1, s2]);
    } finally {
      await closeTranscriptDbs();
      await fs.rm(dbDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reads pre-distilled checkpoints from session checkpoints/*.json and index.md', async () => {
    const id = '33333333-4444-4555-8666-777777777771';
    const eventsPath = await writeCopilotSession(id, { yamlCwd: ROOT });
    const sessionDir = path.dirname(eventsPath);
    await fs.mkdir(path.join(sessionDir, 'checkpoints'), { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'checkpoints', '001.json'),
      JSON.stringify({
        checkpoint_number: 1,
        title: 'Wire Multi-Model Copilot Provider',
        overview: 'Added copilot provider descriptor.',
        work_done: 'Routed claude* to Anthropic SDK and gpt* to OpenAI SDK.',
        technical_details: 'Updated schemas.ts for strict mode.',
      }),
    );
    await fs.writeFile(path.join(sessionDir, 'index.md'), 'Completed multi-model provider wiring.');

    const text = await readCopilotCheckpointsText(id, eventsPath, path.join(sessionDir, 'no-store.db'));
    expect(text).toContain('## Checkpoint 1: Wire Multi-Model Copilot Provider');
    expect(text).toContain('Routed claude* to Anthropic SDK');
    expect(text).toContain('## Session Summary');
  });
});
