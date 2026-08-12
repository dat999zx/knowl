import { describe, expect, it } from 'vitest';
import {
  CLOUD_TOOL_DEFINITIONS, CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS,
} from '../../src/mcp/tool-definitions.js';

/**
 * Tool descriptions are instructions to a model, not documentation.
 *
 * A stale command string here is not a stale doc — it is an agent confidently telling a user to
 * run something that exits 1. That is why this is pinned separately from `docs:check`, which
 * only ever looked at markdown.
 */
const REMOVED = [
  'knowl login',
  'knowl logout',
  'knowl publish',
  'knowl code ',
  'knowl eval retrieval',
  'knowl access report',
  'knowl pr check',
  'knowl evidence list',
];

const ALL = [...CORE_TOOL_DEFINITIONS, ...TRANSCRIPT_TOOL_DEFINITIONS, ...CLOUD_TOOL_DEFINITIONS];

describe('MCP tool descriptions name commands that exist', () => {
  it('names no command 5.0 removed', () => {
    for (const tool of ALL) {
      const text = JSON.stringify(tool);
      for (const gone of REMOVED) {
        expect(text, `${tool.name} names a removed command: ${gone}`).not.toContain(gone);
      }
    }
  });

  it('knowl_cloud names the commands it tells the agent to relay', () => {
    // This one matters most: its description tells the agent to relay a command rather than
    // route around the tool, so a wrong string produces a confident, wrong instruction.
    const cloud = CLOUD_TOOL_DEFINITIONS.find(tool => tool.name === 'knowl_cloud');
    expect(cloud).toBeDefined();
    expect(cloud!.description).toContain('knowl cloud push');
    expect(cloud!.description).toContain('knowl cloud login');
  });
});
