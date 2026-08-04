import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDb, initDb } from '../../src/store/database.js';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The handshake card a REAL client receives.
 *
 * `startMcpServer` passes `null` for the positional config and hands the live one over through
 * `deferred.getConfig`, because the handshake completes before the database opens. The
 * instructions were built from the positional argument, so in production they were always the
 * no-config card: the transcript routing line existed, passed its own unit tests, and reached
 * nobody. The existing tests missed it by constructing the server positionally -- which is the
 * one way of building it that production never uses.
 */

const TEST_ROOT = path.resolve('./.knowl-mcp-instructions');
const withTranscripts: ProjectConfig = {
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

let projectId = '';

/** The initialize response, which is where `instructions` is delivered and nowhere else. */
async function handshake(server: ReturnType<typeof createMcpServer>): Promise<any> {
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const answered = new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === 'init') resolve(message); };
  });
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'card-test', version: '1.0' } },
  });
  const response = await answered;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.close();
  return response;
}

describe('the MCP handshake card is built from the config the server actually has', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'instructions')).id;
  });

  afterAll(async () => {
    await closeDb();
    await closeTranscriptDbs();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // Exactly how `startMcpServer` builds it: nulls positionally, the live values deferred.
  it('reaches a client built the way production builds it', async () => {
    const server = createMcpServer(null, null, null, null, {
      getProjectId: () => projectId,
      getProjectRoot: () => TEST_ROOT,
      getConfig: () => withTranscripts,
      getInitError: () => null,
      whenReady: async () => {},
    });

    const response = await handshake(server);

    expect(response.result.instructions).toBeTruthy();
    expect(response.result.instructions).toMatch(/- transcripts:/);
  });

  it('says nothing about transcripts when the deferred config has them off', async () => {
    const server = createMcpServer(null, null, null, null, {
      getProjectId: () => projectId,
      getProjectRoot: () => TEST_ROOT,
      getConfig: () => ({ version: 1, security: { rejectSecrets: true, secretPatterns: [] } }),
      getInitError: () => null,
      whenReady: async () => {},
    });

    const response = await handshake(server);

    expect(response.result.instructions).not.toMatch(/- transcripts:/);
  });

  it('still answers to a positionally constructed server', async () => {
    const response = await handshake(createMcpServer(projectId, TEST_ROOT, withTranscripts));

    expect(response.result.instructions).toMatch(/- transcripts:/);
  });
});
