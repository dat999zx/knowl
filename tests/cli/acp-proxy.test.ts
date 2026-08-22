import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runAcpProxy } from '../../src/cli/acp-proxy.js';

/**
 * The ACP proxy, driven by a fake agent over pipes.
 *
 * The property worth pinning is transparency: two other programs are speaking a protocol to each
 * other and Knowl is sitting in the middle of it. Every test here asserts what came out the far
 * side is byte-identical to what went in, including for messages this build does not understand
 * and for the permission traffic it deliberately declines to answer.
 */
function fakeAgent() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as any;
  return { child, stdin, stdout };
}

async function relayed(lines: string[], from: 'client' | 'agent'): Promise<string[]> {
  const { child, stdin: agentIn, stdout: agentOut } = fakeAgent();
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const captured: string[] = [];
  const sink = from === 'client' ? agentIn : clientOut;
  sink.on('data', chunk => captured.push(...String(chunk).split('\n').filter(Boolean)));

  vi.spyOn(process, 'stdin', 'get').mockReturnValue(clientIn as any);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(clientOut as any);

  const done = runAcpProxy('agent', [], { spawnAgent: (() => child) as any, cwd: process.cwd() });
  const source = from === 'client' ? clientIn : agentOut;
  for (const line of lines) source.write(`${line}\n`);
  await new Promise(resolve => setTimeout(resolve, 40));
  child.emit('close', 0);
  await done;
  vi.restoreAllMocks();
  return captured;
}

describe('ACP proxy', () => {
  it('forwards a client message to the agent byte for byte', async () => {
    // Deliberately awkward: key order that JSON.stringify would not reproduce, a float, and a
    // field this build has never heard of.
    const line = '{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"zz":1,"aa":0.10,"_meta":{"x":null},"sessionId":"s1"}}';
    expect(await relayed([line], 'client')).toEqual([line]);
  });

  it('forwards agent traffic unchanged, including the permission request it will not answer', async () => {
    // The gate's natural home here, relayed rather than intercepted: answering it would resolve
    // a prompt the person was supposed to see, with an option Knowl invented.
    const permission = '{"jsonrpc":"2.0","id":2,"method":"session/request_permission","params":{"sessionId":"s1","options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}}';
    const update = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","status":"completed","kind":"edit","title":"Edit a.ts","locations":[{"path":"src/a.ts"}]}}}';
    expect(await relayed([permission, update], 'agent')).toEqual([permission, update]);
  });

  it('relays a line it cannot parse rather than dropping it', async () => {
    const garbage = 'not json at all';
    expect(await relayed([garbage], 'agent')).toEqual([garbage]);
  });

  it('exits with the agent’s own status, because the editor treats this as the agent', async () => {
    const { child } = fakeAgent();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(new PassThrough() as any);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(new PassThrough() as any);
    const done = runAcpProxy('agent', [], { spawnAgent: (() => child) as any, cwd: process.cwd() });
    child.emit('close', 3);
    expect(await done).toBe(3);
    vi.restoreAllMocks();
  });

  it('reports a failure to start instead of hanging the editor', async () => {
    const { child } = fakeAgent();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(new PassThrough() as any);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(new PassThrough() as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const done = runAcpProxy('nope', [], { spawnAgent: (() => child) as any, cwd: process.cwd() });
    child.emit('error', new Error('ENOENT'));
    expect(await done).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('ACP proxy shutdown and framing', () => {
  it('forwards EOF, so an agent that exits on stdin close actually does', async () => {
    // The bug this pins was invisible to every relay test: lines went through fine and the
    // agent simply never learned the client had gone, so it waited forever and the proxy with
    // it -- the editor exits and two processes stay holding a pipe nobody reads.
    const { child, stdin: agentIn } = fakeAgent();
    const clientIn = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(clientIn as any);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(new PassThrough() as any);

    const ended = new Promise<void>(resolve => agentIn.on('finish', () => resolve()));
    const done = runAcpProxy('agent', [], { spawnAgent: (() => child) as any, cwd: process.cwd() });
    clientIn.end();
    await expect(ended).resolves.toBeUndefined();
    child.emit('close', 0);
    await done;
    vi.restoreAllMocks();
  });

  it('preserves a CRLF terminator and a final line that has none', async () => {
    // readline strips terminators, so the previous relay turned every CRLF into a bare LF and
    // gave a trailing partial line a newline it never had. Harmless for NDJSON, and not what
    // "forwarded exactly as received" means.
    const { child, stdout: agentOut } = fakeAgent();
    const clientOut = new PassThrough();
    let captured = '';
    clientOut.on('data', chunk => { captured += chunk; });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(new PassThrough() as any);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(clientOut as any);

    const done = runAcpProxy('agent', [], { spawnAgent: (() => child) as any, cwd: process.cwd() });
    agentOut.write('{"a":1}\r\n');
    agentOut.end('{"b":2}');
    await new Promise(resolve => setTimeout(resolve, 40));
    child.emit('close', 0);
    await done;

    expect(captured).toBe('{"a":1}\r\n{"b":2}');
    vi.restoreAllMocks();
  });

  it('observes a completed tool call as a write, with a repo-relative path', async () => {
    // The end-to-end shape: locations name the files, kind declares read vs edit, and what
    // reaches the lifecycle has to be what the impact subsystem can act on.
    const { normalizeHostHook } = await import('../../src/cli/agents/host-hook.js');
    const root = process.cwd();
    const normalized = normalizeHostHook('generic', 'session-event', {
      sessionId: 's1', cwd: root, type: 'checkpoint', tool_name: 'Edit',
      changedPaths: [`${root}/src/a.ts`],
    });
    expect(normalized.toolName).toBe('Edit');
    expect(normalized.payload.changedPaths).toEqual(['src/a.ts']);
  });
});
