# Local Memory Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `knowl view` the surface where a person reads, triages, edits and adds their own memory — and stop the extractor minting information-free atoms.

**Architecture:** The local viewer is a 195-line Node HTTP server (`src/viewer/server.ts`) serving a single hand-written HTML/JS page (`src/viewer/ui.ts`). It is currently GET-only. This plan replaces its blanket non-GET refusal with a per-route method allowlist, adds three write routes over store functions that already exist, and adds a list view with an Unread lens beside the existing graph. The CLI gains `knowl list` (browse) and `knowl edit <id>` (start the viewer, print a deep link) — no terminal editing UI.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:http`, Drizzle + libSQL/SQLite, Vitest. The viewer page is hand-written ES5-style JS in a template literal — **no framework, no build step, no dependencies**. `@clack/prompts` + `picocolors` for any CLI prompt or colour.

**Spec:** `../../../knowl-cloud/docs/superpowers/specs/2026-08-19-human-memory-management-design.md` (in the sibling `knowl-cloud` repo, branch `feat/human-memory-management`, commit `01817aa`). Read §7, §9, §10, §12 before starting.

**Scope note:** This plan is the `knowl` half only — spec stages 1, 2 and 6. The cloud web app (`knowl-cloud`), the New / Needs-attention lenses, and bulk operations are a separate plan and are deliberately absent here.

## Global Constraints

- **Never `process.cwd()` in a test fixture.** Use `path.resolve('./.knowl-<name>-test')` or `fs.mkdtemp`. Vitest runs files in parallel workers sharing process-level database state; a fixture aimed at the real store makes a *different* suite fail. (`tests/cloud/publish-stage.test.ts` was the casualty.)
- **Nothing in `src/cli/program.ts` can be unit tested** — it calls `program.parse(process.argv)` at module scope, so importing it runs the CLI. Every piece of testable CLI logic goes in a sibling module that `program.ts` imports. `src/cli/windows-spawn.ts` and `src/cli/status-report.ts` are the worked examples.
- **Render UI output and read it.** A green suite proves the objects are right and says nothing about what a person sees. Every task touching `src/viewer/ui.ts` ends with the viewer actually opened in a browser.
- **Do not write `written_by`.** It means *cross-repo* authorship — `src/store/schema.ts:38`: "NULL means the owner wrote it, which is the ordinary case". The human-authored signal is `provenance: 'user_stated'`.
- **Import specifiers end in `.js`** even for `.ts` sources. ESM, `"type": "module"`.
- **Tests mirror sources:** `src/viewer/server.ts` → `tests/viewer/server.test.ts`.
- **Run the suite with `npm test`** (`vitest run`). A single file: `npx vitest run tests/path/file.test.ts`.
- **No new dependencies.** Everything here is stdlib plus what is already installed.

---

### Task 1: Stop the extractor minting information-free atoms

Spec §10. Independent of every other task — it can ship alone.

`extractSessionMemoryCandidates` mints an atom from every `git commit` in the session's captured commands. When the commit has no body, the atom's content equals its title and it carries zero information beyond it. That is all 48 of the bare atoms measured in the spec. Commits *with* bodies are kept — 161 of 226 carry full explanatory bodies and rank well in live retrieval.

`parseCommitSubjects` already returns `body: string | null`, and the `git commit -m "subject"` form always yields `body: null` (`src/store/extractors/commit-subject.ts:40`), so the filter is one condition.

**Files:**
- Modify: `src/store/session-candidates.ts:59-75`
- Test: `tests/store/session-candidates.test.ts`

**Interfaces:**
- Consumes: `parseCommitSubjects(command: string): CommitSubject[]` where `CommitSubject = { type: string | null; subject: string; body: string | null }`
- Produces: nothing new. `extractSessionMemoryCandidates(sessionId: string): Promise<MemoryCandidate[]>` keeps its signature; only which candidates it returns changes.

- [ ] **Step 1: Write the failing test**

Add to `tests/store/session-candidates.test.ts`, inside the existing `describe('session candidates', ...)`:

```typescript
  it('keeps a commit that explains itself and drops one that only names itself', async () => {
    const session = await startMemorySession({ title: 'Two commits', query: 'commits' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git commit -m "feat: rename the cache key"',
      exitCode: 0,
      summary: 'committed',
    });
    await appendMemorySessionEvent(session.id, 'command', {
      command: [
        "git commit -F - <<'EOF'",
        'feat: pin the embedding dimension at write time',
        '',
        'A vector whose width disagrees with the column ranks as noise forever,',
        'so the width is asserted when the row is written rather than when it is read.',
        'EOF',
      ].join('\n'),
      exitCode: 0,
      summary: 'committed',
    });
    await finishMemorySession(session.id, 'finished', 'Two commits.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    const commits = candidates.filter(candidate => candidate.candidateType === 'commit');

    expect(commits).toHaveLength(1);
    expect(commits[0].title).toBe('feat: pin the embedding dimension at write time');
    expect(commits[0].content).toContain('ranks as noise forever');
    // The dropped one must not survive under any title.
    expect(candidates.some(candidate => candidate.title.includes('rename the cache key'))).toBe(false);
  });

  it('does not mint an atom whose content says no more than its title', async () => {
    const session = await startMemorySession({ title: 'Bare only', query: 'commits' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git commit -m "fix: off-by-one in the pager"',
      exitCode: 0,
      summary: 'committed',
    });
    await finishMemorySession(session.id, 'finished', 'One bare commit.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates.filter(candidate => candidate.candidateType === 'commit')).toHaveLength(0);
    expect(candidates.every(candidate => candidate.content !== candidate.title)).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/session-candidates.test.ts -t 'commit'`

Expected: FAIL. The first case gets 2 commit candidates instead of 1; the second gets 1 instead of 0.

- [ ] **Step 3: Write the minimal implementation**

In `src/store/session-candidates.ts`, in the `for (const commit of parseCommitSubjects(command))` loop, add the third guard and simplify the now-unconditional content join:

```typescript
    for (const commit of parseCommitSubjects(command)) {
      if (commit.type && SKIPPED_COMMIT_TYPES.has(commit.type)) continue;
      if (/^merge\b/i.test(commit.subject)) continue;
      // A commit with no body yields an atom whose content is its title: it consumes a
      // retrieval slot and repeats what the slot already showed. The subject alone is still
      // in the git log, which is where "what changed" belongs. Measured 2026-08-19: 48 of the
      // 226 commit-derived atoms in knowl-cloud's store were this, and every one of the 161
      // with a body was worth keeping.
      if (!commit.body) continue;
      const content = `${commit.subject}\n\n${commit.body}`.slice(0, MAX_CONTENT_CHARS);
      candidates.push({
        candidateType: 'commit',
        sessionId,
        category: commit.type === 'fix' ? 'fact' : 'architecture',
        title: commit.subject.slice(0, 120),
        content,
        confidence: 0.8,
        evidence: eventEvidence(sessionId, event),
      });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/store/session-candidates.test.ts`

Expected: PASS, including the pre-existing cases. If `derives durable decisions, not successful command noise` breaks, you changed more than the guard.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS. `tests/store/candidate-promotion.test.ts` exercises the same pipeline; check it did not depend on a body-less commit as a fixture.

- [ ] **Step 6: Commit**

```bash
git add src/store/session-candidates.ts tests/store/session-candidates.test.ts
git commit -m "fix(memory): a commit with no body is not knowledge

The session finalizer minted an atom from every git commit it found in the
captured commands. With no body the atom's content is its title, so it
consumes a retrieval slot to repeat what the slot already showed.

Measured against knowl-cloud's store on 2026-08-19: 226 of 656 active atoms
came from commits, 161 of them carrying full explanatory bodies that rank
well in live retrieval, and 48 carrying nothing at all. The extractor stays;
only the empty ones stop.

The subject alone still exists in the git log, which is where 'what changed'
belongs."
```

---

### Task 2: Let the viewer accept writes, safely

Spec §9. Server only — no UI in this task, so it is reviewable on its own.

`src/viewer/server.ts:128` returns 405 to every non-GET before anything else runs. Replace that with a per-route method allowlist so unmatched routes still 405, and add three write routes over store functions that already exist.

**The existing security posture is what makes writes safe. Preserve it exactly:** the loopback-literal Host check, the fresh per-launch token, `HttpOnly; SameSite=Strict` on the cookie, and CSP `form-action 'none'`. `SameSite=Strict` is the CSRF defence — a cross-site page's `fetch` will not carry the cookie. Both checks must now run for writes too, which means the method gate moves *after* them.

**Files:**
- Modify: `src/viewer/server.ts` (remove the blanket 405 at :128; add `readJson`, `pickEditable`, and three routes)
- Test: `tests/viewer/server.test.ts`

**Interfaces:**
- Consumes, all from `src/store/repository.js`:
  - `createKnowledgeItem(projectId: string, item: { category: KnowledgeCategory; title: string; content: string; reasoning?: string | null; tags?: string[] | null; confidence?: number; provenance?: KnowledgeProvenance | null; ... }): Promise<KnowledgeItem>` — `projectId` is the literal `'local'`
  - `updateKnowledgeItem(id: string, updates: Partial<Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>>): Promise<KnowledgeItem>`
  - `getKnowledgeItem(id: string): Promise<KnowledgeItem | null>`
- Produces, for Task 4's UI:
  - `POST /api/atoms` → `201 { item: KnowledgeItem }`
  - `PATCH /api/atoms/:id` → `200 { item: KnowledgeItem }`
  - `POST /api/atoms/:id/archive` → `200 { item: KnowledgeItem }`
  - Errors are `{ error: string }` with 400 (malformed / unknown field), 404 (no such atom), 405 (method not allowed on that path), 413 (body too large).

- [ ] **Step 1: Write the failing tests**

Add a new file `tests/viewer/write.test.ts`. It is separate from `server.test.ts` because that suite's fixture atom asserts the viewer is read-only, and these cases are about the opposite:

```typescript
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, getKnowledgeItem } from '../../src/store/repository.js';

/**
 * `fetch` refuses to set `Host` -- it is on the WHATWG forbidden-header list. A raw
 * `http.request` is the only way to send one that disagrees with the socket it reaches.
 */
function requestWithHost(url: string, host: string, method: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname, port: target.port,
        path: `${target.pathname}${target.search}`, method,
        headers: { host, 'content-type': 'application/json' },
      },
      response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode ?? 0 })); },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

const ROOT = path.resolve('./.knowl-viewer-write-test');
let running: any;
let atomId = '';

describe('viewer writes', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Original title', content: 'Original content.',
    });
    atomId = item.id;
    const viewer = await import('../../src/viewer/server.js') as any;
    running = await viewer.startViewer(ROOT, { port: 0 });
  });
  afterAll(async () => {
    await running?.close();
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const url = (p: string) => `${running.url}${p}?token=${running.token}`;
  const send = (p: string, method: string, body?: unknown) => fetch(url(p), {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('edits an atom and marks it as the human speaking', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', {
      title: 'Corrected title', content: 'Corrected content.',
    });
    expect(response.status).toBe(200);

    const stored = await getKnowledgeItem(atomId);
    expect(stored?.title).toBe('Corrected title');
    expect(stored?.content).toBe('Corrected content.');
    expect(stored?.provenance).toBe('user_stated');
  });

  it('leaves written_by alone, because it means cross-repo authorship', async () => {
    await send(`/api/atoms/${atomId}`, 'PATCH', { title: 'Another correction' });
    const stored = await getKnowledgeItem(atomId);
    expect(stored?.writtenBy ?? null).toBeNull();
  });

  it('creates an atom', async () => {
    const response = await send('/api/atoms', 'POST', {
      category: 'constraint', title: 'Written by hand', content: 'A person typed this.',
    });
    expect(response.status).toBe(201);
    const created = (await response.json()).item;
    const stored = await getKnowledgeItem(created.id);
    expect(stored?.title).toBe('Written by hand');
    expect(stored?.provenance).toBe('user_stated');
  });

  it('archives rather than destroys', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Doomed', content: 'To be archived.',
    });
    const response = await send(`/api/atoms/${item.id}/archive`, 'POST');
    expect(response.status).toBe(200);
    const stored = await getKnowledgeItem(item.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('archived');
  });

  it('refuses a field that is not editable', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', { id: 'hijacked', status: 'active' });
    expect(response.status).toBe(400);
  });

  it('404s an atom that does not exist', async () => {
    const response = await send('/api/atoms/nope-not-here', 'PATCH', { title: 'x' });
    expect(response.status).toBe(404);
  });

  it('405s a method the route does not serve, and still 405s an unknown path', async () => {
    expect((await send('/api/graph', 'PATCH', {})).status).toBe(405);
    expect((await send('/api/atoms', 'DELETE')).status).toBe(405);
    expect((await send('/api/nothing-here', 'POST', {})).status).toBe(405);
  });

  it('refuses a write with no token, exactly as it refuses a read', async () => {
    const response = await fetch(`${running.url}/api/atoms/${atomId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no token' }),
    });
    expect(response.status).toBe(401);
    expect((await getKnowledgeItem(atomId))?.title).not.toBe('no token');
  });

  it('refuses a write whose Host header is not a loopback literal', async () => {
    const target = new URL(url(`/api/atoms/${atomId}`));
    const response = await requestWithHost(target.toString(), 'knowl.example.com', 'PATCH');
    expect(response.status).toBe(400);
  });

  it('refuses a body larger than the cap', async () => {
    const response = await send(`/api/atoms/${atomId}`, 'PATCH', { content: 'x'.repeat(70_000) });
    expect(response.status).toBe(413);
  });

  it('still issues the cookie HttpOnly and SameSite=Strict', async () => {
    const page = await fetch(url('/'));
    const cookie = page.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/viewer/write.test.ts`

Expected: FAIL. Every write case returns 405 from the blanket method gate.

- [ ] **Step 3: Add the body reader and the field whitelist**

In `src/viewer/server.ts`, above `startViewer`:

```typescript
/** A local editor sends a form, not a file. 64 KB is far past the 7,305-char longest atom. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * What a person may change. `id`, `status`, `version`, `origin_repo` and `written_by` are
 * absent deliberately: an atom keeps its identity, its lineage and its authorship across every
 * revision, and archiving has its own route so it cannot happen by mistyping a field name.
 *
 * Unknown keys are refused rather than dropped. A silently ignored field looks exactly like a
 * successful edit to whoever sent it.
 */
const EDITABLE = new Set(['title', 'content', 'reasoning', 'tags', 'category', 'confidence']);

function pickEditable(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') throw new TypeError('Body must be an object.');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!EDITABLE.has(key)) throw new TypeError(`Not editable: ${key}`);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw new TypeError('Nothing to change.');
  // The human said so. This is what makes "show me what I wrote" possible, and it is this
  // field's defined meaning -- unlike `written_by`, which marks a foreign origin repo.
  patch.provenance = 'user_stated';
  return patch;
}
```

Add these imports at the top of the file, beside the existing `src/store/repository.js` import:

```typescript
import { createKnowledgeItem, getKnowledgeItem, updateKnowledgeItem, listKnowledgeItems } from '../store/repository.js';
```

(`listKnowledgeItems` is already imported — merge, do not duplicate the import.)

- [ ] **Step 4: Move the method gate and add the routes**

Delete this line entirely (`src/viewer/server.ts:128`):

```typescript
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', ...SECURITY_HEADERS }); response.end(); return; }
```

The Host check and the token check now run for every method, which is the point.

**Order matters here, and getting it wrong is silent.** The existing GET routes match on
`pathname` alone and never look at `request.method` — `if (pathname === '/api/graph') return json(…)`
would happily answer a `PATCH`. So the write routes go **first**, immediately after
`const pathname = url.pathname;` and **before** `if (pathname === '/api/graph')`, with the method
gate between them. Insert this block there:

```typescript
    // ---- writes ----
    // Reached only after the Host check and the token check above, which is why deleting the
    // blanket method gate is safe: it used to run first and now nothing runs before them.
    //
    // These sit ABOVE the GET routes because those match on pathname alone and never inspect
    // the method -- reaching them with a PATCH would answer 200 instead of refusing.
    if (request.method === 'POST' && pathname === '/api/atoms') {
      let created;
      try {
        const body = await readJson(request) as any;
        if (!body?.category || !body?.title || !body?.content) {
          return json(response, { error: 'category, title and content are required.' }, 400);
        }
        created = await createKnowledgeItem('local', { ...body, provenance: 'user_stated' });
      } catch (error) {
        if (error instanceof BodyTooLarge) return json(response, { error: 'Body too large.' }, 413);
        return json(response, { error: 'Malformed request.' }, 400);
      }
      return json(response, { item: created }, 201);
    }

    if (pathname.startsWith('/api/atoms/')) {
      const rest = segment(pathname, '/api/atoms/');
      const archiving = rest.endsWith('/archive');
      const id = archiving ? rest.slice(0, -'/archive'.length) : rest;

      if (request.method === 'POST' && archiving) {
        if (!(await getKnowledgeItem(id))) return json(response, { error: 'No such atom.' }, 404);
        // Archived, not deleted. Reversible, and the one destructive act here that a misclick
        // can reach. Permanent removal stays with `knowl forget`, which asks first.
        return json(response, { item: await updateKnowledgeItem(id, { status: 'archived' }) });
      }

      if (request.method === 'PATCH' && !archiving) {
        let patch: Record<string, unknown>;
        try {
          patch = pickEditable(await readJson(request));
        } catch (error) {
          if (error instanceof BodyTooLarge) return json(response, { error: 'Body too large.' }, 413);
          return json(response, { error: (error as Error).message }, 400);
        }
        if (!(await getKnowledgeItem(id))) return json(response, { error: 'No such atom.' }, 404);
        return json(response, { item: await updateKnowledgeItem(id, patch as any) });
      }
    }

    // Everything below this line is a GET route that does not check its own method.
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', ...SECURITY_HEADERS });
      response.end();
      return;
    }
```

So the final order inside `route()` is: Host check → token check → `pathname` → **write routes** →
**method gate** → existing GET routes → 404. The `405` case in the test suite is what pins it; if
you place the writes after the GET routes instead, `PATCH /api/graph` returns a graph and that test
goes red.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/viewer/write.test.ts tests/viewer/server.test.ts`

Expected: PASS, both files. `server.test.ts` must still pass unchanged — its read-only assertions are about GET routes and none of them moved.

- [ ] **Step 6: Prove the CSRF guard can fail**

A guard nobody has watched go red is not a guard. Temporarily change `SameSite=Strict` to `SameSite=Lax` in `src/viewer/server.ts:163`, run `npx vitest run tests/viewer/write.test.ts`, and confirm the cookie test **fails**. Restore `Strict` and confirm it passes again. Do not commit the temporary change.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add src/viewer/server.ts tests/viewer/write.test.ts
git commit -m "feat(viewer): the local viewer accepts writes

A person could see every memory here and change none of them. The four store
verbs already existed; the viewer refused every non-GET before anything else
ran, so nothing could reach them.

The blanket gate becomes a per-route allowlist and the method check moves
BELOW the Host and token checks -- which is the load-bearing half. It used to
run first, so a write now passes the same two gates a read always did.

Nothing about the security posture changes, and that is deliberate: the
SameSite=Strict cookie is what stops a page the user is already viewing from
posting here, the loopback-literal Host check is what stops a name that merely
resolves to 127.0.0.1, and both are now pinned by tests. The SameSite test was
watched go red on SameSite=Lax before being kept.

Editable fields are a whitelist and an unknown key is a 400, not a silent
drop: an ignored field looks exactly like a successful edit to whoever sent
it. Every human write stamps provenance=user_stated, which is that field's
defined meaning. written_by is left alone -- it marks a foreign origin repo,
not a human."
```

---

### Task 3: A list beside the graph, and the Unread lens

Spec §5, §6. Read-only UI — reviewable without any of Task 4's forms.

The viewer's only navigation is a force-directed canvas. 656 atoms averaging ~2 KB cannot be found that way. Add a list view, and one lens that finds problems the user cannot name: **never retrieved**.

`getAccessSummary()` returns a `Map<itemId, { retrievalCount, lastRetrievedAt }>` built from `knowledge_access` — atoms **absent from the map have zero reads**, which is the whole lens. Do not use `getKnowledgeAccessReport()`: it INNER JOINs `knowledge_access`, so never-read atoms are exactly the rows it drops.

**Files:**
- Modify: `src/viewer/server.ts` (add `GET /api/reads`)
- Modify: `src/viewer/ui.ts` (view toggle, table, lens tabs, filters)
- Test: `tests/viewer/write.test.ts` (one case for the new route)

**Interfaces:**
- Consumes: `getAccessSummary(): Promise<Map<string, { retrievalCount: number; lastRetrievedAt: string }>>` from `src/store/access-feedback.js`; `POST /api/atoms`, `PATCH /api/atoms/:id`, `POST /api/atoms/:id/archive` from Task 2 (used in Task 4, not here).
- Produces: `GET /api/reads` → `{ [itemId: string]: number }`, a plain object of read counts, absent key meaning zero. Task 4's UI reuses the `state.rows` array this task builds.

- [ ] **Step 1: Write the failing test for the route**

Add to `tests/viewer/write.test.ts`, inside the existing `describe`:

```typescript
  it('reports read counts, with never-read atoms simply absent', async () => {
    const response = await fetch(url('/api/reads'));
    expect(response.status).toBe(200);
    const reads = await response.json();
    expect(typeof reads).toBe('object');
    // The fixture atoms have never been retrieved, so they must not appear at all.
    expect(reads[atomId]).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/viewer/write.test.ts -t 'read counts'`

Expected: FAIL with status 405 — `/api/reads` does not exist, so it falls through to the method gate.

- [ ] **Step 3: Add the route**

In `src/viewer/server.ts`, import beside the existing `getKnowledgeAccessReport` import:

```typescript
import { getAccessSummary, getKnowledgeAccessReport } from '../store/access-feedback.js';
```

And add beside the other GET routes:

```typescript
    if (pathname === '/api/reads') {
      // A plain object of counts, absent meaning zero. The map is built from `knowledge_access`,
      // so an atom nobody has ever retrieved has no row and therefore no key -- which is what
      // makes the Unread lens a lookup miss rather than a second query.
      const summary = await getAccessSummary();
      const counts: Record<string, number> = {};
      for (const [id, entry] of summary) counts[id] = entry.retrievalCount;
      return json(response, counts);
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/viewer/write.test.ts -t 'read counts'`

Expected: PASS.

- [ ] **Step 5: Add the view toggle and the list markup**

In `src/viewer/ui.ts`, in the `<div id="app">` block, add a view switch beside the existing search input, and a list container as a sibling of the `<canvas id="graph">`:

```html
      <div class="viewswitch" role="tablist">
        <button id="tab-graph" role="tab" aria-selected="true">Graph</button>
        <button id="tab-list" role="tab" aria-selected="false">List</button>
      </div>
```

```html
    <div class="listwrap" id="listwrap" hidden>
      <div class="lenses" role="tablist">
        <button data-lens="all" class="on" role="tab">All <span class="n" id="n-all"></span></button>
        <button data-lens="unread" role="tab">Unread <span class="n" id="n-unread"></span></button>
        <button data-lens="stale" role="tab">Stale <span class="n" id="n-stale"></span></button>
      </div>
      <table class="atoms"><thead><tr>
        <th>Title</th><th>Category</th><th>Freshness</th><th>Age</th><th class="num">Reads</th>
      </tr></thead><tbody id="atomrows"></tbody></table>
      <p class="empty-list" id="listempty" hidden>Nothing matches.</p>
    </div>
```

- [ ] **Step 6: Add the list logic**

In the script block of `src/viewer/ui.ts`, beside the existing `fetchJSON` / `renderStats` functions. Match the surrounding ES5 style — `function (x) {}`, `var`, no arrow functions, no template literals:

```javascript
  var reads = {};
  var lens = 'all';

  function ageDays(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  function readCount(item) { return reads[item.id] || 0; }

  function inLens(item) {
    if (lens === 'unread') return readCount(item) === 0;
    if (lens === 'stale') return item.freshness !== 'fresh';
    return true;
  }

  function listRows() {
    var q = (document.getElementById('search').value || '').toLowerCase();
    return items.filter(function (item) {
      if (item.status !== 'active') return false;
      if (hiddenCat[item.category]) return false;
      if (!inLens(item)) return false;
      if (!q) return true;
      return (item.title + ' ' + (item.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      // Unread sorts oldest-first: the longest-ignored atom is the likeliest to be dead
      // weight, and it is the one a person scrolling a list will otherwise never reach.
      if (lens === 'unread') return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  }

  function renderList() {
    var rows = listRows();
    var body = document.getElementById('atomrows');
    body.innerHTML = rows.map(function (item) {
      var age = ageDays(item.updatedAt);
      return '<tr data-id="' + esc(item.id) + '">' +
        '<td class="t">' + esc(item.title) + '</td>' +
        '<td><span class="cat cat-' + esc(item.category) + '">' + esc(item.category) + '</span></td>' +
        '<td>' + esc(item.freshness) + '</td>' +
        '<td>' + (age === null ? '—' : age + 'd') + '</td>' +
        '<td class="num">' + readCount(item) + '</td>' +
      '</tr>';
    }).join('');
    document.getElementById('listempty').hidden = rows.length > 0;

    var active = items.filter(function (i) { return i.status === 'active'; });
    document.getElementById('n-all').textContent = active.length;
    document.getElementById('n-unread').textContent = active.filter(function (i) { return readCount(i) === 0; }).length;
    document.getElementById('n-stale').textContent = active.filter(function (i) { return i.freshness !== 'fresh'; }).length;

    Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () {
        var item = items.filter(function (i) { return i.id === tr.getAttribute('data-id'); })[0];
        if (item) openInspector(item);
      });
    });
  }

  function setView(next) {
    var isList = next === 'list';
    document.getElementById('listwrap').hidden = !isList;
    document.getElementById('graph').hidden = isList;
    document.getElementById('tab-list').setAttribute('aria-selected', String(isList));
    document.getElementById('tab-graph').setAttribute('aria-selected', String(!isList));
    if (isList) renderList();
  }

  document.getElementById('tab-graph').addEventListener('click', function () { setView('graph'); });
  document.getElementById('tab-list').addEventListener('click', function () { setView('list'); });
  Array.prototype.forEach.call(document.querySelectorAll('.lenses button'), function (button) {
    button.addEventListener('click', function () {
      lens = button.getAttribute('data-lens');
      Array.prototype.forEach.call(document.querySelectorAll('.lenses button'), function (b) {
        b.classList.toggle('on', b === button);
      });
      renderList();
    });
  });
```

Where the page already loads its data (the block calling `renderLegend()` and `renderStats()`), add the reads fetch and keep `items` populated from `/api/brain`:

```javascript
    fetchJSON('/api/reads').then(function (r) { reads = r || {}; renderList(); });
```

Wire `renderList()` into the existing search input handler so typing filters both views.

- [ ] **Step 7: Add the styles**

In the `<style>` block, matching the existing dark palette and the token names already in the file:

```css
.viewswitch { display: flex; gap: 2px; }
.viewswitch button { background: transparent; border: 1px solid #1a242a; color: #8b98a5; padding: 4px 10px; cursor: pointer; font: inherit; }
.viewswitch button[aria-selected="true"] { color: #e6edf3; border-color: #4f6e7f; }
.listwrap { position: absolute; inset: 0; overflow: auto; padding: 12px 16px; }
.lenses { display: flex; gap: 4px; margin-bottom: 10px; }
.lenses button { background: transparent; border: 1px solid #1a242a; color: #8b98a5; padding: 4px 10px; cursor: pointer; font: inherit; }
.lenses button.on { color: #e6edf3; border-color: #4f6e7f; }
.lenses .n { opacity: .6; margin-left: 5px; }
table.atoms { width: 100%; border-collapse: collapse; font-size: 13px; }
table.atoms th { text-align: left; color: #8b98a5; font-weight: 500; border-bottom: 1px solid #1a242a; padding: 6px 8px; }
table.atoms td { border-bottom: 1px solid #131b20; padding: 6px 8px; color: #c9d4de; }
table.atoms tr:hover td { background: #131b20; cursor: pointer; }
table.atoms td.t { color: #e6edf3; max-width: 52ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.atoms .num { text-align: right; font-variant-numeric: tabular-nums; }
.empty-list { color: #8b98a5; padding: 16px 8px; }
```

- [ ] **Step 8: Render it and read it**

This is the step the constraint exists for. Run:

```bash
npm run build && node dist/index.js view
```

Open the printed URL and confirm, by looking:

1. **List** shows rows, not an empty table. The count on **All** matches `knowl status`.
2. **Unread** is smaller than All, and its rows show `0` in the Reads column — every one.
3. Sorting in Unread puts the **oldest** first; in All, the newest.
4. Typing in the search box filters the table.
5. Category toggles in the rail filter the table, not only the graph.
6. Clicking a row opens the same inspector the graph opens.
7. Switching back to **Graph** still renders and animates — the canvas is hidden, not destroyed.

- [ ] **Step 9: Run the full suite and commit**

Run: `npm test`

```bash
git add src/viewer/server.ts src/viewer/ui.ts tests/viewer/write.test.ts
git commit -m "feat(viewer): a list, and a lens for what nobody ever reads

The viewer's only navigation was a force-directed canvas. 656 atoms averaging
about 2 KB cannot be found that way, and the store this was measured against
had 48 atoms carrying no information at all -- none of which anyone could have
gone looking for, because you cannot search for what you do not know is there.

Unread finds them. It sorts oldest-first, because the longest-ignored atom is
the likeliest to be dead weight and the one a person scrolling will never
otherwise reach.

/api/reads is built from getAccessSummary rather than getKnowledgeAccessReport:
the report INNER JOINs knowledge_access, so the atoms with no reads are exactly
the rows it drops. An absent key means zero, which makes the lens a lookup miss
instead of a second query."
```

---

### Task 4: Edit and add, in the inspector

Spec §7. The verbs, on the UI Task 3 built, over the routes Task 2 exposed.

**Files:**
- Modify: `src/viewer/ui.ts` (edit form in the inspector, a new-atom form, an archive action)

**Interfaces:**
- Consumes: `openInspector(item)` and `closeInspector()` (existing, `src/viewer/ui.ts:518` and `:583`); `items` and `renderList()` from Task 3; the three write routes from Task 2.
- Produces: nothing further. This is the last task in the viewer chain.

- [ ] **Step 1: Add the edit form to the inspector**

In `openInspector`, after the existing content block, add an actions row and a hidden form. Keep the ES5 style:

```javascript
    var actions = '<div class="acts">' +
      '<button id="ins-edit">Edit</button>' +
      '<button id="ins-archive" class="danger">Archive</button>' +
      '</div>';

    var form = '<form class="editform" id="ins-form" hidden>' +
      '<label>Title<input name="title" required /></label>' +
      '<label>Content<textarea name="content" rows="12" required></textarea></label>' +
      '<label>Reasoning<textarea name="reasoning" rows="4"></textarea></label>' +
      '<label>Tags<input name="tags" placeholder="comma, separated" /></label>' +
      '<label>Category<select name="category">' +
        ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'].map(function (c) {
          return '<option value="' + c + '">' + c + '</option>';
        }).join('') +
      '</select></label>' +
      '<label>Confidence<input name="confidence" type="number" min="0" max="1" step="0.05" /></label>' +
      '<div class="acts"><button type="submit">Save</button>' +
      '<button type="button" id="ins-cancel">Cancel</button></div>' +
      '<p class="err" id="ins-err" hidden></p>' +
      '</form>';
```

Append `actions + form` to the inspector's existing HTML string, then wire it below where the inspector's other listeners are attached:

```javascript
    var form_ = document.getElementById('ins-form');
    document.getElementById('ins-edit').addEventListener('click', function () {
      form_.title.value = n.title || '';
      form_.content.value = n.content || '';
      form_.reasoning.value = n.reasoning || '';
      form_.tags.value = (n.tags || []).join(', ');
      form_.category.value = n.category;
      form_.confidence.value = n.confidence === null || n.confidence === undefined ? '' : n.confidence;
      form_.hidden = false;
    });
    document.getElementById('ins-cancel').addEventListener('click', function () { form_.hidden = true; });

    form_.addEventListener('submit', function (event) {
      event.preventDefault();
      var patch = {
        title: form_.title.value.trim(),
        content: form_.content.value,
        reasoning: form_.reasoning.value.trim() || null,
        tags: form_.tags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        category: form_.category.value
      };
      if (form_.confidence.value !== '') patch.confidence = Number(form_.confidence.value);
      save('/api/atoms/' + encodeURIComponent(n.id), 'PATCH', patch);
    });

    document.getElementById('ins-archive').addEventListener('click', function () {
      // Archive is reversible, so it asks once rather than making the user type the title.
      if (!window.confirm('Archive "' + n.title + '"? It stops appearing in queries and can be restored.')) return;
      save('/api/atoms/' + encodeURIComponent(n.id) + '/archive', 'POST', undefined);
    });
```

- [ ] **Step 2: Add the save helper and the reload**

Beside `fetchJSON`:

```javascript
  function save(path, method, body) {
    return fetch(path, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload.error || ('Request failed: ' + response.status));
        });
      }
      // Re-fetch rather than patching `items` in place. The store computes contentHash,
      // freshness and updatedAt on write, so a locally spliced row would disagree with the
      // database in exactly the fields the list sorts and filters on.
      return fetchJSON('/api/brain').then(function (fresh) {
        items = fresh;
        renderLegend(); renderStats(); renderList();
        closeInspector();
      });
    }).catch(function (error) {
      var slot = document.getElementById('ins-err');
      if (slot) { slot.textContent = error.message; slot.hidden = false; }
      else window.alert(error.message);
    });
  }
```

- [ ] **Step 3: Add the new-atom form**

Add a button beside the view switch and a dialog:

```html
      <button id="new-atom">+ New memory</button>
```

```html
    <dialog id="newdlg"><form id="newform" method="dialog">
      <h2>New memory</h2>
      <label>Category<select name="category">
        <option value="fact">fact</option><option value="decision">decision</option>
        <option value="goal">goal</option><option value="constraint">constraint</option>
        <option value="architecture">architecture</option><option value="state">state</option>
        <option value="skill">skill</option>
      </select></label>
      <label>Title<input name="title" required /></label>
      <label>Content<textarea name="content" rows="12" required></textarea></label>
      <label>Tags<input name="tags" placeholder="comma, separated" /></label>
      <div class="acts"><button value="save">Save</button>
      <button type="button" id="newcancel">Cancel</button></div>
      <p class="err" id="newerr" hidden></p>
    </form></dialog>
```

```javascript
  var dlg = document.getElementById('newdlg');
  document.getElementById('new-atom').addEventListener('click', function () { dlg.showModal(); });
  document.getElementById('newcancel').addEventListener('click', function () { dlg.close(); });
  document.getElementById('newform').addEventListener('submit', function (event) {
    var f = event.target;
    if (!f.title.value.trim() || !f.content.value.trim()) return;
    event.preventDefault();
    save('/api/atoms', 'POST', {
      category: f.category.value,
      title: f.title.value.trim(),
      content: f.content.value,
      tags: f.tags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    }).then(function () { dlg.close(); f.reset(); });
  });
```

`<dialog>` is native and needs no library — it gives focus trapping, `Esc` to close, and the backdrop for free.

- [ ] **Step 4: Style the forms**

```css
.acts { display: flex; gap: 8px; margin-top: 12px; }
.acts button { background: #131b20; border: 1px solid #1a242a; color: #c9d4de; padding: 5px 12px; cursor: pointer; font: inherit; }
.acts button:hover { border-color: #4f6e7f; color: #e6edf3; }
.acts button.danger:hover { border-color: #8a4b4b; color: #f0c0c0; }
.editform label, #newform label { display: block; margin: 10px 0; color: #8b98a5; font-size: 12px; }
.editform input, .editform textarea, .editform select,
#newform input, #newform textarea, #newform select {
  display: block; width: 100%; margin-top: 4px; background: #0d1418; color: #e6edf3;
  border: 1px solid #1a242a; padding: 6px 8px; font: inherit; box-sizing: border-box;
}
.editform textarea, #newform textarea { resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
dialog#newdlg { background: #0f171c; color: #c9d4de; border: 1px solid #1a242a; max-width: 720px; width: 90vw; }
dialog#newdlg::backdrop { background: rgba(0, 0, 0, .6); }
.err { color: #f0a0a0; margin-top: 8px; }
```

- [ ] **Step 5: Render it and read it**

Run:

```bash
npm run build && node dist/index.js view
```

Confirm by looking and clicking:

1. **Edit a real atom**, save, and see the row update in the list without a page reload.
2. **Verify it stuck**: `node dist/index.js query "<a word you typed>"` returns your text.
3. **Archive one** — it disappears from the list; `knowl status` counts one fewer active.
4. **Add one** via `+ New memory`; it appears in the list and in `knowl query`.
5. **Trigger the error path**: edit an atom, and before saving, archive the same atom in a second tab. The save shows the error in the form rather than failing silently.
6. **Cancel leaves nothing behind** — reopen the inspector and the old values are there.
7. **`Esc` closes the new-memory dialog** without writing.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add src/viewer/ui.ts
git commit -m "feat(viewer): edit, add and archive a memory

The read half shipped without the verbs. This adds them to the inspector the
graph and the list already share, over the routes the server already serves.

A save re-fetches rather than splicing the row in place: the store computes
contentHash, freshness and updatedAt on write, so a locally patched row would
disagree with the database in exactly the fields the list sorts and filters on.

Archive asks once and is reversible. The new-memory form is a native <dialog>,
which gives focus trapping, Esc-to-close and a backdrop without a library.

Errors render in the form. A write that fails where nobody sees it is worse
than one that refuses loudly, because the user walks away believing the
correction landed."
```

---

### Task 5: `knowl list`

Spec §9. `query` searches; nothing browses. The logic lives in a sibling module because `program.ts` cannot be imported by a test.

**Files:**
- Create: `src/cli/list-report.ts`
- Create: `tests/cli/list-report.test.ts`
- Modify: `src/cli/program.ts` (register the command)

**Interfaces:**
- Consumes: `KnowledgeItem` from `src/core/types.js`; `getAccessSummary` from `src/store/access-feedback.js`; `listKnowledgeItems` from `src/store/repository.js`.
- Produces:
  - `type ListOptions = { lens?: 'all' | 'unread' | 'stale'; category?: string; limit?: number }`
  - `selectListRows(items: KnowledgeItem[], reads: Map<string, number>, options: ListOptions): ListRow[]`
  - `type ListRow = { id: string; title: string; category: string; freshness: string; ageDays: number | null; reads: number }`
  - `formatListRows(rows: ListRow[], total: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/list-report.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { selectListRows, formatListRows } from '../../src/cli/list-report.js';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');

function atom(over: Partial<any> = {}): any {
  return {
    id: 'a'.repeat(16), category: 'fact', status: 'active', title: 'An atom',
    content: 'Body.', freshness: 'fresh', updatedAt: '2026-08-18T00:00:00.000Z', ...over,
  };
}

describe('list report', () => {
  it('shows only active atoms', () => {
    const rows = selectListRows(
      [atom({ id: 'keep' }), atom({ id: 'gone', status: 'superseded' }), atom({ id: 'filed', status: 'archived' })],
      new Map(), {}, NOW,
    );
    expect(rows.map(row => row.id)).toEqual(['keep']);
  });

  it('unread means absent from the read map, not a zero in it', () => {
    const rows = selectListRows(
      [atom({ id: 'never' }), atom({ id: 'read' })],
      new Map([['read', 3]]), { lens: 'unread' }, NOW,
    );
    expect(rows.map(row => row.id)).toEqual(['never']);
    expect(rows[0].reads).toBe(0);
  });

  it('sorts unread oldest first and everything else newest first', () => {
    const old = atom({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' });
    const recent = atom({ id: 'recent', updatedAt: '2026-08-18T00:00:00.000Z' });
    expect(selectListRows([recent, old], new Map(), { lens: 'unread' }, NOW).map(r => r.id))
      .toEqual(['old', 'recent']);
    expect(selectListRows([old, recent], new Map(), {}, NOW).map(r => r.id))
      .toEqual(['recent', 'old']);
  });

  it('stale means any freshness that is not fresh', () => {
    const rows = selectListRows(
      [atom({ id: 'f', freshness: 'fresh' }), atom({ id: 's', freshness: 'stale' }), atom({ id: 'n', freshness: 'needs_review' })],
      new Map(), { lens: 'stale' }, NOW,
    );
    expect(rows.map(row => row.id).sort()).toEqual(['n', 's']);
  });

  it('filters by category and honours the limit', () => {
    const items = [atom({ id: '1', category: 'fact' }), atom({ id: '2', category: 'decision' }), atom({ id: '3', category: 'fact' })];
    expect(selectListRows(items, new Map(), { category: 'fact' }, NOW)).toHaveLength(2);
    expect(selectListRows(items, new Map(), { limit: 1 }, NOW)).toHaveLength(1);
  });

  it('computes age in whole days from the given clock', () => {
    const rows = selectListRows([atom({ updatedAt: '2026-08-09T00:00:00.000Z' })], new Map(), {}, NOW);
    expect(rows[0].ageDays).toBe(10);
  });

  it('renders a row per atom and says what was withheld', () => {
    const rows = selectListRows([atom({ id: 'abcdef1234567890', title: 'Readable title' })], new Map(), {}, NOW);
    const output = formatListRows(rows, 40);
    expect(output).toContain('abcdef12');
    expect(output).toContain('Readable title');
    expect(output).toContain('1 of 40');
  });

  it('says so plainly when nothing matches', () => {
    expect(formatListRows([], 0)).toContain('No memories');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/list-report.test.ts`

Expected: FAIL — `Cannot find module '../../src/cli/list-report.js'`.

- [ ] **Step 3: Write the module**

Create `src/cli/list-report.ts`:

```typescript
import pc from 'picocolors';
import type { KnowledgeItem } from '../core/types.js';

export type ListLens = 'all' | 'unread' | 'stale';

export type ListOptions = {
  lens?: ListLens;
  category?: string;
  limit?: number;
};

export type ListRow = {
  id: string;
  title: string;
  category: string;
  freshness: string;
  ageDays: number | null;
  reads: number;
};

/**
 * `reads` is keyed only by atoms that have been retrieved at least once -- `getAccessSummary`
 * builds it from `knowledge_access`, so an atom nobody has read has no row and no key. That
 * absence IS the unread lens; do not expect a zero to be stored.
 *
 * `now` is a parameter rather than a `Date.now()` call so the age column is testable.
 */
export function selectListRows(
  items: KnowledgeItem[],
  reads: Map<string, number>,
  options: ListOptions,
  now: number = Date.now(),
): ListRow[] {
  const lens = options.lens ?? 'all';

  const matching = items.filter(item => {
    if (item.status !== 'active') return false;
    if (options.category && item.category !== options.category) return false;
    if (lens === 'unread') return (reads.get(item.id) ?? 0) === 0;
    if (lens === 'stale') return item.freshness !== 'fresh';
    return true;
  });

  // Unread sorts oldest-first: the longest-ignored atom is the likeliest to be dead weight,
  // and is the one a person reading down a list would otherwise never reach.
  const ascending = lens === 'unread';
  matching.sort((a, b) => {
    const left = String(a.updatedAt ?? '');
    const right = String(b.updatedAt ?? '');
    return ascending ? left.localeCompare(right) : right.localeCompare(left);
  });

  const limited = options.limit === undefined ? matching : matching.slice(0, options.limit);

  return limited.map(item => ({
    id: item.id,
    title: item.title,
    category: item.category,
    freshness: item.freshness,
    ageDays: item.updatedAt ? Math.floor((now - new Date(item.updatedAt).getTime()) / 86_400_000) : null,
    reads: reads.get(item.id) ?? 0,
  }));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

export function formatListRows(rows: ListRow[], total: number): string {
  if (rows.length === 0) return 'No memories match.';

  const lines = [
    pc.dim(`${pad('ID', 10)}${pad('CATEGORY', 14)}${pad('AGE', 7)}${pad('READS', 7)}TITLE`),
  ];

  for (const row of rows) {
    const reads = row.reads === 0 ? pc.yellow(pad('0', 7)) : pad(String(row.reads), 7);
    lines.push(
      pc.dim(pad(row.id.slice(0, 8), 10)) +
      pad(row.category, 14) +
      pad(row.ageDays === null ? '—' : `${row.ageDays}d`, 7) +
      reads +
      row.title,
    );
  }

  // Never let a limit read as "this is everything".
  lines.push('');
  lines.push(pc.dim(`Showing ${rows.length} of ${total} active.`));
  return lines.join('\n');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/cli/list-report.test.ts`

Expected: PASS, all eight cases.

- [ ] **Step 5: Register the command**

In `src/cli/program.ts`, beside the existing `query` command, following the surrounding `try/catch` + `process.exit(1)` convention:

```typescript
program
  .command('list')
  .description('Browse stored memories')
  .option('--unread', 'Only memories that have never been retrieved')
  .option('--stale', 'Only memories that are not fresh')
  .option('--category <category>', 'Filter by category')
  .option('--limit <n>', 'Maximum rows to show', parseInt)
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      const [items, reads] = await Promise.all([repo.listKnowledgeItems(), getAccessSummary()]);
      const counts = new Map<string, number>();
      for (const [id, entry] of reads) counts.set(id, entry.retrievalCount);
      const lens = options.unread ? 'unread' : options.stale ? 'stale' : 'all';
      const rows = selectListRows(items, counts, { lens, category: options.category, limit: options.limit ?? 50 });
      const active = items.filter(item => item.status === 'active').length;
      console.log(formatListRows(rows, active));
    } catch (error: any) {
      console.error(`Error listing memories: ${error.message}`);
      process.exit(1);
    }
  });
```

Add the imports at the top of `program.ts`:

```typescript
import { formatListRows, selectListRows } from './list-report.js';
import { getAccessSummary } from '../store/access-feedback.js';
```

- [ ] **Step 6: Render it and read it**

Run:

```bash
npm run build
node dist/index.js list
node dist/index.js list --unread
node dist/index.js list --unread --limit 5
node dist/index.js list --category decision
```

Confirm by looking:

1. Columns line up; no title wraps mid-column.
2. `--unread` rows all show `0` in READS, coloured.
3. The footer always says `Showing N of M active` — never let 5 rows read as the whole store.
4. `NO_COLOR=1 node dist/index.js list` has no escape codes (picocolors handles this; confirm it).
5. `list --category nonsense` prints `No memories match.`, not an empty frame.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add src/cli/list-report.ts tests/cli/list-report.test.ts src/cli/program.ts
git commit -m "feat(cli): knowl list, because query only searches

There has never been a way to simply browse. You had to already know what you
were looking for, which is exactly the case that fails when the problem is an
atom carrying no information -- nobody searches for what they do not know is
there. --unread surfaces those.

The logic is in a sibling module because program.ts parses argv at import, so
nothing defined there can be reached by a test. The clock is a parameter for
the same reason.

The footer always names the total. A limit that reads as the whole store is
how somebody concludes their memory is empty."
```

---

### Task 6: `knowl edit <id>`

Spec §9. The CLI's editing entry point is a link, not a UI. Building a terminal editor for a 2 KB markdown body with tags, category, confidence and a supersede picker is a second editing surface to keep in sync with the first, for a worse result than the browser already gives.

**Files:**
- Create: `src/cli/edit-link.ts`
- Create: `tests/cli/edit-link.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `ViewerServer` (`{ url: string; token: string; browseUrl: string; close: () => Promise<void> }`) from `src/viewer/server.js`.
- Produces: `atomEditUrl(viewer: { url: string; token: string }, atomId: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/edit-link.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { atomEditUrl } from '../../src/cli/edit-link.js';

const VIEWER = { url: 'http://127.0.0.1:52413', token: 'tok-en_123' };

describe('atom edit url', () => {
  it('carries the token so a pasted link authenticates', () => {
    expect(atomEditUrl(VIEWER, 'abc123')).toBe('http://127.0.0.1:52413/?token=tok-en_123#/atom/abc123');
  });

  it('escapes an id that would otherwise break the fragment', () => {
    expect(atomEditUrl(VIEWER, 'a/b?c#d')).toContain('#/atom/a%2Fb%3Fc%23d');
  });

  it('escapes a token containing url-significant characters', () => {
    expect(atomEditUrl({ url: 'http://127.0.0.1:1', token: 'a+b/c=' }, 'x'))
      .toContain('token=a%2Bb%2Fc%3D');
  });

  it('does not double up a slash when the origin carries a trailing one', () => {
    expect(atomEditUrl({ url: 'http://127.0.0.1:1/', token: 't' }, 'x'))
      .toBe('http://127.0.0.1:1/?token=t#/atom/x');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/edit-link.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/cli/edit-link.ts`:

```typescript
/**
 * A deep link into the running viewer, pointed at one atom.
 *
 * The token rides in the query because that is how `browseUrl` already authenticates a pasted
 * link -- the page swaps it for an HttpOnly cookie on first load. The atom goes in the fragment
 * instead, so it is never sent to the server: routing to a row is the page's business, and a
 * fragment keeps the id out of the access log.
 */
export function atomEditUrl(viewer: { url: string; token: string }, atomId: string): string {
  const origin = viewer.url.replace(/\/+$/, '');
  return `${origin}/?token=${encodeURIComponent(viewer.token)}#/atom/${encodeURIComponent(atomId)}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/cli/edit-link.test.ts`

Expected: PASS, all four cases.

- [ ] **Step 5: Teach the page to honour the fragment**

In `src/viewer/ui.ts`, after the initial data load completes (the block that calls `renderLegend()` and `renderStats()`), add:

```javascript
    var wanted = /^#\/atom\/(.+)$/.exec(window.location.hash || '');
    if (wanted) {
      var target = items.filter(function (i) { return i.id === decodeURIComponent(wanted[1]); })[0];
      // Open the row rather than hunting for a dot in a physics simulation, which is the whole
      // reason `knowl edit` exists.
      if (target) { setView('list'); openInspector(target); }
    }
```

- [ ] **Step 6: Register the command**

In `src/cli/program.ts`, beside the `view` command:

```typescript
program
  .command('edit <id>')
  .description('Open a memory in the local viewer to edit it')
  .option('--port <port>')
  .action(async (id: string, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      // Refuse before starting a server the user would then have to kill. A viewer opened on a
      // typo'd id shows an unexplained empty page.
      const item = await repo.getKnowledgeItem(id);
      if (!item) {
        console.error(`No memory with id ${id}. Run \`knowl list\` to find it.`);
        process.exit(1);
      }
      const viewer = await startViewer(root, { port: options.port === undefined ? 0 : Number(options.port) });
      console.log(`Editing "${item.title}"`);
      console.log(atomEditUrl(viewer, id));
      const stop = () => { void viewer.close().catch(() => {}).then(() => process.exit(0)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error: any) {
      console.error(`Error opening the editor: ${error.message}`);
      process.exit(1);
    }
  });
```

Add the import:

```typescript
import { atomEditUrl } from './edit-link.js';
```

- [ ] **Step 7: Render it and read it**

Run:

```bash
npm run build
node dist/index.js list --limit 3          # copy an id
node dist/index.js edit <that-id>
node dist/index.js edit definitely-not-an-id
```

Confirm:

1. The real id prints the atom's title and a URL; opening it lands on the **list** with that atom's inspector already open.
2. Editing from there saves, and `knowl query` returns the new text.
3. The bad id prints the "no memory with id" line, exits non-zero, and **does not** leave a server running (`node dist/index.js edit bad; echo $?` prints `1` and returns to the prompt).
4. `Ctrl-C` on a running `knowl edit` exits cleanly with status 0.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm test`

```bash
git add src/cli/edit-link.ts tests/cli/edit-link.test.ts src/cli/program.ts src/viewer/ui.ts
git commit -m "feat(cli): knowl edit opens the viewer on one memory

The CLI's editing entry point is a link, not a UI. A terminal editor for a 2 KB
markdown body with tags, category, confidence and a supersede picker is a second
editing surface to keep in sync with the first, for a worse result than the
browser already gives one command away.

The id rides in the fragment rather than the query: routing to a row is the
page's business and a fragment is never sent, so the id stays out of the access
log. The token stays in the query because that is how a pasted viewer link
already authenticates.

A missing id is refused BEFORE the server starts. A viewer opened on a typo is
an unexplained empty page plus a process the user now has to kill."
```

---

## Self-Review

**Spec coverage.** §7 single-atom edit/add/archive → Tasks 2 and 4. §9 local viewer reading → Task 3; viewer writing → Task 2; `knowl list` → Task 5; `knowl edit` → Task 6. §10 extractor → Task 1. §12's local-viewer test list → Tasks 2 and 3 (405-per-route, token, Host, `SameSite`, edit-lands-in-db).

**Deliberately not in this plan, and why.** §6's *New* and *Needs attention* lenses need a persisted "last reviewed" timestamp, which the local store has no home for — spec §11 puts it on `workspace_members`, a cloud table. Spec §13 stages those after the cloud work, so they belong to the second plan along with the decision about where local state lives. §7's supersede action, §8's bulk operations, and everything in `web/` are likewise out of scope here. The Unread and Stale lenses need no new state and are in Task 3.

**One spec item consciously narrowed.** §7 says permanent deletion sits behind a typed confirmation. This plan ships **archive only** from the viewer; `deleteKnowledgeItem` is not wired to any route. Permanent deletion already exists as `knowl forget`, and adding a second irreversible path in the same change as the first-ever write route is more risk than the task needs. Note it for the second plan.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-19-local-memory-editor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
