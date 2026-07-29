import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IncompleteHostHookPayloadError, normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { readLifecyclePayload } from '../../src/cli/agents/lifecycle.js';

const ROOT = path.resolve('.knowl-host-hook-test');

describe('host hook normalization', () => {
  it('normalizes Codex turn start without retaining the prompt body', () => {
    const result = normalizeHostHook('codex', 'UserPromptSubmit', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      cwd: ROOT,
      prompt: 'Private prompt text must not be stored',
    });

    expect(result).toMatchObject({
      host: 'codex',
      event: 'turn-start',
      externalSessionId: 'session-1',
      externalTurnId: 'turn-1',
      projectRoot: ROOT,
      title: 'Agent turn',
      payload: {},
    });
    expect(JSON.stringify(result)).not.toContain('Private prompt');
  });

  it('uses stable Codex fallback identity fields', () => {
    const result = normalizeHostHook('codex', 'UserPromptSubmit', {
      conversation_id: 'conversation-1',
      generation_id: 'generation-1',
      cwd: ROOT,
    });

    expect(result.externalSessionId).toBe('conversation-1');
    expect(result.externalTurnId).toBe('generation-1');
  });

  it('normalizes Claude tool success and failure into allowlisted events', () => {
    const success = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'npm test', unsafe: 'discard me' },
      tool_response: { stdout: 'discard me', exit_code: 0 },
    });
    const failure = normalizeHostHook('claude', 'PostToolUseFailure', {
      session_id: 'session-2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Tests failed',
      stderr: 'discard me',
    });

    expect(success).toMatchObject({
      event: 'session-event',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    });
    expect(failure).toMatchObject({
      event: 'session-event',
      type: 'error',
      status: 'failed',
      payload: { message: 'Tests failed' },
    });
    expect(JSON.stringify([success, failure])).not.toContain('discard me');
  });

  it('normalizes Cursor shell and file-edit events', () => {
    const command = normalizeHostHook('cursor', 'afterShellExecution', {
      conversation_id: 'session-3',
      generation_id: 'turn-3',
      workspace_roots: [ROOT],
      command: 'npm test',
      exit_code: 0,
      stdout: 'discard me',
    });
    const edit = normalizeHostHook('cursor', 'afterFileEdit', {
      conversation_id: 'session-3',
      generation_id: 'turn-3',
      workspace_roots: [ROOT],
      file_path: path.join(ROOT, 'src', 'auth.ts'),
    });

    expect(command).toMatchObject({
      externalSessionId: 'session-3',
      externalTurnId: 'turn-3',
      projectRoot: ROOT,
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    });
    expect(edit).toMatchObject({
      type: 'checkpoint',
      payload: { changedPaths: ['src/auth.ts'] },
    });
  });

  it('accepts the generic contract and bounds retained strings', () => {
    const result = normalizeHostHook('generic', 'session-event', {
      sessionId: 'session-4',
      turnId: 'turn-4',
      cwd: ROOT,
      type: 'checkpoint',
      summary: 'x'.repeat(3_000),
      stdout: 'discard me',
    });

    expect(result.externalSessionId).toBe('session-4');
    expect(result.externalTurnId).toBe('turn-4');
    expect(result.type).toBe('checkpoint');
    expect(result.payload.summary).toHaveLength(2_000);
    expect(result.payload).not.toHaveProperty('stdout');
  });

  it('keeps structured checkpoint state without retaining arbitrary tool output', () => {
    const result = normalizeHostHook('generic', 'checkpoint', {
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      cwd: ROOT,
      summary: 'Checkpoint complete',
      goal: 'Ship resumable handoffs',
      completed: ['Added a test'],
      nextAction: 'Implement the contract',
      blocker: 'Waiting for a rate-limit reset',
      artifactRefs: ['tests/store/host-lifecycle.test.ts'],
      verificationStatus: 'needs-review',
      stdout: 'discard me',
    });

    expect(result.payload).toEqual({
      summary: 'Checkpoint complete',
      goal: 'Ship resumable handoffs',
      completed: ['Added a test'],
      nextAction: 'Implement the contract',
      blocker: 'Waiting for a rate-limit reset',
      artifactRefs: ['tests/store/host-lifecycle.test.ts'],
      verificationStatus: 'needs-review',
    });
  });

  it('keeps structured task state on hard-stop failures', () => {
    const result = normalizeHostHook('claude', 'StopFailure', {
      session_id: 'session-failure-state',
      turn_id: 'turn-failure-state',
      cwd: ROOT,
      error: 'rate_limit',
      message: 'Claude session limit hit',
      goal: 'Ship resumable handoffs',
      completed: ['Captured the failure state'],
      nextAction: 'Resume after the limit resets',
      blocker: 'Rate limit',
      artifactRefs: ['src/store/session-handoff.ts'],
      verificationStatus: 'blocked',
      stdout: 'discard me',
    });

    expect(result.payload).toEqual({
      status: 'failed',
      error: 'rate_limit',
      code: 'rate_limit',
      message: 'Claude session limit hit',
      goal: 'Ship resumable handoffs',
      completed: ['Captured the failure state'],
      nextAction: 'Resume after the limit resets',
      blocker: 'Rate limit',
      artifactRefs: ['src/store/session-handoff.ts'],
      verificationStatus: 'blocked',
    });
  });

  it('preserves hard-stop failure payloads across hosts', () => {
    const claude = normalizeHostHook('claude', 'StopFailure', {
      session_id: 'session-rate',
      turn_id: 'turn-rate',
      cwd: ROOT,
      error: 'rate_limit',
      message: 'Claude session limit hit',
    });
    const codex = normalizeHostHook('codex', 'Stop', {
      session_id: 'session-codex',
      turn_id: 'turn-codex',
      cwd: ROOT,
      status: 'failed',
      error: 'model_error',
      message: 'provider blew up',
    });
    const cursor = normalizeHostHook('cursor', 'stop', {
      conversation_id: 'session-cursor',
      generation_id: 'turn-cursor',
      workspace_roots: [ROOT],
      status: 'failed',
      code: '401',
      message: 'unauthorized',
    });

    expect(claude).toMatchObject({
      host: 'claude',
      event: 'turn-stop',
      status: 'failed',
      payload: {
        status: 'failed',
        error: 'rate_limit',
        code: 'rate_limit',
        message: 'Claude session limit hit',
      },
    });
    expect(codex).toMatchObject({
      host: 'codex',
      event: 'turn-stop',
      status: 'failed',
      payload: {
        status: 'failed',
        error: 'model_error',
        code: 'model_error',
        message: 'provider blew up',
      },
    });
    expect(cursor).toMatchObject({
      host: 'cursor',
      event: 'turn-stop',
      status: 'failed',
      payload: {
        status: 'failed',
        error: '401',
        code: '401',
        message: 'unauthorized',
      },
    });
  });

  it('rejects unsupported hosts and events', () => {
    expect(() => normalizeHostHook('unknown', 'SessionStart', {})).toThrow('Unsupported hook host');
    expect(() => normalizeHostHook('codex', 'UnknownEvent', { session_id: 's', cwd: ROOT })).toThrow('Unsupported codex hook event');
  });

  it('does not treat Gemini MCP support as a verified lifecycle hook host', () => {
    expect(() => normalizeHostHook('gemini', 'SessionStart', {})).toThrow('Unsupported hook host: gemini');
  });

  it('carries agent identity on subagent tool events and omits it on main-thread events', () => {
    const subagent = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-3',
      agent_id: 'adc54472c7d8cad78',
      agent_type: 'Explore',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_response: {},
    });
    expect(subagent).toMatchObject({
      event: 'session-event',
      externalSessionId: 'session-3',
      agentId: 'adc54472c7d8cad78',
      agentType: 'Explore',
    });

    const mainThread = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-3',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_response: {},
    });
    expect(mainThread.agentId).toBeUndefined();
  });

  it('normalizes SubagentStart and SubagentStop, titling the session by agent type', () => {
    const start = normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-4',
      agent_id: 'agent-4',
      agent_type: 'Explore',
      cwd: ROOT,
      prompt_id: 'prompt-4',
    });
    expect(start).toMatchObject({
      event: 'agent-start',
      externalSessionId: 'session-4',
      agentId: 'agent-4',
      agentType: 'Explore',
      title: 'Agent session (Explore)',
      payload: {},
    });

    const stop = normalizeHostHook('claude', 'SubagentStop', {
      session_id: 'session-4',
      agent_id: 'agent-4',
      agent_type: 'Explore',
      cwd: ROOT,
      last_assistant_message: 'Private subagent output must not be retained',
    });
    expect(stop).toMatchObject({ event: 'agent-stop', agentId: 'agent-4' });
    expect(JSON.stringify(stop)).not.toContain('Private subagent output');
  });

  it('normalizes a subagent event with no agent type', () => {
    const result = normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-4b',
      agent_id: 'agent-4b',
      cwd: ROOT,
    });

    expect(result).toMatchObject({
      event: 'agent-start',
      agentId: 'agent-4b',
      title: 'Agent session (subagent)',
    });
    expect(result.agentType).toBeUndefined();
  });

  it('rejects a subagent event with no agent id', () => {
    expect(() => normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-5',
      cwd: ROOT,
    })).toThrow(IncompleteHostHookPayloadError);
  });

  it('extracts attribution keys from Knowl write tool input only', () => {
    const store = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'mcp__knowl__knowl_ingest_atoms',
      tool_input: { atoms: [{ title: 'First atom' }, { title: 'Second atom' }] },
      tool_response: {},
    });
    expect(store.knowlTool).toBe(true);
    expect(store.knowlChangeKeys).toEqual({ ids: [], titles: ['First atom', 'Second atom'] });

    const update = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'mcp__knowl__knowl_update',
      tool_input: { id: 'item-9', supersedeId: 'item-8', title: 'New title' },
      tool_response: {},
    });
    expect(update.knowlChangeKeys).toEqual({ ids: ['item-9', 'item-8'], titles: ['New title'] });

    const nonKnowl = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { title: 'not a knowl call' },
      tool_response: {},
    });
    expect(nonKnowl.knowlChangeKeys).toBeUndefined();
  });

  // Normalization alone cannot prove the feature works: the CLI first strips the hook
  // payload through readLifecyclePayload's allowlist. Testing normalization on
  // hand-built payloads is exactly how the missing agent_id/tool_input fields went
  // unnoticed, so every field this feature depends on is asserted through both stages.
  describe('through the CLI payload filter', () => {
    const chain = async (raw: Record<string, unknown>) =>
      normalizeHostHook('claude', 'PostToolUse', await readLifecyclePayload(
        Readable.from([JSON.stringify({ session_id: 'chain', cwd: ROOT, ...raw })]) as NodeJS.ReadStream,
      ));

    it('preserves subagent identity end to end', async () => {
      const result = await chain({
        agent_id: 'adc54472c7d8cad78',
        agent_type: 'Explore',
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
      });

      expect(result.agentId).toBe('adc54472c7d8cad78');
      expect(result.agentType).toBe('Explore');
    });

    it.each([
      ['knowl_store', { category: 'fact', title: 'Store title', content: 'body', supersedes: 'old-1' }, { ids: ['old-1'], titles: ['Store title'] }],
      ['knowl_decide', { title: 'Decide title', content: 'body' }, { ids: [], titles: ['Decide title'] }],
      ['knowl_update', { id: 'item-9', supersedeId: 'item-8', title: 'New' }, { ids: ['item-9', 'item-8'], titles: ['New'] }],
      ['knowl_ingest_atoms', { atoms: [{ title: 'Atom A', content: 'x' }, { title: 'Atom B' }] }, { ids: [], titles: ['Atom A', 'Atom B'] }],
    ])('extracts attribution keys for %s', async (tool, toolInput, expected) => {
      const result = await chain({ tool_name: `mcp__knowl__${tool}`, tool_input: toolInput });

      expect(result.knowlTool).toBe(true);
      expect(result.knowlChangeKeys).toEqual(expected);
      // The bare name is what the MCP server recorded its commit range under; the host
      // prefix has to come off or the two never line up.
      expect(result.knowlToolName).toBe(tool);
    });

    it('leaves the tool name unset for a non-Knowl tool', async () => {
      const result = await chain({ tool_name: 'Grep', tool_input: { pattern: 'knowl' } });
      expect(result.knowlToolName).toBeUndefined();
    });
  });
});
