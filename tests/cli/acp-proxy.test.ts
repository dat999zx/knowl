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
