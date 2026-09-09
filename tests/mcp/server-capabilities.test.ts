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
async function session(): Promise<{ init: any; ask: (method: string) => Promise<any>; end: () => Promise<void> }> {
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
    ask: async (method: string) => {
      const id = `ask-${counter++}`;
      const answered = waitFor(id);
      transport.onmessage!({ jsonrpc: '2.0', id, method, params: method === 'resources/subscribe' ? { uri: 'knowl://brain' } : {} });
      return answered;
    },
    end: () => server.close(),
  };
}

describe('the declared server capabilities', () => {
  it('declares tools and resources, and no sub-flag knowl does not implement', async () => {
    const { init, end } = await session();
    // Deliberately an exact comparison. A sub-flag added here without the mechanism behind it
    // is the failure this test exists for, and `toMatchObject` would let one through.
    expect(init.capabilities).toEqual({ tools: {}, resources: {} });
    await end();
  });

  it('answers everything the resources capability promises', async () => {
    const { ask, end } = await session();
    // Including the template list: the SDK gates `resources/templates/list` on the resources
    // capability alone, so declaring `resources` is the whole permission for it.
    for (const method of ['resources/list', 'resources/templates/list', 'tools/list']) {
      const response = await ask(method);
      expect(response.error, `${method} is declared and unanswerable`).toBeUndefined();
    }
    await end();
  });

  it('does not answer what it never claimed', async () => {
    const { ask, end } = await session();
    // `subscribe` is absent from the card because nothing here implements it. If that ever
    // stops being true, this failing is the reminder to declare it -- and if the flag is added
    // without the handler, the test above fails instead. Neither direction can move alone.
    const subscribed = await ask('resources/subscribe');
    expect(subscribed.error?.code, 'resources/subscribe answered without being declared').toBe(-32601);
    const prompts = await ask('prompts/list');
    expect(prompts.error?.code, 'prompts answered without being declared').toBe(-32601);
    await end();
  });
});
