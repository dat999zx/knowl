import { describe, expect, it } from 'vitest';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';

const EMPTY = { items: [], commits: [] };

describe('workspace section in the session-start block', () => {
  it('is absent entirely for an unlinked project', () => {
    expect(formatRecentContextToMarkdown(EMPTY)).not.toMatch(/## Workspace/);
  });

  it('names each repo, its role and whether its writes are shared', () => {
    const md = formatRecentContextToMarkdown(EMPTY, {
      workspace: {
        name: 'knowl-ws', repo: 'knowl',
        selfRole: 'the Knowl CLI and MCP server',
        peers: [{ name: 'duck', role: 'personal notes and reading log', kin: 'forks', defaultVisibility: 'workspace' }],
      },
    });
    expect(md).toContain('## Workspace: knowl-ws');
    expect(md).toContain('knowl (this repo) — the Knowl CLI and MCP server — new writes stay private');
    expect(md).toContain('duck [kin: forks] — personal notes and reading log — new writes are workspace-visible');
  });

  it('still renders a repo that has recorded nothing', () => {
    const md = formatRecentContextToMarkdown(EMPTY, {
      workspace: { name: 'ws', repo: 'here', peers: [{ name: 'bare' }] },
    });
    expect(md).toContain('- bare — new writes stay private');
  });
});
