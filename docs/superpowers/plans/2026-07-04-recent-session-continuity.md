# Recent Session Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new agent session instantly continue work by reading a recent-context view that prioritizes fresh active knowledge and recent knowledge commits.

**Architecture:** Add a small store query that returns recent active knowledge items plus recent commits. Expose it through MCP as `knowl_recent` and resource `knowl://recent`, format it as compact markdown, and update generated `AGENTS.md` guidance so new sessions read it first before targeted `knowl_query`.

**Tech Stack:** TypeScript, Vitest, Drizzle-backed SQLite, existing `knowledge_items.updated_at` and `knowledge_commits.created_at`.

---

## Assumptions

- Do not store raw chat transcripts as primary memory. Recent "chat" means recent structured knowledge commits and current active state produced from prior work.
- New sessions should start with `knowl_recent`, then use `knowl_query` for specific follow-up.
- No schema migration is needed.
- Defaults: 12 recent active items and 8 recent commits.

## File Structure

- Create: `src/store/recent-context.ts`
  - Fetch recent active items ordered by `updatedAt DESC`.
  - Fetch recent commits ordered by `createdAt DESC`.
- Modify: `src/core/format.ts`
  - Add `formatRecentContextToMarkdown`.
- Modify: `src/mcp/server.ts`
  - Add `knowl_recent` tool.
  - Add `knowl://recent` resource.
- Modify: `src/core/agents-guidance.ts`
  - Tell agents to call `knowl_recent` at the start of a new session or project-specific task.
- Modify: `tests/store/store.test.ts`
  - Cover recent active item and commit ordering/limits.
- Modify: `tests/mcp/server.test.ts`
  - Cover tool/resource exposure and output.
- Modify: `tests/cli/cli.test.ts`
  - Cover refreshed AGENTS guidance.

---

### Task 1: Add Recent Context Store Query

**Files:**
- Create: `src/store/recent-context.ts`
- Modify: `tests/store/store.test.ts`

- [ ] **Step 1: Write failing store test**

Add import:

```typescript
import { getRecentContext } from '../../src/store/recent-context.js';
```

Add test near storage query tests:

```typescript
  it('should return recent active knowledge and commits for session continuity', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const older = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Older active work',
      content: 'Older active work should appear after newer work.',
      tags: ['session'],
    });
    await repo.updateKnowledgeItem(older.id, {
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any);

    const newer = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Newest active work',
      content: 'Newest active work should appear first.',
      tags: ['session'],
    });
    await repo.updateKnowledgeItem(newer.id, {
      updatedAt: '2026-07-01T00:00:00.000Z',
    } as any);

    const archived = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Archived old work',
      content: 'Archived work should not appear in recent active context.',
      tags: ['session'],
    });
    await repo.updateKnowledgeItem(archived.id, {
      status: 'archived',
    } as any);

    await repo.createKnowledgeCommit(projectId, 'Older session commit', [], undefined);
    await repo.createKnowledgeCommit(projectId, 'Newest session commit', [], undefined);

    const context = await getRecentContext(projectId, {
      itemLimit: 2,
      commitLimit: 2,
    });

    expect(context.items.map(item => item.id)).toEqual([newer.id, older.id]);
    expect(context.items.some(item => item.id === archived.id)).toBe(false);
    expect(context.commits).toHaveLength(2);
    expect(context.commits[0].message).toBe('Newest session commit');
  });
```

- [ ] **Step 2: Run focused test and verify fail**

Run:

```powershell
npm test -- tests/store/store.test.ts -t "recent active knowledge"
```

Expected: FAIL because `recent-context.ts` does not exist.

- [ ] **Step 3: Create `src/store/recent-context.ts`**

```typescript
import { and, desc, eq } from 'drizzle-orm';
import { KnowledgeCommit, KnowledgeItem, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { getKnowledgeCommits } from './repository.js';

export type RecentContext = {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
};

export async function getRecentContext(
  projectId: string,
  options: {
    itemLimit?: number;
    commitLimit?: number;
  } = {}
): Promise<RecentContext> {
  const db = getDb();
  const itemLimit = options.itemLimit ?? 12;
  const commitLimit = options.commitLimit ?? 8;

  try {
    const rows = await db
      .select()
      .from(schema.knowledgeItems)
      .where(and(
        eq(schema.knowledgeItems.projectId, projectId),
        eq(schema.knowledgeItems.status, 'active')
      ))
      .orderBy(desc(schema.knowledgeItems.updatedAt))
      .limit(itemLimit);

    const items = rows.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));

    const commits = await getKnowledgeCommits(projectId, commitLimit);
    return { items, commits };
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch recent context: ${error.message}`);
  }
}
```

- [ ] **Step 4: Run focused test and verify pass**

Run:

```powershell
npm test -- tests/store/store.test.ts -t "recent active knowledge"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/store/recent-context.ts tests/store/store.test.ts
git commit -m "feat: add recent session context query"
```

---

### Task 2: Format Recent Context Markdown

**Files:**
- Modify: `src/core/format.ts`
- Modify: `tests/store/store.test.ts`

- [ ] **Step 1: Add test for formatter**

Add import:

```typescript
import { formatRecentContextToMarkdown } from '../../src/core/format.js';
```

Add test:

```typescript
  it('should format recent context for quick session resume', async () => {
    const markdown = formatRecentContextToMarkdown({
      items: [
        {
          id: 'item1',
          projectId: 'project1',
          category: 'state',
          status: 'active',
          title: 'Current plan',
          content: 'Implement recent context before query ranking.',
          reasoning: null,
          alternatives: null,
          tags: ['session'],
          source: null,
          confidence: 1,
          supersededById: null,
          version: 1,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      commits: [
        {
          id: 'commit1',
          projectId: 'project1',
          message: 'Store recent context plan',
          changes: [],
          createdAt: '2026-07-02T01:00:00.000Z',
        },
      ],
    });

    expect(markdown).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(markdown).toContain('Current plan');
    expect(markdown).toContain('Implement recent context before query ranking.');
    expect(markdown).toContain('Store recent context plan');
  });
```

- [ ] **Step 2: Run focused test and verify fail**

Run:

```powershell
npm test -- tests/store/store.test.ts -t "format recent context"
```

Expected: FAIL because formatter does not exist.

- [ ] **Step 3: Add formatter to `src/core/format.ts`**

```typescript
import { KnowledgeCommit, KnowledgeItem } from './types.js';
```

Change the existing import if needed from:

```typescript
import { KnowledgeItem } from './types.js';
```

To:

```typescript
import { KnowledgeCommit, KnowledgeItem } from './types.js';
```

Append:

```typescript
export function formatRecentContextToMarkdown(context: {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
}): string {
  let md = '# KNOWL - RECENT SESSION CONTEXT\n\n';

  md += '## Recent Active Knowledge\n\n';
  if (context.items.length === 0) {
    md += 'No recent active knowledge recorded.\n\n';
  } else {
    for (const item of context.items) {
      md += `- **${item.title}** (${item.category}, updated ${item.updatedAt})\n`;
      md += `  ${item.content}\n`;
      if (item.tags && item.tags.length > 0) {
        md += `  Tags: ${item.tags.join(', ')}\n`;
      }
    }
    md += '\n';
  }

  md += '## Recent Knowledge Commits\n\n';
  if (context.commits.length === 0) {
    md += 'No recent knowledge commits recorded.\n';
  } else {
    for (const commit of context.commits) {
      md += `- ${commit.createdAt}: ${commit.message}\n`;
    }
  }

  return md;
}
```

- [ ] **Step 4: Run focused test and verify pass**

Run:

```powershell
npm test -- tests/store/store.test.ts -t "format recent context"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/core/format.ts tests/store/store.test.ts
git commit -m "feat: format recent session context"
```

---

### Task 3: Expose Recent Context Through MCP

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/server.test.ts`

- [ ] **Step 1: Add failing MCP tests**

In `should list tools`, add:

```typescript
    expect(res.result.tools.some((t: any) => t.name === 'knowl_recent')).toBe(true);
```

In `should list resources`, add:

```typescript
    expect(res.result.resources.some((r: any) => r.uri === 'knowl://recent')).toBe(true);
```

Add tool call test:

```typescript
  it('should return recent session context through knowl_recent', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Resume target',
      content: 'Continue from recent context work.',
      tags: ['session'],
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_recent',
      arguments: {},
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(res.result.content[0].text).toContain('Resume target');
  });
```

Add resource read test:

```typescript
  it('should read recent session context resource', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Recent resource target',
      content: 'Resource exposes the same recent context.',
      tags: ['session'],
    });

    const res = await runRpcRequest('resources/read', {
      uri: 'knowl://recent',
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].text).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(res.result.contents[0].text).toContain('Recent resource target');
  });
```

- [ ] **Step 2: Run focused MCP tests and verify fail**

Run:

```powershell
npm test -- tests/mcp/server.test.ts -t "recent|list tools|list resources"
```

Expected: FAIL because MCP surface does not exist.

- [ ] **Step 3: Update imports in `src/mcp/server.ts`**

Add:

```typescript
import { getRecentContext } from '../store/recent-context.js';
```

Change formatter import from:

```typescript
import { formatHierarchyToMarkdown } from '../core/format.js';
```

To:

```typescript
import { formatHierarchyToMarkdown, formatRecentContextToMarkdown } from '../core/format.js';
```

- [ ] **Step 4: Add tool name**

Add `'knowl_recent'` to `KNOWL_MCP_TOOL_NAMES`:

```typescript
export const KNOWL_MCP_TOOL_NAMES = [
  'knowl_ingest',
  'knowl_state',
  'knowl_recent',
  'knowl_store',
  'knowl_ingest_atoms',
  'knowl_decide',
  'knowl_query',
  'knowl_update',
  'knowl_gc_preview',
  'knowl_gc_apply',
] as const;
```

- [ ] **Step 5: Add tool definition before `knowl_state`**

```typescript
        {
          name: 'knowl_recent',
          description: 'Get compact recent session context for starting or resuming work: recent active knowledge plus recent knowledge commits. Use this at the start of a new project-specific session before targeted knowl_query calls.',
          inputSchema: {
            type: 'object',
            properties: {
              itemLimit: {
                type: 'number',
                description: 'Maximum recent active knowledge items to return; defaults to 12.',
              },
              commitLimit: {
                type: 'number',
                description: 'Maximum recent knowledge commits to return; defaults to 8.',
              },
            },
          },
        },
```

- [ ] **Step 6: Add tool handler before `knowl_state` handler**

```typescript
      else if (name === 'knowl_recent') {
        const { itemLimit, commitLimit } = args as any;
        const context = await getRecentContext(projectId!, {
          itemLimit,
          commitLimit,
        });
        return {
          content: [{ type: 'text', text: formatRecentContextToMarkdown(context) }],
        };
      }
```

- [ ] **Step 7: Add resource definition**

```typescript
        {
          uri: 'knowl://recent',
          name: 'Recent Session Context',
          description: 'Compact recent active knowledge and knowledge commits for quickly resuming a project session.',
          mimeType: 'text/markdown',
        },
```

- [ ] **Step 8: Add resource read handler before `knowl://brain`**

```typescript
      if (uri === 'knowl://recent') {
        const context = await getRecentContext(projectId!);
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: formatRecentContextToMarkdown(context),
            },
          ],
        };
      }
```

- [ ] **Step 9: Run focused MCP tests and verify pass**

Run:

```powershell
npm test -- tests/mcp/server.test.ts -t "recent|list tools|list resources"
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat: expose recent session context over mcp"
```

---

### Task 4: Update New-Session Agent Guidance

**Files:**
- Modify: `src/core/agents-guidance.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add failing CLI guidance expectations**

In `should create AGENTS.md with Knowl MCP guidance during init`, add:

```typescript
    expect(content).toContain('At the start of a new project-specific session, call `knowl_recent` first');
    expect(content).toContain('After `knowl_recent`, use `knowl_query` for specific questions');
```

In `should refresh stale Knowl MCP guidance when init is rerun in an existing project`, add the same two expectations.

- [ ] **Step 2: Run focused CLI tests and verify fail**

Run:

```powershell
npm test -- tests/cli/cli.test.ts -t "AGENTS|refresh stale"
```

Expected: FAIL because generated guidance lacks `knowl_recent`.

- [ ] **Step 3: Update `KNOWL_AGENTS_SECTION` bullets**

Replace the opening bullets with:

```typescript
- At the start of a new project-specific session, call `knowl_recent` first to load recent active knowledge and knowledge commits before inspecting files or editing code.
- After `knowl_recent`, use `knowl_query` for specific questions. Use 2-6 concise search keywords from the user's question, not the whole question text.
- Do not use `knowl_ask` for MCP first-pass lookup. MCP agents already have a model; use `knowl_recent` and `knowl_query` for retrieval.
```

Keep the remaining guidance, but update any line that says `knowl_query` is the first start action so it no longer conflicts with `knowl_recent`.

- [ ] **Step 4: Run focused CLI tests and verify pass**

Run:

```powershell
npm test -- tests/cli/cli.test.ts -t "AGENTS|refresh stale"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/core/agents-guidance.ts tests/cli/cli.test.ts
git commit -m "docs: guide agents to load recent context first"
```

---

### Task 5: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run focused suites**

```powershell
npm test -- tests/store/store.test.ts
npm test -- tests/mcp/server.test.ts
npm test -- tests/cli/cli.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Build**

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Diff hygiene**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intended source/test/doc changes plus generated `dist/` if build updates it.

---

## Self-Review

- Spec coverage: Supports continuity by prioritizing recent active knowledge and recent knowledge commits, matching Knowl's structured-memory design.
- Placeholder scan: No TBD/TODO/deferred steps.
- Type consistency: Uses existing `KnowledgeItem`, `KnowledgeCommit`, `getKnowledgeCommits`, and MCP response patterns.
- Scope check: No raw transcript storage, schema migration, or ranking overhaul.
