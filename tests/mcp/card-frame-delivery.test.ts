import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOTE_MAX, wrapCard } from '../../src/core/card-marker.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { resetChangeNotice } from '../../src/mcp/change-notice.js';
import { mcpServerInstructions } from '../../src/core/knowl-guidance.js';
import { mcpModeLineForHost } from '../../src/session/hosts/index.js';
import * as repo from '../../src/store/repository.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = path.resolve('./.knowl-card-frame-test');
const CODE_RE = /\[KNOWL CARD ([0-9a-f]{32}):/;
let projectId = '';
let tick = 0;

const config: ProjectConfig = {
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled: true }, vector: { enabled: false } },
};

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

/**
 * A real server over an in-memory transport; `call` is one `tools/call` round trip.
 *
 * Built the way `startMcpServer` builds it: null positionally, the live values through the
 * deferred getters. Passing the root directly hid the case where the note read it from one place
 * and the wrap from another.
 */
async function connect(deferred: Parameters<typeof createMcpServer>[4] = {}, root: string | null = ROOT) {
  const server = createMcpServer(null, null, null, null, {
    getProjectId: () => projectId,
    getProjectRoot: () => root,
    getConfig: () => config,
    getInitError: () => null,
    whenReady: async () => {},
    ...deferred,
  });
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const pending = new Map<string, (message: any) => void>();
  transport.onSend = message => pending.get(message.id)?.(message);
  const request = (id: string, method: string, params: unknown) => {
    const answered = new Promise<any>(resolve => pending.set(id, resolve));
    transport.onmessage!({ jsonrpc: '2.0', id, method, params });
    return answered;
  };
  const init = await request('init', 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'card-frame-test', version: '1.0' },
  });
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    instructions: init.result.instructions as string,
    call: async (name: string, args: unknown): Promise<string[]> => {
      const response = await request(`call-${tick++}`, 'tools/call', { name, arguments: args });
      return response.result.content.map((block: { text: string }) => block.text);
    },
    close: () => server.close(),
  };
}

/** Adopt the head, let a sibling commit land, and return the blocks of the next query. */
async function queryAfterForeignCommit(deferred: Parameters<typeof createMcpServer>[4], title: string) {
  resetChangeNotice();
  const session = await connect(deferred);
  await session.call('knowl_query', { query: 'anything' });
  await repo.createKnowledgeCommit(projectId, `Sibling: ${title}`, [
    { itemId: title.toLowerCase().replace(/\s+/g, '-'), action: 'insert', after: { id: title.toLowerCase().replace(/\s+/g, '-'), category: 'fact', title } },
  ]);
  const blocks = await session.call('knowl_query', { query: 'anything' });
  await session.close();
  return { blocks, instructions: session.instructions };
}

describe('card framing over MCP', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Card Frame Test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await closeTranscriptDbs();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('wraps the appended notice in the code the instructions announce', async () => {
    const plain = await queryAfterForeignCommit({ host: 'claude' }, 'Seen by claude');
    const framed = await queryAfterForeignCommit({}, 'Seen by anyone else');

    const code = framed.instructions.match(CODE_RE)?.[1];
    expect(code).toBeDefined();

    const last = framed.blocks[framed.blocks.length - 1];
    const inner = last.split('\n').slice(1, -1).join('\n');
    expect(inner).toContain('KNOWL CHANGED');
    expect(inner).toContain('Seen by anyone else');
    expect(last).toBe(wrapCard(inner, code!));

    // Same shape as the unframed run: one block appended in place, the payload untouched.
    expect(framed.blocks).toHaveLength(plain.blocks.length);
    expect(() => JSON.parse(framed.blocks[0])).not.toThrow();
    expect(framed.blocks[0]).not.toContain('KNOWL CARD');
  });

  it('leaves a verified hook host with no wrap and no note', async () => {
    const plain = await queryAfterForeignCommit({ host: 'claude' }, 'Hook host sees raw');
    expect(plain.blocks.join('\n')).toContain('Hook host sees raw');
    expect(plain.blocks.join('\n')).not.toContain('KNOWL CARD');
    expect(plain.instructions).not.toContain('KNOWL CARD');
  });

  it('keeps the assembled instructions inside the ceiling for each host', async () => {
    // The auto-init suffix (`server.ts` startMcpServer) with a realistic path: the longer of the two.
    const suffix = '\nNOTE: no Knowl store existed here, so serve created an empty one at "C:/Users/someone/work/a-project"' +
      ' (KNOWL_DISABLE_SERVE_AUTO_INIT=1 prevents this). Memory starts empty; what you store' +
      ' this session is what later sessions will find.';
    const card = mcpServerInstructions(config);
    const withNote = await connect({ instructionsSuffix: suffix });
    const hooked = await connect({ host: 'claude', instructionsSuffix: suffix });
    const noRoot = await connect({}, null);

    expect(withNote.instructions).toMatch(CODE_RE);
    expect(withNote.instructions.endsWith(card + suffix)).toBe(true);
    expect(withNote.instructions.startsWith('Knowl cards appended')).toBe(true);
    // Note-bearing hosts: the card's own ceiling plus the note. The suffix is appended on top
    // of the card today, with or without a note, and is not part of either ceiling.
    expect(withNote.instructions.length - suffix.length).toBeLessThanOrEqual(2000 + NOTE_MAX);
    expect(hooked.instructions).toBe(card + suffix);
    expect(hooked.instructions.length - suffix.length).toBeLessThanOrEqual(2000);
    expect(hooked.instructions).not.toContain('KNOWL CARD');
    expect(noRoot.instructions).toBe(card);
    await withNote.close();
    await hooked.close();
    await noRoot.close();
  });

  it('keeps every note-bearing host inside card ceiling plus note, with its own mode line', async () => {
    for (const host of ['cursor', 'copilot', 'openhands', 'antigravity', 'windsurf', 'cline', 'claude-desktop', 'generic']) {
      const session = await connect({ host, modeLine: mcpModeLineForHost(host) });
      expect(session.instructions, host).toMatch(CODE_RE);
      expect(session.instructions.length, host).toBeLessThanOrEqual(2000 + NOTE_MAX + 1);
      await session.close();
    }
  });

  it('gives each server process one code, shared by the note and the wrap', async () => {
    // A hard-coded constant would pass every other test; a fresh module graph must mint a new one.
    const first = (await connect()).instructions.match(CODE_RE)?.[1];
    vi.resetModules();
    const { frameNote } = await import('../../src/mcp/card-frame.js');
    expect(frameNote()).not.toContain(first!);
  });
});
