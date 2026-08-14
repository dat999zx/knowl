# Foreign Atom Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `knowl_query { id }` naming an atom owned by a linked repo returns that atom whole — instead of the current dead-end refusal — with the fields that can only be resolved against the owning repo's checkout omitted rather than answered wrongly.

**Architecture:** The refusal at `src/mcp/tools.ts:688` is a *not-found*, not an ownership guard: `getKnowledgeItem` reads the local store, so a sibling's id is simply absent. `ownerFromPeers` in `src/workspace/ownership.ts` already walks every present peer read-only asking whether it holds an id. This plan widens that one walk to carry the row it finds, and lets the id-fetch fall through to it on a local miss. No guard is removed, no write path is touched, and the peer walk stays single — the drift `store-handle.ts` warns about (federated-query re-implementing selection and diverging) is avoided by extending the existing function rather than adding a second.

**Tech Stack:** TypeScript, libsql/Drizzle, vitest, MCP tool surface.

**Spec:** `docs/research/local-workspace-cross-repo-writes.md` §5-C (in the `knowl-cloud` repo), as corrected by the verification recorded in knowl atom `10ffe70d318a40e9` — specifically that the refusal is a not-found rather than an enforcement site, which is what makes this change small.

**Base:** `upstream/main` @ `006b4eb` (5.2.1). Branch `feat/foreign-atom-read`.

## Global Constraints

- **No write path is touched.** Peer stores are opened read-only (`openPeerStore` sets `query_only = ON`); this change adds no statement that writes anywhere.
- **No guard is weakened.** `assertOwnedItem` and its refusals are unchanged in behaviour. Foreign *reads* become possible; foreign *writes* remain refused exactly as today.
- **Never answer a checkout-relative question about a foreign atom.** `affectedPaths` and evidence staleness resolve against a working tree this process is not standing in. Omit them and say so — never compute them locally, never emit `stale: false` as a default.
- **The ordinary local fetch pays nothing.** Workspace resolution happens only after a local miss, mirroring `assertOwnedTargets`' existing "skipped entirely when no retire is requested" property.
- **A peer that cannot be read is not a peer that said no** (`UnverifiedOwnerError`'s reason for existing). Unreadable peers must not silently become "no such item".
- Lint, typecheck, build and the full suite green before the PR. `docs:check` current.
- Work ends at an **open PR** against `dat999zx/knowl`. Never self-merge.

---

## File Structure

- **Modify:** `src/workspace/ownership.ts` — widen the peer walk to carry the found row; export `findForeignItem`.
- **Modify:** `src/store/evidence-repository.ts` — `listEvidenceForItem` gains an optional client, mirroring `getKnowledgeItem(id, dbConnection?)`.
- **Modify:** `src/mcp/tools.ts` — id-fetch falls through to the peer walk on a local miss.
- **Modify:** `src/mcp/tool-definitions.ts` — the `id` parameter description states that a linked repo's id now resolves.
- **Test:** `tests/workspace/foreign-item-read.test.ts` (create), `tests/mcp/foreign-item-fetch.test.ts` (create).

---

## Tasks

### Task 1: Widen the peer walk to carry the row

**Files:**
- Modify: `src/workspace/ownership.ts:38-69` (`ownerFromPeers`), `:85` (`assertOne` call site)
- Test: `tests/workspace/foreign-item-read.test.ts` (create)

**Interfaces:**
- Produces: `export async function findForeignItem(itemId: string, workspace: ActiveWorkspace | null): Promise<{ repo: string; item: KnowledgeItem } | null>` — null when no workspace, when no present peer holds it, or when every peer that might have is unreadable. Consumed by Task 2.
- Internal: `PeerVerdict` gains `item: KnowledgeItem | null`.

- [ ] **Step 1: Write the failing test**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { findForeignItem } from '../../src/workspace/ownership.js';
import type { ActiveWorkspace } from '../../src/workspace/resolve.js';

const ROOT = path.resolve('.knowl-foreign-read');
const PEER = path.join(ROOT, 'peer');
const SELF = path.join(ROOT, 'self');

// A workspace whose only peer is the store we built at PEER. `manifest.repos` lists both so
// the no-path branch of the walk is exercised too.
function workspaceWith(peerPresent: boolean, peerDbPath: string): ActiveWorkspace {
  return {
    name: 'sandbox',
    repo: 'self',
    manifest: { version: 1, repos: [{ name: 'self', path: SELF }, { name: 'peer', path: PEER }] } as never,
    peers: [{ name: 'peer', root: PEER, databasePath: peerDbPath, present: peerPresent }],
    cloud: null,
  } as ActiveWorkspace;
}

let peerItemId = '';
let peerDbPath = '';

describe('findForeignItem', () => {
  beforeAll(async () => {
    await closeDb(); await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PEER, '.knowl'), { recursive: true });
    await fs.mkdir(path.join(SELF, '.knowl'), { recursive: true });

    await initDb(PEER);
    const peerProject = (await repo.createProject(PEER, 'peer')).id;
    const item = await repo.createKnowledgeItem(peerProject, {
      category: 'fact',
      title: 'Peer owned fact',
      content: 'The body of a fact that lives in the peer repo.',
      affectedPaths: ['src/peer-only.ts'],
    });
    peerItemId = item.id;
    peerDbPath = path.join(PEER, '.knowl', 'knowl.db');
    await closeDb();

    await initDb(SELF);
  });

  afterAll(async () => {
    await closeDb(); await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the owning repo and the whole row', async () => {
    const found = await findForeignItem(peerItemId, workspaceWith(true, peerDbPath));
    expect(found?.repo).toBe('peer');
    expect(found?.item.title).toBe('Peer owned fact');
    expect(found?.item.content).toContain('lives in the peer repo');
  });

  it('returns null outside a workspace', async () => {
    expect(await findForeignItem(peerItemId, null)).toBeNull();
  });

  it('returns null for an id no peer holds', async () => {
    expect(await findForeignItem('no-such-item-000', workspaceWith(true, peerDbPath))).toBeNull();
  });

  it('returns null rather than throwing when the only peer is not present', async () => {
    expect(await findForeignItem(peerItemId, workspaceWith(false, peerDbPath))).toBeNull();
  });

  it('returns null rather than throwing when the peer database is missing', async () => {
    const missing = path.join(PEER, '.knowl', 'does-not-exist.db');
    expect(await findForeignItem(peerItemId, workspaceWith(true, missing))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace/foreign-item-read.test.ts`
Expected: FAIL — `findForeignItem` is not exported from `ownership.ts`.

- [ ] **Step 3: Widen the walk and export the finder**

In `src/workspace/ownership.ts`, add `KnowledgeItem` to the imports from `../store/repository.js`, add `openPeerStore` from `../store/store-handle.js`, extend `PeerVerdict`, and replace the peer probe. The `SELECT 1` becomes a full read through the same mapper the local path uses, so a row this build cannot parse counts as a gap rather than as a hit:

```ts
type PeerVerdict = {
  /** The peer that holds the item, when one positively does. */
  owner: string | null;
  /**
   * The row that peer holds. Read on the same probe that establishes ownership, because a
   * second lookup would be a second walk -- the divergence `store-handle.ts` documents.
   */
  item: KnowledgeItem | null;
  /** Peers that could not answer at all. Empty means every peer was asked and said no. */
  unverified: string[];
};
```

and inside the peer loop:

```ts
    try {
      // The full row, through the same mapper the local path uses. `SELECT 1` answered the
      // ownership question and nothing else, so every caller that also wanted the item had to
      // walk again. A row this build cannot map throws here and is caught below as a gap,
      // which is the honest verdict for "written by a newer Knowl".
      const store = await openPeerStore(peer.databasePath);
      const item = await getKnowledgeItem(itemId, store.db);
      if (item) return { owner: peer.name, item, unverified };
    } catch (error) {
```

Return `{ owner: null, item: null, unverified }` at the end, and in `assertOne` destructure `const { owner, unverified } = ...` unchanged (the added field is ignored there — `assertOne` asks only who owns it).

Then append the new export:

```ts
/**
 * The whole row for an id a linked repo owns, for reading only.
 *
 * The id-fetch refusal this serves was a *not-found*, not a guard: `getKnowledgeItem` reads the
 * local store, so a sibling's id was simply absent and the message explained the absence in
 * ownership terms. Withholding the record was never the protection -- the protection is that
 * `affectedPaths` and evidence staleness resolve against the owning repo's checkout, and the
 * caller strips those. `assertOwnedItem` is untouched: this widens reading, not writing.
 *
 * Null covers three different situations on purpose -- no workspace, no peer holds it, and every
 * peer that might have is unreadable -- because the caller's own not-found path already words
 * all three correctly, and an unreadable peer must not become "no such item" anywhere else.
 */
export async function findForeignItem(
  itemId: string,
  workspace: ActiveWorkspace | null,
): Promise<{ repo: string; item: KnowledgeItem } | null> {
  if (!workspace) return null;
  const { owner, item } = await ownerFromPeers(itemId, workspace);
  return owner && item ? { repo: owner, item } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace/foreign-item-read.test.ts` — expect PASS.
Then: `npx vitest run tests/mcp/foreign-item-refusal.test.ts` — the existing refusal suite must still pass unchanged, proving `assertOne` is behaviourally identical.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/ownership.ts tests/workspace/foreign-item-read.test.ts
git commit -m "feat(workspace): carry the found row on the peer ownership walk"
```

### Task 2: Evidence reads accept a peer connection

**Files:**
- Modify: `src/store/evidence-repository.ts:107-113`
- Test: covered by Task 3's foreign-fetch suite (this task has no independent user-visible behaviour; it is the seam Task 3 needs)

**Interfaces:**
- Produces: `listEvidenceForItem(itemId: string, client?: Client): Promise<Array<Evidence & { relationship: EvidenceRelationship }>>` — same shape, optional connection, defaulting to `getClient()`.

- [ ] **Step 1: Change the signature**

```ts
export async function listEvidenceForItem(
  itemId: string,
  // Optional connection, mirroring `getKnowledgeItem(id, dbConnection?)`. Without it, a foreign
  // atom's citations were read from the LOCAL store and came back empty -- reporting "no
  // citations" for an atom that has them, which is the failure shape the cloud sync contract
  // records (fields the wire silently dropped, "with nothing red anywhere").
  client?: Client,
): Promise<Array<Evidence & { relationship: EvidenceRelationship }>> {
  const result = await (client ?? getClient()).execute({
```

with `import type { Client } from '@libsql/client';` added.

- [ ] **Step 2: Verify nothing regressed**

Run: `npx vitest run tests/store/` and `npm run typecheck`
Expected: PASS — every existing caller omits the parameter and is unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/store/evidence-repository.ts
git commit -m "refactor(store): let evidence reads target a given connection"
```

### Task 3: The id-fetch falls through to linked repos

**Files:**
- Modify: `src/mcp/tools.ts:680-691` (the `if (id)` branch's not-found path)
- Modify: `src/mcp/tool-definitions.ts` (the `id` parameter description)
- Test: `tests/mcp/foreign-item-fetch.test.ts` (create)

**Interfaces:**
- Consumes: `findForeignItem` (Task 1), `listEvidenceForItem(itemId, client)` (Task 2), `openPeerStore`, `resolveWorkspace`.
- Produces: a foreign fetch payload — the same `full` shape, minus `affectedPaths`, plus a `foreign: { repo: string; note: string }` block. Evidence, when requested, carries no `stale` field.

- [ ] **Step 1: Write the failing test.** Two stores as in Task 1, wired through the MCP server with a workspace config so `resolveWorkspace` sees the peer. Assertions:
  - fetching the peer's id returns the whole item (title, content, reasoning) and `foreign.repo === 'peer'`
  - the payload has **no** `affectedPaths` key, even though the peer row has one
  - `foreign.note` names the owning repo and says why the omitted fields are omitted
  - with `includeEvidence: true`, the peer's citations come back, and **no** entry carries a `stale` key
  - an id no peer holds still returns `isError` with the existing `No knowledge item` text (regression pin on the miss path)
  - outside a workspace, an unknown id returns the same refusal (no workspace resolution crash)

- [ ] **Step 2: Run** `npx vitest run tests/mcp/foreign-item-fetch.test.ts` — expect FAIL.

- [ ] **Step 3: Implement the fall-through.** Replace the `if (!item) { return { isError: true, ... } }` block:

```ts
          if (!item) {
            // Resolved only on a miss, so an ordinary local fetch pays nothing for the
            // workspace lookup -- the property `assertOwnedTargets` keeps for writes.
            const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
            const foreign = await findForeignItem(String(id), active);
            if (foreign) {
              const peer = active!.peers.find(entry => entry.name === foreign.repo)!;
              const store = await openPeerStore(peer.databasePath);
              const item = foreign.item;
              const full = {
                id: item.id,
                category: item.category,
                title: item.title,
                content: item.content,
                ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                ...(item.alternatives?.length ? { alternatives: item.alternatives } : {}),
                status: item.status,
                freshness: item.freshness,
                confidence: item.confidence,
                ...(item.provenance ? { provenance: item.provenance } : {}),
                ...(item.tags?.length ? { tags: item.tags } : {}),
                ...(item.source ? { source: item.source } : {}),
                ...(item.sourceCommit ? { sourceCommit: item.sourceCommit } : {}),
                // `affectedPaths` is deliberately absent: it names files in the OWNING repo's
                // checkout, and this process is standing somewhere else. The old refusal cited
                // exactly this -- correctly about the paths, and over-broadly about the record.
                ...(item.conflictKey ? { conflictKey: item.conflictKey } : {}),
                ...(item.supersededById ? { supersededById: item.supersededById } : {}),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                foreign: {
                  repo: foreign.repo,
                  note: `Read from linked repo "${foreign.repo}". affectedPaths and evidence staleness are omitted because they resolve against that repo's checkout, not this one. Only "${foreign.repo}" can update or retire this item.`,
                },
              };
              // Staleness is NOT computed: `isEvidenceStale` measures against this repo's
              // working tree, and answering with it would be the wrong-checkout mistake in a
              // field nobody would think to doubt. Absent means unavailable here, not fresh.
              const payload = includeEvidence
                ? [{ ...full, evidence: boundedEvidence(await listEvidenceForItem(item.id, store.client)) }]
                : [full];
              return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] };
            }
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `No knowledge item "${id}" in this repo's store, and no linked repo here holds it either. Check the id -- ids must be given in full, since a truncated one matches nothing.`,
              }],
            };
          }
```

Update the `id` parameter description in `src/mcp/tool-definitions.ts` to state that an id owned by a linked repo now resolves and comes back without checkout-relative fields — descriptions are the contract the model reads, and an undescribed capability is one it never uses.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mcp/foreign-item-fetch.test.ts tests/mcp/query-fetch-by-id.test.ts tests/mcp/foreign-item-refusal.test.ts`
Expected: PASS. Then the full suite: `npm test`, plus `npm run lint`, `npm run typecheck`, `npm run build`, `npm run docs:check`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tool-definitions.ts tests/mcp/foreign-item-fetch.test.ts
git commit -m "feat(mcp): resolve a linked repo's atom by id, without its checkout-relative fields"
```

### Task 4: Open the PR

- [ ] Add a CHANGELOG entry.
- [ ] Push the branch to `origin` (the fork) and open a PR against `dat999zx/knowl` `main`. Body states: the refusal was a not-found rather than a guard; no guard was weakened; `affectedPaths` and evidence staleness are omitted rather than answered; the peer walk stayed single.
- [ ] **Stop.** Do not merge.

---

## Self-review

- **Spec coverage:** §5-C asks for `id:`-fetch of a sibling atom with paths stripped, and for the refusal's stated reason to be honoured by sanitising rather than withholding. Task 3 does both, and extends the same reasoning to evidence staleness, which §5-C did not consider but which fails identically.
- **Placeholder scan:** none — every step carries its code or its exact command.
- **Type consistency:** `findForeignItem` returns `{ repo, item }` in Task 1 and is destructured as `foreign.repo` / `foreign.item` in Task 3. `listEvidenceForItem(itemId, client)` in Task 2 is called with `store.client` in Task 3, matching `StoreHandle.client: Client`.
- **Known follow-on:** the miss-path message changes wording (it can no longer claim the item might be in a linked repo, having just looked). `tests/mcp/query-fetch-by-id.test.ts:93` matches `/No knowledge item/i`, which the new text still satisfies.
