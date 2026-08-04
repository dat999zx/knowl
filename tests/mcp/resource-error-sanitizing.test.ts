import { describe, expect, it, vi } from 'vitest';

/**
 * The resource channel is the second place a raw driver message can reach a client.
 *
 * No resource URI carries a caller-supplied field, so the missing-argument route that made
 * K-50 reproducible against the tools does not exist here. It is guarded anyway: "statement
 * text and bound parameters never leave the process" is the rule, and a rule with one
 * unguarded exit is the shape of the finding rather than a fix for it.
 *
 * The store is mocked rather than broken for real, because the failure being guarded is a
 * driver fault and nothing a caller can provoke through a URI.
 */

const LEAK = 'Failed query: select * from "knowledge_items" where "id" = ?\nparams: 27b9ed883031b5ac1db66603';

vi.mock('../../src/store/queries.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/store/queries.js')>();
  return {
    ...actual,
    getHierarchicalKnowledge: vi.fn(async () => { throw new Error(LEAK); }),
  };
});

const { registerResources } = await import('../../src/mcp/resources.js');

/** The read handler the SDK would install, captured instead of connected. */
function readHandler(): (request: { params: { uri: string } }) => Promise<unknown> {
  const handlers: Array<(request: any) => Promise<unknown>> = [];
  registerResources(
    { setRequestHandler: (_schema: unknown, handler: any) => handlers.push(handler) } as never,
    () => 'project-1',
    () => null,
  );
  // List is registered first, read second.
  return handlers[1];
}

describe('resource reads withhold SQL and bound parameters (K-50)', () => {
  it('names the resource and drops the statement', async () => {
    const read = readHandler();

    const thrown = await read({ params: { uri: 'knowl://brain' } }).then(
      () => '',
      (error: Error) => error.message,
    );

    expect(thrown).toContain('knowl://brain');
    expect(thrown.toLowerCase()).not.toContain('select *');
    expect(thrown).not.toContain('params:');
    expect(thrown).not.toContain('27b9ed883031b5ac1db66603');
  });
});
