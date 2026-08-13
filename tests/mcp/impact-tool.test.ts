import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { knowlToolDefinitions } from '../../src/mcp/tools.js';
import { startWorkLoop } from '../../src/store/work-loop.js';
import { activeReadSetForSession, recordRead, releaseReadSet } from '../../src/store/read-set.js';
import type { ImpactTier } from '../../src/session/impact.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The MCP half of change impact: one flag-gated tool, and the adjudication that closes a finding.
 *
 * `knowl_impact resolve` is the only path by which a finding is ever resolved -- the write gate
 * leaves them open on purpose -- so `resolution`, and with it the precision number plan §9 exists
 * to produce, depends entirely on what is asserted here. Refusal itself is not tested in this
 * file: it happens at `PreToolUse`, not on this surface (`tests/store/write-gate.test.ts`), and
 * the last section explains why the gate this file used to cover is gone.
 *
 * Everything else here exists to prove that the machinery costs a repository which did not ask
 * for it exactly nothing.
 */

const TEST_ROOT = path.join(os.tmpdir(), 'knowl-impact-tool-test');

const baseConfig = (): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
});

// Built here rather than round-tripped through `knowl config`, deliberately: what is under test is
// the surface's response to the flag, and reading it off a file would also be testing the config
// plumbing that registers `impact.enabled`, which is a different lane's work and a different bug.
const IMPACT_ON: ProjectConfig = { ...baseConfig(), impact: { enabled: true } };
const IMPACT_OFF: ProjectConfig = baseConfig();

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

async function callTool(config: ProjectConfig, name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, config);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'impact-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const textOf = (result: any): string => String(result?.content?.[0]?.text ?? '');
const jsonOf = (result: any): any => JSON.parse(textOf(result));

/** A work loop and the memory session it mints -- the pair a task-side gate would have to join. */
async function startTask(title: string): Promise<{ taskId: string; sessionId: string }> {
  const started = await startWorkLoop(projectId, title);
  expect(started.memorySessionId, 'work loop must bind a memory session').toBeTruthy();
  return { taskId: started.taskId, sessionId: started.memorySessionId! };
}

/** One captured read, returning the read-set row id a finding is filed against. */
async function seedRead(sessionId: string, locator: string, hash: string): Promise<string> {
  await recordRead({ sessionId, locator, observedHash: hash, toolName: 'Read' });
  const entry = (await activeReadSetForSession(sessionId)).find(row => row.locator === locator);
  expect(entry, `read of ${locator} was not recorded`).toBeTruthy();
  return entry!.id;
}

let findingCounter = 0;

/**
 * A finding, inserted directly.
 *
 * Detection needs a real file re-indexed between two symbol snapshots and is tested where it
 * lives; what this file is about is what the tool surface does with a finding that already
 * exists, so the row is the fixture rather than the subject.
 */
async function seedFinding(input: {
  affectedId: string;
  locator: string;
  tier: ImpactTier;
  evidence?: Record<string, unknown>;
}): Promise<string> {
  const id = `impactfinding${String(++findingCounter).padStart(4, '0')}`;
  await getClient().execute({
    sql: `INSERT INTO impact_findings
            (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, resolution, resolved_at)
          VALUES (?, ?, NULL, 'work', ?, ?, ?, ?, NULL, NULL)`,
    args: [
      id,
      input.locator,
      input.affectedId,
      input.tier,
      input.evidence ? JSON.stringify(input.evidence) : null,
      new Date().toISOString(),
    ],
  });
  return id;
}

async function resolutionOf(findingId: string): Promise<string | null> {
  const rows = await getClient().execute({
    sql: 'SELECT resolution FROM impact_findings WHERE id = ?',
    args: [findingId],
  });
  const value = rows.rows[0]?.resolution;
  return value === null || value === undefined ? null : String(value);
}

async function finishItemCount(taskId: string): Promise<number> {
  const rows = await getClient().execute({
    // Prefix, not equality: a step atom's title carries its task name since 2026-08-13.
    sql: "SELECT COUNT(*) AS n FROM knowledge_items WHERE title LIKE 'Work Loop finish%' AND content LIKE ?",
    args: [`%Task ID: ${taskId}%`],
  });
  return Number(rows.rows[0]?.n ?? 0);
}

describe('knowl_impact', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const client = getClient();
    await client.execute('DELETE FROM impact_findings');
    await client.execute('DELETE FROM work_read_sets');
    await client.execute('DELETE FROM memory_session_events');
    await client.execute('DELETE FROM memory_sessions');
    await client.execute('DELETE FROM knowledge_commit_items');
    await client.execute('DELETE FROM knowledge_commits');
    await client.execute('DELETE FROM knowledge_items');
    projectId = (await repo.createProject(TEST_ROOT, 'impact tool')).id;
  });

  describe('registration', () => {
    it('is absent from the listing when the flag is off', () => {
      const names = knowlToolDefinitions(IMPACT_OFF).map(tool => tool.name);
      expect(names).not.toContain('knowl_impact');
    });

    it('is listed when the flag is on, and adds exactly one tool', () => {
      const off = knowlToolDefinitions(IMPACT_OFF);
      const on = knowlToolDefinitions(IMPACT_ON);
      expect(on.map(tool => tool.name)).toContain('knowl_impact');
      // Each registered tool costs guidance-card space in every session of every user
      // (`types.ts:267-271`). Reading findings and adjudicating one share a surface for that
      // reason; a second tool appearing here is a regression against that budget.
      expect(on).toHaveLength(off.length + 1);
    });

    it('answers a call while gated off with a disabled message, not "unknown tool"', async () => {
      // A client that cached a tool list from when the flag was on can still call this.
      const result = await callTool(IMPACT_OFF, 'knowl_impact', {});
      expect(textOf(result)).toMatch(/not enabled/i);
      expect(textOf(result)).not.toMatch(/Unknown tool/i);
    });

    it('validates arguments while gated off, which proves the schema is registered', async () => {
      // Dispatch validates against SCHEMA_BY_TOOL before it reaches the gate, so a refusal that
      // names the argument is only possible if the gated-off tool's schema is in that map. An
      // unregistered schema would sail past validation and hit the disabled message instead.
      const result = await callTool(IMPACT_OFF, 'knowl_impact', { scope: 'everything' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('scope');
      expect(textOf(result)).toMatch(/mine, all/);
    });

    it('publishes no schema keyword the validator cannot enforce', async () => {
      // The same walk `tool-argument-validation.test.ts` runs over the ungated surface. It cannot
      // see this tool -- it builds its config with transcripts on and impact off -- so a keyword
      // the validator refuses would sit in a published schema and turn every knowl_impact call
      // into "this is a server bug", reachable only for repos that enabled the feature.
      const { SUPPORTED_SCHEMA_KEYWORDS } = await import('../../src/mcp/tool-schema.js');
      const unsupported: string[] = [];
      const walk = (node: any, where: string): void => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        for (const [keyword, value] of Object.entries(node)) {
          if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) unsupported.push(`${where}.${keyword}`);
          if (keyword === 'properties') Object.values(value as any).forEach((child, index) => walk(child, `${where}.${keyword}[${index}]`));
          if (keyword === 'items' || keyword === 'additionalProperties') walk(value, `${where}.${keyword}`);
        }
      };

      const impact = knowlToolDefinitions(IMPACT_ON).find(tool => tool.name === 'knowl_impact')!;
      walk(impact.inputSchema, impact.name);
      expect(unsupported).toEqual([]);
    });

    it('refuses a resolution that is not one of the four', async () => {
      const result = await callTool(IMPACT_ON, 'knowl_impact', { resolve: { id: 'x', resolution: 'ignored' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('resolve.resolution');
    });
  });

  describe('listing findings', () => {
    it('defaults to reads still held, and widens to released ones on scope: all', async () => {
      const held = await startTask('holding');
      const heldRead = await seedRead(held.sessionId, 'symbol://src/a.ts#kept', 'hash-a');
      const heldFinding = await seedFinding({ affectedId: heldRead, locator: 'symbol://src/a.ts#kept', tier: 'certain' });

      const done = await startTask('released');
      const releasedRead = await seedRead(done.sessionId, 'symbol://src/b.ts#gone', 'hash-b');
      const releasedFinding = await seedFinding({ affectedId: releasedRead, locator: 'symbol://src/b.ts#gone', tier: 'certain' });
      // A finding closes by being adjudicated, never by its read being released -- so this one is
      // still open, and still needs a resolution to become part of the precision denominator.
      await releaseReadSet(done.sessionId);

      const mine = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', {}));
      expect(mine.scope).toBe('mine');
      expect(mine.findings.map((finding: any) => finding.id)).toEqual([heldFinding]);

      const all = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', { scope: 'all' }));
      expect(all.findings.map((finding: any) => finding.id).sort()).toEqual([heldFinding, releasedFinding].sort());
    });

    it('excludes the possible tier by default and returns it only when named', async () => {
      const task = await startTask('tiers');
      const certainRead = await seedRead(task.sessionId, 'symbol://src/a.ts#one', 'hash-1');
      const likelyRead = await seedRead(task.sessionId, 'symbol://src/a.ts#two', 'hash-2');
      const possibleRead = await seedRead(task.sessionId, 'symbol://src/a.ts#three', 'hash-3');
      const certain = await seedFinding({ affectedId: certainRead, locator: 'symbol://src/a.ts#one', tier: 'certain' });
      const likely = await seedFinding({ affectedId: likelyRead, locator: 'symbol://src/a.ts#two', tier: 'likely' });
      const possible = await seedFinding({ affectedId: possibleRead, locator: 'symbol://src/a.ts#three', tier: 'possible' });

      const byDefault = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', {}));
      expect(byDefault.findings.map((finding: any) => finding.id).sort()).toEqual([certain, likely].sort());
      expect(byDefault.findings.map((finding: any) => finding.id)).not.toContain(possible);

      const asked = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', { tier: 'possible' }));
      expect(asked.findings.map((finding: any) => finding.id)).toEqual([possible]);
    });

    it('returns the evidence chain, not just a count', async () => {
      const task = await startTask('evidence');
      const read = await seedRead(task.sessionId, 'symbol://src/auth.ts#createSession', 'hash-old');
      await seedFinding({
        affectedId: read,
        locator: 'symbol://src/auth.ts#createSession',
        tier: 'certain',
        evidence: {
          locator: 'symbol://src/auth.ts#createSession',
          observedHash: 'hash-old',
          currentHash: 'hash-new',
          observedSignature: 'createSession(user: User): Session',
          currentSignature: 'createSession(user: User, org: Organization): Session',
        },
      });

      const listed = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', {})).findings[0];
      expect(listed.locator).toBe('symbol://src/auth.ts#createSession');
      expect(listed.evidence.observedSignature).toBe('createSession(user: User): Session');
      expect(listed.evidence.currentSignature).toBe('createSession(user: User, org: Organization): Session');
    });
  });

  describe('adjudication', () => {
    it('marks a finding and drops it from the open set', async () => {
      const task = await startTask('adjudicate');
      const read = await seedRead(task.sessionId, 'symbol://src/a.ts#one', 'hash-1');
      const finding = await seedFinding({ affectedId: read, locator: 'symbol://src/a.ts#one', tier: 'certain' });

      const result = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', {
        resolve: { id: finding, resolution: 'false_positive' },
      }));

      expect(result.resolved).toMatchObject({ id: finding, resolution: 'false_positive', wasOpen: true });
      expect(result.findings).toHaveLength(0);
      // The column §9's precision number is computed from; a resolution the tool reported but did
      // not persist would make the denominator a fiction.
      expect(await resolutionOf(finding)).toBe('false_positive');
    });

    it('says so when the id was not an open finding instead of reporting success', async () => {
      const result = jsonOf(await callTool(IMPACT_ON, 'knowl_impact', {
        resolve: { id: 'impactfinding9999', resolution: 'dismissed' },
      }));
      expect(result.resolved.wasOpen).toBe(false);
      expect(String(result.resolved.note)).toMatch(/not among the open findings/i);
    });
  });

  /**
   * `knowl_task_finish` does not gate, and this is the regression guard for the reason.
   *
   * A gate here was built and removed (plan §15). It could never fire: reads are captured only by
   * the hook path, under the *host* session, while `startWorkLoop` mints its own session and tags
   * the task with that one -- so a gate resolved through the task's tag queries a session id under
   * which no read was ever recorded. The tests that covered it passed only because they seeded
   * reads under the work-loop id directly, which nothing in production does. That is the lesson
   * worth keeping: these tests proved the code did what it said, and said nothing about whether
   * anything reached it.
   *
   * So what is pinned below is deliberately the *absence* of a block, with a fixture built the way
   * the deleted tests built theirs. If someone re-adds the gate, these fail and send them here.
   * The chokepoint is `store/write-gate.ts`, which needs no such join because it runs inside the
   * session holding the read; `tests/store/write-gate.test.ts` is where refusal is asserted.
   */
  describe('knowl_task_finish, which change impact deliberately does not gate', () => {
    it('records a clean finish even with an unresolved certain finding against the task session', async () => {
      const task = await startTask('not gated');
      const read = await seedRead(task.sessionId, 'symbol://src/auth.ts#createSession', 'hash-old');
      const finding = await seedFinding({
        affectedId: read,
        locator: 'symbol://src/auth.ts#createSession',
        tier: 'certain',
        evidence: {
          locator: 'symbol://src/auth.ts#createSession',
          observedHash: 'hash-old',
          currentHash: 'hash-new',
          observedSignature: 'createSession(user: User): Session',
          currentSignature: 'createSession(user: User, org: Organization): Session',
        },
      });

      const result = await callTool(IMPACT_ON, 'knowl_task_finish', { taskId: task.taskId, summary: 'done' });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).not.toContain('FINISH NOT RECORDED');
      expect(await finishItemCount(task.taskId)).toBe(1);
      // Untouched: adjudication is `knowl_impact resolve` and nothing else. A finish that quietly
      // closed findings would spend the precision denominator plan §9 exists to produce.
      expect(await resolutionOf(finding)).toBeNull();
    });

    it('carries the same payload it always did, flag on or off', async () => {
      // The handler is the two lines it was before this feature, so its result is the work-loop
      // step and nothing else -- asserted as the whole key set rather than a subset, on both
      // settings, because "the flag changes nothing here" is the claim.
      for (const [label, config] of [['on', IMPACT_ON], ['off', IMPACT_OFF]] as const) {
        const task = await startTask(`payload ${label}`);
        const read = await seedRead(task.sessionId, 'symbol://src/a.ts#one', 'hash-1');
        await seedFinding({ affectedId: read, locator: 'symbol://src/a.ts#one', tier: 'certain' });

        const result = await callTool(config, 'knowl_task_finish', { taskId: task.taskId, summary: 'done' });

        expect(result.isError, label).toBeUndefined();
        expect(Object.keys(jsonOf(result)).sort(), label).toEqual(['itemId', 'summary', 'taskId']);
        expect(jsonOf(result), label).toMatchObject({ taskId: task.taskId, summary: 'done' });
        expect(await finishItemCount(task.taskId), label).toBe(1);
      }
    });
  });
});
