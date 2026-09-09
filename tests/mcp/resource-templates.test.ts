import { describe, expect, it, vi } from 'vitest';
import { ResourceTemplateSchema } from '@modelcontextprotocol/sdk/types.js';
import { KNOWLEDGE_CATEGORIES } from '../../src/core/types.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * `knowl://category/{name}` resolved from the day it was written and no host could find it.
 *
 * `resources/templates/list` is the only place the protocol lets a server advertise a
 * parameterised URI. Without a handler the SDK answers "method not found", so the test that
 * matters is the round trip: ask the running server, and check that everything it advertises
 * is something the read handler will actually serve. An advertised template that 404s would be
 * a worse bug than the silence it replaced.
 */

vi.mock('../../src/store/queries.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/store/queries.js')>();
  return { ...actual, queryKnowledgeBase: vi.fn(async () => []) };
});

const { registerResources } = await import('../../src/mcp/resources.js');

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function ask(method: string, params: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(null, null, { version: 1 } as ProjectConfig);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'templates-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('ask');
  transport.onmessage!({ jsonrpc: '2.0', id: 'ask', method, params });
  const response = await answered;
  await server.close();
  return response;
}

/** The read handler the SDK would install, captured by the method its schema names. */
function readHandler(): (request: { params: { uri: string } }) => Promise<any> {
  const handlers = new Map<string, (request: any) => Promise<any>>();
  registerResources(
    { setRequestHandler: (schema: any, handler: any) => handlers.set(schema.shape.method.value, handler) } as never,
    () => 'project-1',
    () => null,
  );
  return handlers.get('resources/read')!;
}

describe('resources/templates/list', () => {
  it('answers at all, so a host can discover the parameterised URI', async () => {
    const response = await ask('resources/templates/list', {});
    expect(response.error, 'the server refused resources/templates/list').toBeUndefined();
    expect(response.result.resourceTemplates).toHaveLength(1);
    expect(response.result.resourceTemplates[0].uriTemplate).toBe('knowl://category/{name}');
  });

  it('advertises a template the SDK schema accepts whole', async () => {
    const response = await ask('resources/templates/list', {});
    for (const template of response.result.resourceTemplates) {
      // Parsed rather than eyeballed: `ResourceTemplateSchema` strips what it does not know, so
      // comparing the result catches a field name this file invented.
      expect(ResourceTemplateSchema.parse(template)).toEqual(template);
    }
  });

  it('names every category the template will actually accept', async () => {
    const response = await ask('resources/templates/list', {});
    const description: string = response.result.resourceTemplates[0].description;
    // The read handler matches `[a-z]+` and then queries with whatever it caught, so RFC 6570
    // cannot express the real domain and the description has to carry it.
    for (const category of KNOWLEDGE_CATEGORIES) {
      expect(description, `${category} is servable and undocumented`).toContain(category);
    }
  });

  it('advertises only templates that resolve', async () => {
    const response = await ask('resources/templates/list', {});
    const read = readHandler();
    for (const template of response.result.resourceTemplates) {
      for (const category of KNOWLEDGE_CATEGORIES) {
        const uri = template.uriTemplate.replace('{name}', category);
        const result = await read({ params: { uri } });
        expect(result.contents[0].uri).toBe(uri);
        expect(result.contents[0].mimeType).toBe(template.mimeType);
      }
    }
  });
});
