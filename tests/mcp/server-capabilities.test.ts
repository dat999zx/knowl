import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The capability card, checked in both directions.
 *
 * A host reads this once and then stops asking. Under-declaring hides a working feature --
 * which is how `resources/templates/list` sat unreachable -- and over-declaring is worse,
 * because the client takes the promised path, waits for a signal nobody sends, and the failure
 * surfaces as silence rather than as an error.
 *
 * So the assertion is not "these flags look right". It is: everything declared is answerable,
 * and everything answerable is declared.
 */

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

/** One connection, so the initialize result and later calls describe the same server. */
async function session(): Promise<{ init: any; ask: (method: string, params?: any) => Promise<any>; end: () => Promise<void> }> {
  const server = createMcpServer(null, null, { version: 1 } as ProjectConfig);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capability-test', version: '1.0' } },
  });
  const init = await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  let counter = 0;
  return {
    init: init.result,
    ask: async (method: string, params?: any) => {
      const id = `ask-${counter++}`;
      const answered = waitFor(id);
      transport.onmessage!({
        jsonrpc: '2.0', id, method,
        // `resources/subscribe` needs a uri to clear envelope validation, so a call that omits
        // params still reaches the capability check this file is actually about.
        params: params ?? (method === 'resources/subscribe' ? { uri: 'knowl://brain' } : {}),
      });
      return answered;
    },
    end: () => server.close(),
  };
}

describe('the declared server capabilities', () => {
  it('declares tools, resources and prompts, and no sub-flag knowl does not implement', async () => {
    const { init, end } = await session();
    // Deliberately an exact comparison. A sub-flag added here without the mechanism behind it
    // is the failure this test exists for, and `toMatchObject` would let one through.
    expect(init.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    await end();
  });

  it('answers everything the resources capability promises', async () => {
    const { ask, end } = await session();
    // Including the template list: the SDK gates `resources/templates/list` on the resources
    // capability alone, so declaring `resources` is the whole permission for it.
    for (const method of ['resources/list', 'resources/templates/list', 'tools/list', 'prompts/list']) {
      const response = await ask(method);
      expect(response.error, `${method} is declared and unanswerable`).toBeUndefined();
    }
    await end();
  });

  it('lists exactly the five person-initiated prompts', async () => {
    const { ask, end } = await session();
    const listed = await ask('prompts/list');
    // Exact and ordered, so a sixth prompt added without a maintainer deciding it is
    // person-initiated fails here rather than appearing in every host's slash menu unnoticed.
    expect(listed.result.prompts.map((prompt: any) => prompt.name))
      .toEqual(['park', 'resume', 'handoff', 'drift', 'state']);
    // Prompt arguments are strings in MCP and have no schema, so `required` is the only thing
    // a client can enforce -- it has to survive being derived from the tool's own schema.
    const byName = new Map(listed.result.prompts.map((prompt: any) => [prompt.name, prompt]));
    for (const [name, args] of [
      ['park', [['goal', true]]],
      ['resume', [['key', false]]],
      ['handoff', [['goal', true], ['nextAction', true]]],
      ['drift', [['since', true]]],
      ['state', []],
    ] as [string, [string, boolean][]][]) {
      const prompt: any = byName.get(name);
      expect(prompt.description, `${name} carries no description`).toBeTruthy();
      expect(prompt.arguments.map((argument: any) => [argument.name, argument.required ?? false]))
        .toEqual(args);
      for (const argument of prompt.arguments) {
        expect(argument.description, `${name}.${argument.name} carries no description`).toBeTruthy();
      }
    }
    await end();
  });

  it('answers prompts/get with a message naming the tool and the argument', async () => {
    const { ask, end } = await session();
    const got = await ask('prompts/get', { name: 'resume', arguments: { key: 'blue-otter-42' } });
    expect(got.result.messages[0].role).toBe('user');
    // The whole prompt body: the tool to call and what the person typed. Nothing paraphrased,
    // because `tools/list` already carries the tool's own description.
    expect(got.result.messages[0].content.text).toBe('Call knowl_resume now with key: blue-otter-42');

    // A required argument the person did not supply is refused rather than dropped: the body
    // would otherwise read as a call that could work, for a tool that cannot run without it.
    const missing = await ask('prompts/get', { name: 'drift', arguments: {} });
    expect(missing.error?.code).toBe(-32602);
    // And a name that is not here is the caller's mistake, not the server having failed.
    const unknown = await ask('prompts/get', { name: 'elicit', arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
    // The one prompt that takes nothing still produces a runnable call.
    const state = await ask('prompts/get', { name: 'state', arguments: {} });
    expect(state.result.messages[0].content.text).toBe('Call knowl_state now.');
    await end();
  });

  it('does not answer what it never claimed', async () => {
    const { ask, end } = await session();
    // `subscribe` is absent from the card because nothing here implements it. If that ever
    // stops being true, this failing is the reminder to declare it -- and if the flag is added
    // without the handler, the test above fails instead. Neither direction can move alone.
    const subscribed = await ask('resources/subscribe');
    expect(subscribed.error?.code, 'resources/subscribe answered without being declared').toBe(-32601);
    await end();
  });
});
