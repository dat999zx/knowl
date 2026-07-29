import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import { closeHostSessionBindings } from '../../src/store/host-session-bindings.js';
import { captureChangeWatermark, consumeChangeNotice, resetChangeNotice } from '../../src/mcp/change-notice.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-two-channel');
let projectId = '';
let tick = 0;

const hook = (host: string, input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: host as NormalizedHostHook['host'],
  event: 'turn-start',
  externalSessionId: `${host}-session`,
  externalTurnId: `${host}-turn`,
  projectRoot: ROOT,
  payload: {},
  ...input,
});

const toolEvent = (host: string) => handleHostLifecycleEvent(projectId, hook(host, {
  event: 'session-event', type: 'command', payload: { command: `cmd-${tick++}`, exitCode: 0 },
}));

const hookCard = (result: Awaited<ReturnType<typeof toolEvent>>): string =>
  String((result.hostOutput as any)?.hookSpecificOutput?.additionalContext ?? '');

const mcpCall = async (name = 'knowl_query') =>
  consumeChangeNotice(ROOT, name, await captureChangeWatermark(ROOT));

const sibling = (title: string) => repo.createKnowledgeCommit(projectId, `Sibling: ${title}`, [
  { itemId: title.toLowerCase().replace(/\s+/g, '-'), action: 'insert', after: { id: title.toLowerCase().replace(/\s+/g, '-'), category: 'fact', title } },
]);

describe('hook and MCP channels together', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'two channel')).id;
    await repo.createKnowledgeCommit(projectId, 'Baseline', [
      { itemId: 'base', action: 'insert', after: { id: 'base', category: 'fact', title: 'Baseline' } },
    ]);
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('announces a change once, not twice, when a mid-turn host is live', async () => {
    resetChangeNotice();
    await handleHostLifecycleEvent(projectId, hook('claude', { title: 'Agent turn' }));
    await toolEvent('claude');
    await mcpCall();

    await sibling('Announced once');

    expect(hookCard(await toolEvent('claude'))).toContain('Announced once');
    // Same change, already delivered by the hook channel.
    expect(await mcpCall()).toBeUndefined();
  });

  it('still announces on the MCP channel when only a host that cannot deliver is live', async () => {
    await closeHostSessionBindings({ host: 'claude', projectRoot: ROOT, externalSessionId: 'claude-session' });
    resetChangeNotice();
    // `generic` holds a live binding but its profile has no mid-turn channel, so nothing
    // else is showing this change.
    await handleHostLifecycleEvent(projectId, hook('generic', { title: 'Agent turn' }));
    await toolEvent('generic');
    await mcpCall();

    await sibling('Only MCP can say this');

    expect(hookCard(await toolEvent('generic'))).not.toContain('KNOWL CHANGED');
    expect(await mcpCall()).toContain('Only MCP can say this');
  });

  it('still announces for cursor, whose mid-turn envelope upstream does not surface', async () => {
    await closeHostSessionBindings({ host: 'generic', projectRoot: ROOT, externalSessionId: 'generic-session' });
    resetChangeNotice();
    await handleHostLifecycleEvent(projectId, hook('cursor', { title: 'Agent turn' }));
    await toolEvent('cursor');
    await mcpCall();

    await sibling('Cursor still hears this');

    // Cursor's hook card is emitted, but nothing may treat that as the agent being told.
    expect(await mcpCall()).toContain('Cursor still hears this');
  });

  it('announces on the MCP channel when no lifecycle binding is live at all', async () => {
    await closeHostSessionBindings({ host: 'cursor', projectRoot: ROOT, externalSessionId: 'cursor-session' });
    await closeHostSessionBindings({ host: 'generic', projectRoot: ROOT, externalSessionId: 'generic-session' });
    resetChangeNotice();
    await mcpCall();

    await sibling('No hooks installed');

    expect(await mcpCall()).toContain('No hooks installed');
  });
});
