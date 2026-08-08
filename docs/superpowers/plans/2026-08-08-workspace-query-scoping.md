# Workspace Query Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `knowl_query` from a repo that has never touched a subject must not return another repo's answer in a shape indistinguishable from its own.

**Architecture:** Relevance decides which rows reach the page, exactly as today. Those rows are then partitioned by owning repo: a bare JSON array when every returned row is local, an object keyed by repo when any row is foreign — so the response *shape* carries the attribution. `scoreCandidates` is not modified and is not even called differently; grouping happens after it returns, inside `queryFederated`.

> **Task 1 was implemented, measured, and corrected.** The original architecture gave local candidates every slot before any peer's. Measured against `docs/evals/cross-repo-archetypes.json` it collapsed Recall@3 on all five archetypes (asymmetric-trio 1.0 → 0.361, monorepo-split 1.0 → 0.528) — `perRepoCap` admits ten candidates per repo whatever their quality, so local nearly always held `limit` weak matches and peers never reached the page. Attribution moved to the shape alone, which costs two eval cells instead of the answer. Tasks 2–8 below are unaffected in substance; where they say "slot allocation", read "grouping".

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, SQLite via libsql, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-08-08-workspace-query-scoping-design.md`

## Global Constraints

- **Do not modify `src/store/agent-query.ts`.** Global alpha, the page-wide semantic rescale, and the cross-corpus abstention verdict (K-36) all depend on the single union scoring pass. See the spec's "Scoring stays a single union pass" section.
- **A repo with no workspace behaves exactly as before.** `resolveWorkspace` returns `null`, `queryFederated` is never reached, and the response is the same bare array it has always been. Every task preserves this.
- **The first MCP content block stays parseable JSON.** A bare array in the flat case, an object in the grouped case. Notices are always separate blocks.
- **Peer reads stay read-only and `visibility: 'workspace'`-filtered in SQL.** Nothing in this plan touches `openPeerStore` or the visibility predicate.
- **Local is always the first group**, including when it is empty. Its position is what says "this is your repo, and this is what it had."
- Run `npm.cmd test` and `npm.cmd run typecheck` before claiming any task complete. **Both are clean on this branch** — measured 2026-08-08: 253 files / 2206 passed / 4 skipped / 0 failed, and `tsc --noEmit` reports 0 errors. An earlier draft of this plan cited a 15-error typecheck baseline carried over from the 2.7.0 release notes; it no longer holds, so any typecheck error is this work's.
- **In a fresh worktree, `npm run build` before `npm test`.** Several suites spawn `./dist/index.js` (e.g. `tests/store/retention.test.ts:175`) and `dist/` is gitignored, so without a build 19 files / 67 tests fail in a way that reads as broken code rather than a missing prerequisite.

---

### Task 1: Slot allocation and grouped results in `queryFederated`

**Files:**
- Modify: `src/workspace/federated-query.ts:22-26` (result types), `:141-176` (scoring call and return)
- Modify: `tests/workspace/federated-query.test.ts` (existing assertions read `result.items`)
- Test: `tests/workspace/federated-slot-priority.test.ts` (create)

**Interfaces:**
- Consumes: `scoreCandidates`, `ScoredCandidate` from `src/store/agent-query.js` (unchanged)
- Produces:
  - `type FederatedGroup = { repo: string; items: FederatedItem[] }`
  - `type FederatedResult = { groups: FederatedGroup[]; unshown: Array<{ repo: string; matches: number }>; shape: 'flat' | 'grouped'; skipped: Array<{ repo: string; reason: SkipReason }> }`
  - `function flattenGroups(result: FederatedResult): FederatedItem[]`

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/federated-slot-priority.test.ts`. Copy the `HOME`/`A`/`B`, `seed`, `addItems`, `beforeEach` and `afterEach` scaffolding verbatim from `tests/workspace/federated-query.test.ts:1-91`, changing only the three directory constants to `./.knowl-slot-home`, `./.knowl-slot-a`, `./.knowl-slot-b`, and seeding as below.

```typescript
// Replace the beforeEach seeds with these two. Repo `a` (local) knows nothing about
// deployment; repo `b` does. This is the reported bug in fixture form.
await seed(A, 'a', [
  { title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' },
]);
await seed(B, 'b', [
  { title: 'Deploy runs on tag push', content: 'Deployment is triggered by pushing a tag.', visibility: 'workspace' },
]);

async function federate(query: string, limit: number, repos?: string[]) {
  await initDb(A);
  try {
    const active = (await resolveWorkspace(A))!;
    return await queryFederated({ workspace: active, query, limit, repos });
  } finally {
    await closeDb();
  }
}

it('groups by repo when a peer row wins a slot, with local first and empty', async () => {
  const result = await federate('deployment tag push', 5);

  expect(result.shape).toBe('grouped');
  expect(result.groups[0].repo).toBe('a');
  expect(result.groups[0].items).toEqual([]);
  expect(result.groups[1].repo).toBe('b');
  expect(result.groups[1].items[0].title).toBe('Deploy runs on tag push');
});

it('stays flat when every returned row is local', async () => {
  const result = await federate('auth tokens expire', 5);

  expect(result.shape).toBe('flat');
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0].repo).toBe('a');
  expect(result.groups[0].items[0].title).toBe('Local auth note');
});

it('fills every slot from local before any peer row is considered', async () => {
  // Both repos answer. Local must take the whole page at limit 1, however the peer scored.
  await addItems(A, 'a', [
    { title: 'Deploy notes for a', content: 'Deployment here is manual.', visibility: 'repo' },
  ]);
  const result = await federate('deployment', 1);

  expect(result.shape).toBe('flat');
  expect(result.groups[0].items).toHaveLength(1);
  expect(result.groups[0].items[0].repo).toBe('a');
});

it('reports a peer that matched but won no slot, by name and count only', async () => {
  await addItems(A, 'a', [
    { title: 'Deploy notes for a', content: 'Deployment here is manual.', visibility: 'repo' },
  ]);
  const result = await federate('deployment', 1);

  expect(result.unshown).toEqual([{ repo: 'b', matches: 1 }]);
});

it('never returns more than the limit across all groups', async () => {
  await addItems(A, 'a', [
    { title: 'Deploy notes for a', content: 'Deployment here is manual.', visibility: 'repo' },
  ]);
  const result = await federate('deployment', 2);
  const total = result.groups.reduce((count, group) => count + group.items.length, 0);

  expect(total).toBe(2);
});

it('flattens local first, then peers, for callers that score one ranking', async () => {
  const result = await federate('deployment tag push', 5);

  expect(flattenGroups(result).map(item => item.repo)).toEqual(['b']);
});
```

Add `flattenGroups` to the import from `../../src/workspace/federated-query.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/workspace/federated-slot-priority.test.ts`
Expected: FAIL — `result.shape` is undefined and `flattenGroups` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/workspace/federated-query.ts`, replace the `FederatedResult` type (currently lines 23-26):

```typescript
export type FederatedGroup = { repo: string; items: FederatedItem[] };

export type FederatedResult = {
  /**
   * Results partitioned by owning repo, local always first and present even when empty.
   *
   * Grouping is the whole mechanism: a bare array reads as "this repo's answer", and no notice
   * beside one is loud enough to stop it being read that way when the rows are foreign. The
   * shape is what an agent cannot skim past.
   */
  groups: FederatedGroup[];
  /**
   * Peers whose candidates were scored but won no slot, by name and count. Never content --
   * including it would reintroduce exactly the silent substitution grouping exists to remove.
   * Counts are bounded by `perRepoCap`, so a peer holding more matches than the cap reports
   * the cap.
   */
  unshown: Array<{ repo: string; matches: number }>;
  /**
   * Flat iff every returned row is local. An explicit `scope` or `repos` fixes this instead
   * (Task 2): a caller that named repos asked for a partitioned view and gets one whether or
   * not the partition turned out interesting.
   */
  shape: 'flat' | 'grouped';
  skipped: Array<{ repo: string; reason: SkipReason }>;
};

/**
 * One ranking again, local first then peers in group order.
 *
 * For callers that genuinely need a single list -- the eval suites, which score MRR -- rather
 * than for the MCP surface, whose entire point is that the list is not single.
 */
export function flattenGroups(result: FederatedResult): FederatedItem[] {
  return result.groups.flatMap(group => group.items);
}
```

Add the allocator above `queryFederated`:

```typescript
/**
 * Which rows get the page, decided by ownership rather than by score.
 *
 * A count, not a judgement, and that is the point. The obvious rule -- give peers the page only
 * when local fails to answer -- needs a verdict on whether local answered, and three measurements
 * say no threshold can produce one: scale-free rules were measured and rejected
 * (`agent-query.ts:149-155`), the floor fires far less than assumed on a real store, and
 * near-miss queries score ABOVE genuinely answerable ones. "Something this repo has not done
 * yet" is a near-miss query, so a floor-gated rule would be blind in exactly the case it was
 * built for. Counting rows is reliable where scoring them is not, and it behaves identically
 * with vectors on or off.
 *
 * `scored` arrives in score order and stays in it within each ownership tier, so the first peer
 * row is the best-scoring peer row -- which is what makes first-appearance order of peer repos
 * the same as descending best score, with nothing sorted twice.
 */
function allocateSlots(
  scored: ScoredCandidate[],
  localRepo: string,
  limit: number,
): { taken: ScoredCandidate[]; unshown: Array<{ repo: string; matches: number }> } {
  const repoOf = (entry: ScoredCandidate) => entry.repo ?? localRepo;
  const taken: ScoredCandidate[] = [];
  for (const entry of scored) {
    if (taken.length >= limit) break;
    if (repoOf(entry) === localRepo) taken.push(entry);
  }
  for (const entry of scored) {
    if (taken.length >= limit) break;
    if (repoOf(entry) !== localRepo) taken.push(entry);
  }

  const shown = new Set(taken.map(entry => entry.item.id));
  const counts = new Map<string, number>();
  for (const entry of scored) {
    const repo = repoOf(entry);
    if (shown.has(entry.item.id) || repo === localRepo) continue;
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return { taken, unshown: [...counts].map(([repo, matches]) => ({ repo, matches })) };
}
```

Replace the `scoreCandidates` call and return (currently lines 141-176) with:

```typescript
  // Scored over the union, and with a limit that covers every candidate rather than the page.
  //
  // The union is not negotiable: alpha renormalises globally because "two repos scored under
  // different alphas would not be comparable", the semantic rescale min-maxes across the page,
  // and the abstention verdict deliberately labels rows from a corpus that judged nothing
  // (K-36). Scoring per repo would break all three. The wide limit is what leaves rows for
  // `allocateSlots` to allocate -- `scoreCandidates` would otherwise have already cut to the
  // page by relevance alone, which is the decision being replaced.
  const scored = scoreCandidates([...byContent.values()], {
    query: input.query,
    category: input.category,
    limit: byContent.size,
    usingVector: Boolean(input.vector?.enabled && input.vector.embedding),
    minRelevance: input.vector?.relevanceFloor ?? null,
  });

  const { taken, unshown } = allocateSlots(scored, input.workspace.repo, input.limit);

  const selfKin = input.workspace.manifest.repos.find(entry => entry.name === input.workspace.repo)?.kin;
  const kinRepos = new Set(
    selfKin
      ? input.workspace.peers.filter(peer => peer.kin === selfKin).map(peer => peer.name)
      : [],
  );

  // Local first and always present. An empty local group is the response saying "your repo had
  // nothing", which is the sentence the old flat array could not form.
  const groups: FederatedGroup[] = [{ repo: input.workspace.repo, items: [] }];
  const byRepo = new Map<string, FederatedGroup>([[input.workspace.repo, groups[0]]]);
  for (const entry of taken) {
    const repo = entry.repo ?? input.workspace.repo;
    let group = byRepo.get(repo);
    if (!group) {
      group = { repo, items: [] };
      byRepo.set(repo, group);
      groups.push(group);
    }
    group.items.push({
      ...entry.item,
      repo,
      explanation: entry.explanation,
      ...(kinRepos.has(repo) ? { kinDivergent: true as const } : {}),
    });
  }

  return {
    groups,
    unshown,
    shape: groups.length > 1 ? 'grouped' : 'flat',
    skipped,
  };
```

Add `ScoredCandidate` to the type import on line 2:

```typescript
import { scoreCandidates, selectCandidates, type Candidate, type RankOptions, type ScoredCandidate } from '../store/agent-query.js';
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm.cmd test -- tests/workspace/federated-slot-priority.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Update the existing federated tests to the new shape**

`tests/workspace/federated-query.test.ts` asserts on `result.items` in twelve places. Import `flattenGroups` and introduce a local helper directly under the `federate` function (line 69):

```typescript
/** The old flat view, for assertions about what federation finds rather than how it shapes it. */
async function items(query: string, limit: number, repos?: string[]) {
  return flattenGroups(await federate(query, limit, repos));
}
```

Then replace each `const result = await federate(...)` / `result.items` pair with `const found = await items(...)` / `found`. Two tests also read `result.skipped` — those keep `federate` and add a second call, or destructure:

```typescript
it('reports a repo name that matches nothing, instead of quietly not searching it', async () => {
  const result = await federate('auth', 5, ['bee']);

  expect(flattenGroups(result)).toEqual([]);
  expect(result.skipped).toEqual([{ repo: 'bee', reason: 'unknown' }]);
});
```

- [ ] **Step 6: Run the whole workspace suite**

Run: `npm.cmd test -- tests/workspace/`
Expected: `federated-abstention`, `federated-kin`, `cross-repo-eval`, `cross-repo-semantic` and `cross-repo-archetypes` FAIL on `.items` — they are Tasks 6 and 7. `federated-query` and `federated-slot-priority` PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workspace/federated-query.ts tests/workspace/federated-slot-priority.test.ts tests/workspace/federated-query.test.ts
git commit -m "feat(workspace): fill result slots from the local repo first

Local candidates take the page before any peer row is considered, and output
groups by owning repo whenever a foreign row wins a slot. The shape is the
signal: a bare array reads as this repo's answer, and no notice beside one is
loud enough to stop it being read that way.

Allocation counts rows rather than scoring them. A verdict on whether local
answered cannot be built -- scale-free rules were measured and rejected, and
near-miss queries score above genuinely answerable ones, which is exactly the
case here.

scoreCandidates is untouched and still scores the union."
```

---

### Task 2: `scope` parameter

**Files:**
- Modify: `src/workspace/federated-query.ts` (input type, `wanted` resolution, `shape`)
- Modify: `src/mcp/tool-definitions.ts:359-364` (input schema)
- Test: `tests/workspace/federated-scope.test.ts` (create)

**Interfaces:**
- Consumes: `FederatedResult`, `queryFederated` from Task 1
- Produces: `queryFederated` input gains `scope?: 'local' | 'workspace'`

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/federated-scope.test.ts` with the same scaffolding as Task 1 (directories `./.knowl-scope-home`, `./.knowl-scope-a`, `./.knowl-scope-b`, same two seeds), and this `federate` signature:

```typescript
async function federate(query: string, limit: number, extra: {
  repos?: string[];
  scope?: 'local' | 'workspace';
} = {}) {
  await initDb(A);
  try {
    const active = (await resolveWorkspace(A))!;
    return await queryFederated({ workspace: active, query, limit, ...extra });
  } finally {
    await closeDb();
  }
}

it('searches only this repo under scope local', async () => {
  const result = await federate('deployment tag push', 5, { scope: 'local' });

  expect(result.groups).toHaveLength(1);
  expect(result.groups[0].repo).toBe('a');
  expect(result.groups[0].items).toEqual([]);
});

it('opens no peer database under scope local', async () => {
  const peerDb = path.join(B, '.knowl', 'knowl.db');
  const before = await fs.readFile(peerDb);
  await federate('deployment', 5, { scope: 'local' });
  await releaseAll();

  expect((await fs.readFile(peerDb)).equals(before)).toBe(true);
});

it('is flat under scope local even with nothing found', async () => {
  const result = await federate('deployment tag push', 5, { scope: 'local' });

  expect(result.shape).toBe('flat');
});

it('is grouped under scope workspace even when only local answers', async () => {
  // An explicit scope fixes the shape. A caller who asked for a partitioned view gets one
  // whether or not the partition turned out interesting -- a shape that changed under them
  // based on what was found would be worse than a one-key object.
  const result = await federate('auth tokens expire', 5, { scope: 'workspace' });

  expect(result.shape).toBe('grouped');
  expect(result.groups[0].repo).toBe('a');
});

it('is grouped when repos names a single repo', async () => {
  const result = await federate('deployment', 5, { repos: ['b'] });

  expect(result.shape).toBe('grouped');
});

it('lets repos win when both are passed', async () => {
  const result = await federate('deployment tag push', 5, { repos: ['b'], scope: 'local' });

  expect(result.groups.some(group => group.repo === 'b' && group.items.length > 0)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/workspace/federated-scope.test.ts`
Expected: FAIL — `scope` is not in the input type, so `scope: 'local'` still searches peers.

- [ ] **Step 3: Write the implementation**

Add to the `queryFederated` input type, after `repos?: string[];`:

```typescript
  /**
   * A named scope, for callers that do not know their own repo's name.
   *
   * `repos: ['<self>']` already means local-only, and an agent cannot reliably write it -- it
   * would have to know what this repo is called in the manifest. That is the whole reason this
   * exists beside `repos` rather than instead of it.
   *
   * `repos` wins when both arrive: it is the more specific of the two, and refusing a benign
   * combination would cost a caller their answer over a preference.
   */
  scope?: 'local' | 'workspace';
```

Replace the `wanted` line (currently line 79):

```typescript
  const scoped = input.repos && input.repos.length > 0
    ? input.repos
    : (input.scope === 'local' ? [input.workspace.repo] : undefined);
  const wanted = scoped ? new Set(scoped) : null;
```

Replace the `shape` expression in the return:

```typescript
    // An explicit scope fixes the shape; only the default path derives it from what was found.
    shape: (input.scope || (input.repos && input.repos.length > 0))
      ? (input.scope === 'local' ? 'flat' : 'grouped')
      : (groups.length > 1 ? 'grouped' : 'flat'),
```

In `src/mcp/tool-definitions.ts`, add directly after the `repos` property (line 364):

```typescript
              scope: {
                type: 'string',
                enum: ['local', 'workspace'],
                description: 'Only in a workspace. `local` searches this repo alone and returns a bare array; `workspace` searches every sharing repo and returns results keyed by repo. Omit for the default, which fills the page from this repo first and only groups when a linked repo won a slot. `repos` wins if both are given.',
              },
```

In `src/mcp/tools.ts`, add `scope` to the destructured args of the `knowl_query` handler and pass it through to `queryFederated` alongside `repos`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm.cmd test -- tests/workspace/federated-scope.test.ts tests/workspace/federated-slot-priority.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/federated-query.ts src/mcp/tool-definitions.ts src/mcp/tools.ts tests/workspace/federated-scope.test.ts
git commit -m "feat(workspace): add scope local and scope workspace to knowl_query

repos: ['<self>'] already meant local-only, and an agent cannot reliably write
it -- it would have to know what this repo is called in the manifest. scope is
the spelling that needs no such knowledge.

An explicit scope fixes the response shape; only the default path derives it
from what was found. A caller who named repos asked for a partitioned view and
gets one whether or not the partition turned out interesting."
```

---

### Task 3: Bound a grouped payload

**Files:**
- Modify: `src/mcp/tools.ts:251-277` (`boundQueryPayload`)
- Test: `tests/mcp/bound-grouped-payload.test.ts` (create)

**Interfaces:**
- Consumes: `MAX_RESPONSE_CHARS`, `compactMcpJson`, `truncateText`, `QUERY_EXCERPT_CHARS` (all already in `tools.ts`)
- Produces: `boundQueryPayload(groups: Array<{ repo: string; rows: Record<string, unknown>[] }>, shape: 'flat' | 'grouped')` returning the same `{ text, shortened, omitted }`

- [ ] **Step 1: Write the failing test**

`boundQueryPayload` is module-private. Export it for the test — add `export` to its declaration as part of Step 3. Create `tests/mcp/bound-grouped-payload.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { boundQueryPayload } from '../../src/mcp/tools.js';

const row = (id: string, size: number) => ({ id, title: id, content: 'x'.repeat(size) });

describe('boundQueryPayload', () => {
  it('serializes a single local group as a bare array', () => {
    const { text } = boundQueryPayload([{ repo: 'a', rows: [row('one', 10)] }], 'flat');

    expect(JSON.parse(text)).toEqual([{ id: 'one', title: 'one', content: 'x'.repeat(10) }]);
  });

  it('serializes groups as an object keyed by repo, in the order given', () => {
    const { text } = boundQueryPayload([
      { repo: 'a', rows: [] },
      { repo: 'b', rows: [row('two', 10)] },
    ], 'grouped');

    expect(Object.keys(JSON.parse(text))).toEqual(['a', 'b']);
    expect(JSON.parse(text).a).toEqual([]);
  });

  it('shortens a peer group body before a local one', () => {
    // Groups arrive local-first, so the global tail is the last peer group's last row -- the
    // existing "the tail gives up its body first" rule already produces "peers before local"
    // when it walks the group order backwards.
    const { text, shortened } = boundQueryPayload([
      { repo: 'a', rows: [row('local', 30_000)] },
      { repo: 'b', rows: [row('peer', 30_000)] },
    ], 'grouped');
    const parsed = JSON.parse(text);

    expect(shortened).toBeGreaterThan(0);
    expect(parsed.b[0].truncated).toBe(true);
    expect(parsed.a[0].content).toHaveLength(30_000);
  });

  it('keeps at least one row rather than returning an empty page', () => {
    const { text } = boundQueryPayload(
      [{ repo: 'a', rows: [row('only', 200_000)] }],
      'flat',
    );

    expect(JSON.parse(text)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/mcp/bound-grouped-payload.test.ts`
Expected: FAIL — `boundQueryPayload` is not exported and takes a flat array.

- [ ] **Step 3: Write the implementation**

Replace `boundQueryPayload` (lines 251-277) with:

```typescript
/**
 * Shrink the lowest-ranked results until the serialized payload fits the response ceiling.
 *
 * [Keep the existing doc comment from lines 228-250 verbatim above this line.]
 *
 * Grouped payloads walk the same tail-first rule over a flattened view, and because groups
 * arrive local-first the global tail IS the last peer group's last row. "Trim peers before
 * local" therefore needs no separate rule -- it is what the existing one already does once the
 * rows are laid end to end.
 */
export function boundQueryPayload(
  groups: Array<{ repo: string; rows: Record<string, unknown>[] }>,
  shape: 'flat' | 'grouped',
): { text: string; shortened: number; omitted: number } {
  // One flat view for the shrink walk, one grouped view for serialization, sharing row objects
  // by reference so a replacement in the walk is visible in both.
  const kept = groups.flatMap(group =>
    group.rows.map(value => ({ repo: group.repo, value, shortened: false })));
  const serialize = () => {
    if (shape === 'flat') return compactMcpJson(kept.map(entry => entry.value));
    const byRepo: Record<string, Record<string, unknown>[]> = {};
    for (const group of groups) byRepo[group.repo] = [];
    for (const entry of kept) byRepo[entry.repo].push(entry.value);
    return compactMcpJson(byRepo);
  };

  let text = serialize();
  if (text.length <= MAX_RESPONSE_CHARS) return { text, shortened: 0, omitted: 0 };

  for (let index = kept.length - 1; index >= 0 && text.length > MAX_RESPONSE_CHARS; index--) {
    const content = kept[index].value.content;
    if (typeof content !== 'string' || content.length <= QUERY_EXCERPT_CHARS) continue;
    kept[index] = {
      repo: kept[index].repo,
      value: { ...kept[index].value, content: truncateText(content, QUERY_EXCERPT_CHARS), truncated: true },
      shortened: true,
    };
    text = serialize();
  }

  let omitted = 0;
  while (text.length > MAX_RESPONSE_CHARS && kept.length > 1) {
    kept.pop();
    omitted += 1;
    text = serialize();
  }

  return { text, shortened: kept.filter(entry => entry.shortened).length, omitted };
}
```

Note: an empty group must still serialize as `[]` under its key, which is why `byRepo` is seeded from `groups` before rows are distributed — an empty local group is the whole point of the grouped shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/mcp/bound-grouped-payload.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/bound-grouped-payload.test.ts
git commit -m "feat(mcp): bound a grouped query payload, trimming peers before local

Groups arrive local-first, so the global tail is the last peer group's last
row -- the existing tail-first rule already produces 'peers before local' once
the rows are laid end to end. No separate rule, and an empty local group still
serialises as [] under its key, which is the shape's whole point."
```

---

### Task 4: Wire the grouped shape and the two notices into `knowl_query`

**Files:**
- Modify: `src/mcp/tools.ts:743-903` (the `knowl_query` federation branch, payload assembly and notice blocks)
- Test: `tests/mcp/query-scoping.test.ts` (create)

**Interfaces:**
- Consumes: `FederatedResult` with `groups`/`unshown`/`shape` (Task 1), `boundQueryPayload(groups, shape)` (Task 3)
- Produces: no new exports; the `knowl_query` response gains a grouped first block, a `LOCAL MISS` block and a `WORKSPACE` pointer block

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/query-scoping.test.ts`. Follow the harness in `tests/workspace/federated-abstention.test.ts` for calling the tool handler — same two-repo fixture as Task 1 (local `a` knows auth, peer `b` knows deployment).

```typescript
it('returns a grouped first block when a peer row wins a slot', async () => {
  const response = await callQuery({ query: 'deployment tag push' });
  const parsed = JSON.parse(response.content[0].text);

  expect(Array.isArray(parsed)).toBe(false);
  expect(parsed.a).toEqual([]);
  expect(parsed.b[0].title).toBe('Deploy runs on tag push');
});

it('says LOCAL MISS naming this repo when the local group is empty', async () => {
  const response = await callQuery({ query: 'deployment tag push' });
  const notice = response.content.map((block: any) => block.text).join('\n');

  expect(notice).toContain('LOCAL MISS');
  expect(notice).toContain('a');
});

it('keeps a bare array and adds no LOCAL MISS when local answers', async () => {
  const response = await callQuery({ query: 'auth tokens expire' });
  const parsed = JSON.parse(response.content[0].text);
  const notice = response.content.map((block: any) => block.text).join('\n');

  expect(Array.isArray(parsed)).toBe(true);
  expect(notice).not.toContain('LOCAL MISS');
});

it('points at a peer that matched but won no slot, without its content', async () => {
  const response = await callQuery({ query: 'auth tokens expire' });
  const notice = response.content.map((block: any) => block.text).join('\n');

  expect(notice).toContain('WORKSPACE:');
  expect(notice).toContain('b');
  // Names and counts only. Content here would be the silent substitution being removed.
  expect(notice).not.toContain('Deploy runs on tag push');
});

it('omits the repo field inside groups, where the key already says it', async () => {
  const response = await callQuery({ query: 'deployment tag push' });
  const parsed = JSON.parse(response.content[0].text);

  expect(parsed.b[0].repo).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/mcp/query-scoping.test.ts`
Expected: FAIL — the first block is still a bare array and no `LOCAL MISS` block exists.

- [ ] **Step 3: Write the implementation**

Replace the federation branch's result handling (lines 742-762) so `resolvedItems` is derived from groups rather than replacing them, keeping every downstream consumer working:

```typescript
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        let federated: FederatedResult | null = null;
        let resolvedItems: Array<KnowledgeItem & { repo?: string; explanation?: unknown }> = items as any;
        if (active) {
          federated = await queryFederated({
            workspace: active,
            query: query ?? '',
            category: category as KnowledgeCategory,
            status: status as KnowledgeStatus,
            tags,
            limit: limit ?? 3,
            repos,
            scope,
            vector,
          });
          resolvedItems = flattenGroups(federated);
        }
        const skippedRepos: FederatedResult['skipped'] = federated?.skipped ?? [];
```

Replace the payload assembly (lines 822-830). `compact` already omits `affectedPaths` and evidence for foreign items — that stays. Add a variant that also drops `repo` inside groups:

```typescript
        const compactInGroup = (item: any) => {
          const { repo: _repo, ...rest } = compact(item);
          return rest;
        };
        const payloadGroups = federated
          ? await Promise.all(federated.groups.map(async group => ({
            repo: group.repo,
            rows: includeEvidence
              ? await Promise.all(group.items.map(async item => (isForeign(item)
                ? compactInGroup(item)
                : { ...compactInGroup(item), evidence: boundedEvidence(await withStaleStatus(item.id)) })))
              : group.items.map(compactInGroup),
          })))
          : [{
            repo: '',
            rows: includeEvidence
              ? await Promise.all(resolvedItems.map(async item => ({ ...compact(item), evidence: boundedEvidence(await withStaleStatus(item.id)) })))
              : resolvedItems.map(compact),
          }];
        const shape = federated?.shape ?? 'flat';
        const { text: payloadText, shortened, omitted: omittedResults } = boundQueryPayload(payloadGroups as any, shape);
        const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: payloadText }];
```

Add the two new blocks. Put `LOCAL MISS` immediately after the `RESPONSE BOUNDED` block and before `SCOPE`, so the most consequential notice is read first:

```typescript
        // The local group is empty and a peer's is not: this repo does not hold the answer and
        // another repo's is what is on offer. The shape already says so -- this says why, and
        // says the one thing the shape cannot, which is that a foreign fact describes a foreign
        // repo. Only on the default path: a caller who asked for `scope: 'workspace'` requested
        // exactly this and does not need to be told.
        if (federated && !scope && federated.groups[0].items.length === 0 && federated.groups.length > 1) {
          const answering = federated.groups.slice(1).map(group => group.repo).join(', ');
          blocks.push({
            type: 'text',
            text: `LOCAL MISS: ${federated.groups[0].repo} (this repo) returned nothing for this query. `
              + `Everything above is from ${answering} and describes ${federated.groups.length > 2 ? 'those repos' : 'that repo'}, not this one. `
              + 'Verify against this repo before applying it, and treat this as a miss if it does not transfer.',
          });
        }
        // A peer matched and won no slot. Names and counts, never content: the knowledge stays
        // findable without the response being able to substitute it for this repo's own.
        if (federated?.unshown.length) {
          const described = federated.unshown.map(entry => `${entry.repo} (${entry.matches})`).join(', ');
          const names = federated.unshown.map(entry => `"${entry.repo}"`).join(', ');
          blocks.push({
            type: 'text',
            text: `WORKSPACE: linked repos also hold matches not shown here: ${described}. `
              + `Re-query with repos: [${names}] to read them.`,
          });
        }
```

Import `flattenGroups` alongside `queryFederated` on line 8.

The kin block (lines 876-885) and the demand ledger (lines 916-977) both read `resolvedItems`, which is now the flattened groups — no change needed in either.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm.cmd test -- tests/mcp/query-scoping.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the MCP and workspace suites**

Run: `npm.cmd test -- tests/mcp/ tests/workspace/`
Expected: PASS except the eval suites (Task 7) and `federated-abstention` if it asserts on `.items` (Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/query-scoping.test.ts
git commit -m "feat(mcp): return knowl_query results keyed by repo when a peer answers

The first block stays a bare array while every row is local and becomes an
object keyed by repo the moment one is not, so the structure carries the
attribution. LOCAL MISS says what the shape cannot -- that a foreign fact
describes a foreign repo -- and a WORKSPACE pointer names peers that matched
and won no slot, by count, never by content.

The repo field is dropped inside groups, where the key already says it."
```

---

### Task 5: Grouped rendering in `knowl query`

**Files:**
- Modify: `src/cli/query-command.ts:19-22` (`CliQueryResult`), `:95-101` (federation branch)
- Modify: `src/cli/program.ts` (wherever `runCliQuery`'s result is printed)
- Test: `tests/cli/query-scoping.test.ts` (create)

**Interfaces:**
- Consumes: `FederatedResult` with `groups`/`unshown`/`shape` (Task 1)
- Produces: `CliQueryResult = { groups: Array<{ repo: string; items: CliQueryItem[] }>; unshown: FederatedResult['unshown']; shape: 'flat' | 'grouped'; skipped: FederatedResult['skipped'] }`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/query-scoping.test.ts`, same two-repo fixture as Task 1, calling `runCliQuery` directly:

```typescript
it('groups CLI results by repo when a peer answers', async () => {
  const result = await runCliQuery({ projectRoot: A, projectId, query: 'deployment tag push' });

  expect(result.shape).toBe('grouped');
  expect(result.groups[0].repo).toBe('a');
  expect(result.groups[0].items).toEqual([]);
});

it('stays flat for an unlinked repo, which never reaches federation', async () => {
  const result = await runCliQuery({ projectRoot: UNLINKED, projectId: unlinkedId, query: 'anything' });

  expect(result.shape).toBe('flat');
  expect(result.groups).toHaveLength(1);
});

it('keeps --as-of local and flat, since it does not run through the ranker', async () => {
  const result = await runCliQuery({
    projectRoot: A, projectId, query: 'auth', asOf: new Date().toISOString(),
  });

  expect(result.shape).toBe('flat');
  expect(result.groups).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cli/query-scoping.test.ts`
Expected: FAIL — `result.shape` and `result.groups` do not exist.

- [ ] **Step 3: Write the implementation**

Replace `CliQueryResult`:

```typescript
export type CliQueryItem = KnowledgeItem & { repo?: string; score?: number; abstained?: boolean };

export type CliQueryResult = {
  /**
   * Same partition the MCP surface returns, for the same reason: a human reading a bare list
   * cannot see which repo answered either. `shape` is 'flat' exactly when there is one group
   * and it is this repo's.
   */
  groups: Array<{ repo: string; items: CliQueryItem[] }>;
  unshown: FederatedResult['unshown'];
  shape: 'flat' | 'grouped';
  skipped: FederatedResult['skipped'];
};

/** The single-group shape the two non-federated paths return. */
function flat(repo: string, items: CliQueryItem[]): CliQueryResult {
  return { groups: [{ repo, items }], unshown: [], shape: 'flat', skipped: [] };
}
```

Update the three return sites:

```typescript
  // asOf branch
  return flat('', items);

  // federated branch
  if (active) {
    const federated = await queryFederated({
      workspace: active, query: input.query ?? '', limit, vector,
    });
    return {
      groups: federated.groups.map(group => ({
        repo: group.repo,
        items: group.items.map(withRankerVerdict),
      })),
      unshown: federated.unshown,
      shape: federated.shape,
      skipped: federated.skipped,
    };
  }

  // unlinked branch
  const ranked = await rankKnowledge(input.projectId, { query: input.query, limit, vector });
  return flat('', ranked.map(withRankerVerdict));
```

In `src/cli/program.ts`, the printer iterates `result.items`. Change it to iterate groups, printing a `repo:` heading line before each group's rows when `shape === 'grouped'`, and printing an empty group as the heading followed by `(nothing in this repo)`. Print the `unshown` pointer as a trailing line when non-empty, in the same words the MCP block uses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm.cmd test -- tests/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/query-command.ts src/cli/program.ts tests/cli/query-scoping.test.ts
git commit -m "feat(cli): group knowl query output by repo when a peer answers

Same partition the MCP surface returns, for the same reason: a human reading a
bare list cannot see which repo answered either. An empty local group prints
its heading and says so, rather than being absent."
```

---

### Task 6: Record demand under `scope: 'local'`, and whether local filled the page

**Files:**
- Modify: `src/mcp/tools.ts:916-977` (the demand ledger call)
- Modify: `src/workspace/demand-ledger.ts` (`detail` shape, if it is typed)
- Test: `tests/workspace/demand-scoping.test.ts` (create)

**Interfaces:**
- Consumes: `recordDemandEventBestEffort`, `FederatedResult` (Task 1)
- Produces: `detail` gains `localFilled: boolean` and `scope?: 'local'`

- [ ] **Step 1: Write the failing test**

```typescript
it('records a federated_query event even when scope is local', async () => {
  // Skipping peer selection must not skip the ledger. The ledger is what the demand-paged
  // scoping design is waiting on to fill, and a scope that silently stopped recording would
  // under-report the exact quantity being measured.
  await callQuery({ query: 'deployment', scope: 'local' });
  const events = await readDemandEvents('ws');

  expect(events).toHaveLength(1);
  expect(events[0].detail.scope).toBe('local');
});

it('records whether the local repo filled the page', async () => {
  await callQuery({ query: 'deployment tag push' });
  const events = await readDemandEvents('ws');

  expect(events[0].detail.localFilled).toBe(false);
});

it('records localFilled true when local took every slot', async () => {
  await callQuery({ query: 'auth tokens expire', limit: 1 });
  const events = await readDemandEvents('ws');

  expect(events[0].detail.localFilled).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/workspace/demand-scoping.test.ts`
Expected: FAIL — `detail.scope` and `detail.localFilled` are absent.

- [ ] **Step 3: Write the implementation**

In the `detail` object of the `recordDemandEventBestEffort` call, add:

```typescript
              // Whether this repo answered its own question, which is the quantity slot priority
              // actually changes and the one nothing measured before. Read from the local group's
              // occupancy rather than from a score, for the same reason allocation is: no
              // threshold can tell a weak local answer from no answer.
              localFilled: (federated?.groups[0].items.length ?? 0) >= (limit ?? 3),
              // A locally-scoped query still records. Skipping peer selection must not skip the
              // ledger -- it is the measurement the demand-paged design is waiting on, and a
              // scope that quietly stopped recording would under-report cross-repo demand by
              // exactly the queries most likely to have wanted it.
              ...(scope === 'local' ? { scope: 'local' as const } : {}),
```

The guard on the whole block is `if (active && query)`, which still holds under `scope: 'local'` — no change needed there. Confirm `bestCosine` still computes: `resolvedItems` under `scope: 'local'` holds only local rows, which is correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm.cmd test -- tests/workspace/demand-scoping.test.ts tests/workspace/demand-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/workspace/demand-ledger.ts tests/workspace/demand-scoping.test.ts
git commit -m "feat(workspace): record demand under scope local, and whether local filled the page

Skipping peer selection must not skip the ledger. It is the measurement the
demand-paged design is waiting on, and a scope that quietly stopped recording
would under-report cross-repo demand by exactly the queries most likely to have
wanted it.

localFilled is the quantity slot priority actually changes, and nothing measured
it before."
```

---

### Task 7: Re-baseline the cross-repo eval suites

**Files:**
- Modify: `tests/workspace/cross-repo-eval.test.ts`, `tests/workspace/cross-repo-archetypes.test.ts`, `tests/workspace/cross-repo-semantic.test.ts`, `tests/workspace/federated-abstention.test.ts`, `tests/workspace/federated-kin.test.ts` (all read `result.items`)
- Modify: `docs/evals/cross-repo-archetypes.json` only if a case's expectation is genuinely wrong under the new rule — not to make numbers move
- Create: `docs/evals/slot-priority-rebaseline.md`

**Interfaces:**
- Consumes: `flattenGroups` (Task 1)

- [ ] **Step 1: Switch every suite to the defined flattening**

Replace each `result.items` with `flattenGroups(result)`. This is the flattening the spec defines — local group first, then peers in group order — so MRR and R@3 keep meaning what they meant.

- [ ] **Step 2: Run the suites and record what moved**

Run: `npm.cmd test -- tests/workspace/`
Expected: some archetype cases fail. Capture the before/after MRR, R@3 and forbidden counts.

- [ ] **Step 3: Classify every moved case before changing a single expectation**

For each failure, decide which it is and write it down:
- **Gold was foreign and a local row now outranks it.** Correct under slot priority. Re-baseline.
- **Gold was local and is now missing.** A bug in Task 1. Fix the code, not the expectation.
- **A forbidden foreign row appears where it did not.** A bug. Fix the code.

Only the first class justifies changing a number.

- [ ] **Step 4: Write the re-baseline record**

Create `docs/evals/slot-priority-rebaseline.md` with the before/after table, the date, and one line per moved case naming which class it fell into. State explicitly that scoring output is byte-identical — `scoreCandidates` was not modified — so every delta is attributable to slot allocation alone. Without this, the shift reads later as a retrieval regression.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: PASS.

Run: `npm.cmd run typecheck`
Expected: the known 15-error baseline, no additions.

Run: `npm.cmd run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tests/workspace/ docs/evals/slot-priority-rebaseline.md
git commit -m "test(workspace): re-baseline the cross-repo suites for slot priority

The suites score one ranking, so they take the flattening the design defines:
local group first, then peers in group order. MRR and R@3 keep meaning what
they meant.

scoreCandidates was not modified, so scoring output is byte-identical and every
delta is attributable to slot allocation alone -- cases where a foreign row used
to outrank a local one. Recorded so the shift is not read later as a retrieval
fault."
```

---

### Task 8: Document the new scoping in KNOWL.md and the changelog

**Files:**
- Modify: `KNOWL.md` (the "Linked repositories" section)
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `README.md` if it documents `knowl_query`'s workspace behavior

- [ ] **Step 1: Update KNOWL.md**

The current text says a fact from another repo describes that repo and should not be applied without checking. That instruction now has a mechanism behind it. Replace with:

```markdown
- When this repo is in a workspace, `knowl_query` fills the page from this repo first. A response
  that is a bare JSON array is entirely this repo's. A response keyed by repo name means at least
  one row is **not** — and a fact from another repo describes **that** repo unless it says
  otherwise.
- An empty group under this repo's own name means this repo holds nothing on the subject. Read
  the other groups as background, not as an answer, and verify before applying.
- `scope: "local"` searches this repo alone; `scope: "workspace"` searches every sharing repo and
  always groups. `repos: ["<name>"]` restricts to named repos and wins if both are given.
- Knowledge stays private to its repo until someone runs `knowl workspace promote`. Only the
  owning repo can promote, update, or retire its own items.
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]`, `### Changed`:

```markdown
- `knowl_query` and `knowl query` now fill result slots from the local repo before any linked
  repo, and return results keyed by repo whenever a peer row wins a slot. A bare array means
  every row is local; an object means at least one is not. Previously local and peer results
  were fused into one ranking, so a query about something this repo had never touched returned
  another repo's answer in a shape indistinguishable from its own.
- New `scope` parameter on `knowl_query`: `local` searches this repo alone, `workspace` searches
  every sharing repo and always groups. `repos` wins if both are given.
- A linked repo that matched but won no slot is named with a count in a `WORKSPACE:` notice —
  names and counts only, never content — so shared knowledge stays findable.
- Ranking itself is unchanged. `scoreCandidates` still scores every repo's candidates as one
  union; only slot allocation and response shape changed.
```

- [ ] **Step 3: Run the docs check**

Run: `npm.cmd run docs:check`
Expected: PASS. If it fails, run `npm.cmd run docs:generate` and commit the result.

- [ ] **Step 4: Commit**

```bash
git add KNOWL.md CHANGELOG.md README.md
git commit -m "docs(workspace): document local-first query scoping and the scope parameter

KNOWL.md told agents a foreign fact describes a foreign repo. There is now a
mechanism behind that instruction, so the text says how to read it: a bare array
is entirely this repo's, and a keyed object means at least one row is not."
```

---

## Self-Review

**Spec coverage.** Behaviour table → Task 1. Scope selection table → Task 2. Explicit-scope-fixes-shape → Task 2 Step 3. Peer group order and local-always-first → Task 1 Step 3. Pointer block in both shapes → Task 4 (the `unshown` block is not conditioned on shape). Single union pass preserved → Task 1 Step 3 and the Global Constraints. Abstention stays global, reporting names repos → no code change needed; the existing `NO CONFIDENT MATCH` block already reads the per-item set through `resolvedItems`, which Task 4 keeps populated. `boundQueryPayload` → Task 3. `repo` dropped in groups, foreign stripping retained → Task 4. CLI → Task 5. Demand ledger and the `scope: 'local'` undercount → Task 6. Eval re-baseline → Task 7. Docs → Task 8.

**Type consistency.** `FederatedResult` is `{ groups, unshown, shape, skipped }` in Tasks 1, 4, 5 and 6. `FederatedGroup` is `{ repo, items }` throughout; `boundQueryPayload` takes `{ repo, rows }` because rows are compacted response objects rather than `FederatedItem`s — deliberate, and the two are never interchanged. `flattenGroups` takes a `FederatedResult` and is used in Tasks 4, 5 and 7 with that signature.

**One gap, stated rather than hidden.** Task 4's `LOCAL MISS` block fires on `federated.groups[0].items.length === 0`, which is "local returned no rows," not "local returned nothing useful." A weak local row suppresses the notice — and by design, since no threshold can tell those apart. The grouped shape still fires whenever a peer wins a slot, so attribution is never lost; only the sentence explaining it is. This is the accepted cost the spec records under "Local's weak row can sit above better peer rows."
