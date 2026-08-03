# Session Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browsable inventory of this project's past Claude Code sessions — best-known name, opening ask, activity, status, and what each session promoted into memory — so an agent can answer "which session was about X?" and then read into the one it picks.

**Architecture:** The transcript indexer in `src/transcripts/` already streams every line of every session file. This captures three more things during that same pass, at no extra IO: the session's self-declared title, its opening ask, and nothing else. A new gated MCP tool joins that with per-session activity and with the atoms each session promoted, through the existing `host_session_bindings → memory_sessions → promotion_items` chain.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@libsql/client` (SQLite 3.45.1), Vitest, MCP SDK.

**Adapted from PR #8** (`William-Sommers:feat/session-directory`). That PR is stacked on #7, whose transcript index this repo replaced — so its `session-directory.ts` reads columns our schema does not have, and its `sessionFiles` / `ensureTranscriptIndex` / `searchTranscripts` helpers duplicate modules we already shipped. **This is a port, not a rebase.** The design research and the title-precedence rule carry over; the storage layer does not.

## Global Constraints

- **Reuse `src/transcripts/`, do not fork it.** `discoverTranscriptFiles`, `streamProseFrom`, `runIndexPass`, `openTranscriptDb` and `resolveStorage(root).transcripts` already exist and are tested. PR #8's `sessionFiles`, `encodeProjectDir`, `transcriptStores`, `ensureTranscriptIndex`, `searchTranscripts` and `readTranscriptEntry` are its own copies of that layer — do not port any of them.
- **Same gate as the other two tools.** `search.transcripts.enabled` must be true or the tool is not registered and the handler refuses. Re-read config per call via the `enabledConfig` helper in `src/transcripts/mcp-handlers.ts` — a captured snapshot does not see the feature being turned off.
- **Never open a database read-only that may not exist.** `openTranscriptDb(path, { readOnly: true })` throws `TranscriptIndexMissingError`; handle it. A writable open creates the file and would resurrect an index the user deleted.
- **Titles are captured, never stored as knowledge.** This tool reads; it writes nothing to `knowledge_items`.
- **Status is derived at read time, never stored.** A stored status is wrong the moment the session it describes changes.
- **Tool inventory is asserted.** `tests/core/knowl-guidance.test.ts:44-45` pins the groups and names. This tool is *conditional*, so it must **not** enter `KNOWL_MCP_TOOL_GROUPS` or `KNOWL_MCP_TOOL_NAMES` — it joins the transcript group in the compact card only when enabled, exactly as the other two do.
- **Verification gate:** `npm test` + `npm run build` + `git diff --check`. Not `npx tsc --noEmit` — `main` has 15 pre-existing errors in untouched files.
- **Commit style:** Conventional Commits, lowercase subject, no trailing period.

---

### Task 1: Capture the session's name and opening ask during the pass we already make

**Files:**
- Modify: `src/transcripts/database.ts` (three columns on `transcript_files`)
- Modify: `src/transcripts/parse.ts` (recognise the naming entries)
- Modify: `src/transcripts/index-pass.ts` (carry them into the watermark write)
- Test: `tests/transcripts/session-naming.test.ts`

**Interfaces:**
- Consumes: `streamProseFrom` / `ProseChunk` (`src/transcripts/parse.ts`), `commitBatchOn` (`src/transcripts/index-pass.ts`)
- Produces:
  - `NAME_KIND: { none: 0; ai: 1; agent: 2; custom: 3 }`
  - `readSessionNaming(entry: unknown): { name: string; kind: number } | { opening: string } | null`
  - Columns `display_name TEXT`, `name_kind INTEGER NOT NULL DEFAULT 0`, `opening TEXT` on `transcript_files`

**The precedence rule, which is the whole point.** A transcript names itself, and the names have a rank: a user's rename (`custom-title`, rank 3) beats an agent name (`agent-name`, rank 2) beats a generated title (`ai-title`, rank 1). Later beats earlier *within* a rank, never across it — otherwise a generated title appended after a rename would overwrite the rename. PR #8's survey of nine shipped tools found that **none of them read these entries**; they fall back to filenames or first prompts while the user's own rename sits unread in the file.

**Rank must be carried across incremental passes.** The rank of the name currently stored comes from the `name_kind` column, not from zero, or a second pass over an appended file would let a rank-1 entry overwrite a rank-3 name.

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/session-naming.test.ts`. Copy the temp-dir and `ENCODED_ROOT` setup from `tests/transcripts/index-pass.test.ts:14-40` — it derives the encoded directory rather than hardcoding it, which is required for CI on `ubuntu-latest`.

```typescript
import { describe, expect, it } from 'vitest';
import { readSessionNaming, NAME_KIND } from '../../src/transcripts/parse.js';

describe('readSessionNaming', () => {
  it('reads a user rename at the highest rank', () => {
    expect(readSessionNaming({ type: 'custom-title', customTitle: 'ui-trial-screen' }))
      .toEqual({ name: 'ui-trial-screen', kind: NAME_KIND.custom });
  });

  it('reads an agent name below a rename', () => {
    expect(readSessionNaming({ type: 'agent-name', agentName: 'explorer' }))
      .toEqual({ name: 'explorer', kind: NAME_KIND.agent });
  });

  it('reads a generated title at the lowest rank', () => {
    expect(readSessionNaming({ type: 'ai-title', aiTitle: 'Generated title about buttons' }))
      .toEqual({ name: 'Generated title about buttons', kind: NAME_KIND.ai });
  });

  it('ignores an entry with the right type but no usable value', () => {
    expect(readSessionNaming({ type: 'custom-title' })).toBeNull();
    expect(readSessionNaming({ type: 'custom-title', customTitle: '   ' })).toBeNull();
  });

  it('ignores ordinary transcript entries', () => {
    expect(readSessionNaming({ type: 'user', message: { content: 'hello' } })).toBeNull();
  });
});
```

Then the integration half, in the same file:

```typescript
describe('naming captured during the index pass', () => {
  it('prefers a user rename over a generated title in the same file', async () => {
    await write('named.jsonl',
      naming({ type: 'ai-title', aiTitle: 'Generated title about buttons' }) +
      naming({ type: 'custom-title', customTitle: 'ui-trial-screen' }) +
      line('user', 'first real question'));

    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    const row = await fileRow('named');
    expect(row.display_name).toBe('ui-trial-screen');
    expect(Number(row.name_kind)).toBe(NAME_KIND.custom);
  });

  it('does not let a later generated title overwrite a rename', async () => {
    await write('named.jsonl',
      naming({ type: 'custom-title', customTitle: 'ui-trial-screen' }) +
      naming({ type: 'ai-title', aiTitle: 'Generated title about buttons' }));

    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    expect((await fileRow('named')).display_name).toBe('ui-trial-screen');
  });

  it('takes a later rename at the same rank', async () => {
    await write('named.jsonl', naming({ type: 'custom-title', customTitle: 'first-name' }));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    await append('named.jsonl', naming({ type: 'custom-title', customTitle: 'second-name' }));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    expect((await fileRow('named')).display_name).toBe('second-name');
  });

  // The incremental trap: rank has to survive a pass boundary, or an appended low-rank
  // entry silently demotes a name captured earlier.
  it('keeps a rename when a generated title arrives in a later pass', async () => {
    await write('named.jsonl', naming({ type: 'custom-title', customTitle: 'ui-trial-screen' }));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    await append('named.jsonl', naming({ type: 'ai-title', aiTitle: 'Generated title' }));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    expect((await fileRow('named')).display_name).toBe('ui-trial-screen');
  });

  it('records the first real user ask as the opening', async () => {
    await write('opened.jsonl',
      line('user', 'why did the reindex run out of memory?') +
      line('assistant', 'because the batch was sized by row count') +
      line('user', 'a later question'));

    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    expect((await fileRow('opened')).opening).toBe('why did the reindex run out of memory?');
  });

  it('resets naming when a file is rewritten', async () => {
    await write('named.jsonl', naming({ type: 'custom-title', customTitle: 'old-name' }) + line('user', 'a'));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    await write('named.jsonl', line('user', 'b'));  // shorter: a rewrite
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    expect((await fileRow('named')).display_name).toBeNull();
  });
});
```

Helpers for that file:

```typescript
const naming = (entry: Record<string, unknown>) => JSON.stringify(entry) + '\n';
const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

async function write(name: string, body: string) {
  await fs.writeFile(path.join(projectsDir, ENCODED_ROOT, name), body);
}
async function append(name: string, body: string) {
  await fs.appendFile(path.join(projectsDir, ENCODED_ROOT, name), body);
}
async function fileRow(sessionId: string) {
  const client = await openTranscriptDb(dbPath);
  return (await client.execute({
    sql: 'SELECT display_name, name_kind, opening FROM transcript_files WHERE session_id = ?',
    args: [sessionId],
  })).rows[0];
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/session-naming.test.ts`
Expected: FAIL — `readSessionNaming` is not exported.

- [ ] **Step 3: Add the columns**

In `src/transcripts/database.ts`, extend the `transcript_files` DDL in `TRANSCRIPT_SCHEMA_STATEMENTS`:

```sql
  CREATE TABLE IF NOT EXISTS transcript_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    bytes_indexed INTEGER NOT NULL DEFAULT 0,
    lines_indexed INTEGER NOT NULL DEFAULT 0,
    size_at_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    display_name TEXT,
    name_kind INTEGER NOT NULL DEFAULT 0,
    opening TEXT
  );
```

`CREATE TABLE IF NOT EXISTS` will not alter an existing table, so add an idempotent migration in the same bootstrap, after the create statements:

```typescript
/**
 * Add the naming columns to an index built before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a developer index from the
 * first transcript release has the old shape. Each column is added only if absent -- `ALTER
 * TABLE ADD COLUMN` throws on a duplicate and would fail every subsequent open.
 */
async function addNamingColumns(client: Client): Promise<void> {
  const columns = (await client.execute('PRAGMA table_info(transcript_files)')).rows
    .map(row => String(row.name));

  if (!columns.includes('display_name')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN display_name TEXT;');
  }
  if (!columns.includes('name_kind')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN name_kind INTEGER NOT NULL DEFAULT 0;');
  }
  if (!columns.includes('opening')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN opening TEXT;');
    // Existing rows are fully indexed, so nothing would ever re-read them to fill these in.
    // Resetting the watermark makes the next pass refill names and openings.
    await client.execute('UPDATE transcript_files SET bytes_indexed = 0, lines_indexed = 0, size_at_index = 0;');
  }
}
```

Call it from the writable branch of `openTranscriptDb`, after the schema statements.

- [ ] **Step 4: Recognise the naming entries**

In `src/transcripts/parse.ts`:

```typescript
/**
 * Name ranks. Higher wins, and a later entry only replaces an earlier one at the *same* rank
 * or above -- a generated title appended after a user's rename must not overwrite it.
 */
export const NAME_KIND = { none: 0, ai: 1, agent: 2, custom: 3 } as const;

export type SessionNaming =
  | { name: string; kind: number }
  | { opening: string };

/**
 * The naming information in one transcript entry, or null.
 *
 * Claude Code writes the session's own title into the transcript: `custom-title` when the user
 * renames it, `agent-name` for a subagent, `ai-title` for a generated one. Every shipped tool
 * surveyed for this feature ignores them and falls back to filenames or first prompts -- while
 * the user's own rename sits unread in the file.
 */
export function readSessionNaming(entry: unknown): SessionNaming | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;

  const named = (value: unknown, kind: number): SessionNaming | null => {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name ? { name, kind } : null;
  };

  if (record.type === 'custom-title') return named(record.customTitle, NAME_KIND.custom);
  if (record.type === 'agent-name') return named(record.agentName, NAME_KIND.agent);
  if (record.type === 'ai-title') return named(record.aiTitle, NAME_KIND.ai);
  return null;
}
```

`streamProseFrom` currently drops every non-prose line. It must now surface naming entries too, without turning them into messages. Add an optional callback rather than a second yield type, so no existing caller changes:

```typescript
export async function* streamProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
  /** Called for each naming entry seen. Ignored by callers that do not index session names. */
  onNaming?: (naming: SessionNaming) => void,
): AsyncGenerator<ProseChunk, ProseWatermark> {
```

Inside the parse block, after `extractProse` returns null, try `readSessionNaming(parsed)` and call `onNaming` when it matches. The opening ask is not a naming entry — it is the first prose message with `role === 'user'`, which the index pass already sees.

- [ ] **Step 5: Carry them into the watermark write**

In `src/transcripts/index-pass.ts`, `indexOneFile` collects the best name seen and the first user prose, then passes both into the file-row upsert. The rank comparison starts from the stored `name_kind`, not from zero:

```typescript
  // Seeded from what is already stored, not from zero: a second pass over an appended file
  // would otherwise let a rank-1 `ai-title` overwrite a rank-3 rename captured earlier.
  let bestName: string | null = state && !rewritten ? state.displayName : null;
  let bestKind = state && !rewritten ? state.nameKind : NAME_KIND.none;
  let opening: string | null = state && !rewritten ? state.opening : null;

  const iterator = streamProseFrom(file.path, from.bytes, from.lines, naming => {
    if ('opening' in naming) return;
    // `>=` so a later rename at the same rank wins, `>` alone would pin the first one.
    if (naming.kind >= bestKind) { bestName = naming.name; bestKind = naming.kind; }
  });
```

and where each prose chunk is pushed:

```typescript
    if (opening === null && next.value.message.role === 'user') {
      opening = next.value.message.text.slice(0, 300);
    }
```

Extend `FileState` and `readFileState` to select `display_name`, `name_kind` and `opening`, and extend both `transcript_files` upserts (in `commitBatchOn` and the final watermark write) to set them. The final write already uses `MAX(...)` for the watermark columns; the naming columns take `excluded` values directly, because the rank comparison already happened in memory.

The rewrite path in `indexOneFile` resets the watermark to zero; extend that same `UPDATE` to null `display_name` and `opening` and zero `name_kind`, or a rewritten file keeps a name that is no longer in it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/session-naming.test.ts`
Expected: PASS, 11 tests

Run: `npx vitest run tests/transcripts`
Expected: PASS — all existing transcript tests, unchanged. The callback is optional, so nothing else was touched.

- [ ] **Step 7: Verify against the real archive**

This step is not optional. The equivalent step in the transcript plan is what caught the `subagents/` nesting that three review rounds missed.

```bash
npx tsx -e "
import { runIndexPass } from './src/transcripts/index-pass.js';
import { openTranscriptDb } from './src/transcripts/database.js';
import { resolveStorage } from './src/store/storage-roles.js';
const dbPath = resolveStorage(process.cwd()).transcripts;
await runIndexPass({ projectRoot: process.cwd(), dbPath });
const client = await openTranscriptDb(dbPath);
const rows = (await client.execute('SELECT session_id, display_name, name_kind, opening FROM transcript_files ORDER BY name_kind DESC LIMIT 10')).rows;
console.table(rows);
"
```

Expected: at least some sessions carry a `display_name`, and any you renamed by hand show `name_kind = 3`. If every row is null, the entry types in this archive differ from the three above — find the real ones with `grep -h '\"type\"' <a transcript> | sort -u` before changing anything else.

- [ ] **Step 8: Commit**

```bash
git add src/transcripts/parse.ts src/transcripts/database.ts src/transcripts/index-pass.ts tests/transcripts/session-naming.test.ts
git commit -m "feat(transcripts): capture session names and opening asks during the index pass"
```

---

### Task 2: Derive a session's status without storing it

**Files:**
- Create: `src/transcripts/session-status.ts`
- Test: `tests/transcripts/session-status.test.ts`

**Interfaces:**
- Consumes: `getClient()` from `src/store/database.js` (the *knowledge* database — session bindings live there, not in `transcripts.db`)
- Produces:
  - `type SessionStatus = 'active' | 'interrupted' | 'idle'`
  - `deriveSessionStatuses(projectId: string, sessionIds: string[], now?: Date): Promise<Map<string, SessionStatus>>`

Three states, derived at read time and never stored — a stored status is wrong the moment the session it describes changes:

- **`interrupted`** — an unconsumed crash handoff names this session. There is unfinished business someone should know about.
- **`active`** — a live memory session with a recent heartbeat is bound to it.
- **`idle`** — everything else. `lastActiveAt` carries the rest of the story.

Finer tiers (working / stalled) were considered and rejected: their precondition is real-time observation, which a recall surface does not have.

**Note on the handoff query.** Real archives contain pre-tag handoffs that carry the session id only inside the content JSON, not in a tag. Match both, or older sessions never report `interrupted`.

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/session-status.test.ts`. Copy the `initDb` + `createProject` setup from an existing `tests/store/` test.

```typescript
describe('deriveSessionStatuses', () => {
  it('reports idle for a session with no signals', async () => {
    const statuses = await deriveSessionStatuses(projectId, ['session-quiet']);
    expect(statuses.get('session-quiet')).toBe('idle');
  });

  it('reports active for a recent bound heartbeat', async () => {
    await bindLiveSession('session-live', new Date());
    const statuses = await deriveSessionStatuses(projectId, ['session-live']);
    expect(statuses.get('session-live')).toBe('active');
  });

  it('reports idle for a bound session whose heartbeat is stale', async () => {
    await bindLiveSession('session-old', new Date(Date.parse('2026-08-01T00:00:00Z')));
    const statuses = await deriveSessionStatuses(projectId, ['session-old'], new Date(Date.parse('2026-08-03T00:00:00Z')));
    expect(statuses.get('session-old')).toBe('idle');
  });

  it('reports interrupted when an unconsumed crash handoff names the session', async () => {
    await storePendingHandoff('session-crashed', { tagged: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-crashed']);
    expect(statuses.get('session-crashed')).toBe('interrupted');
  });

  it('finds a pre-tag handoff that names the session only in its content', async () => {
    await storePendingHandoff('session-legacy', { tagged: false });
    const statuses = await deriveSessionStatuses(projectId, ['session-legacy']);
    expect(statuses.get('session-legacy')).toBe('interrupted');
  });

  it('ignores a handoff that was already consumed', async () => {
    await storePendingHandoff('session-done', { tagged: true, consumed: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-done']);
    expect(statuses.get('session-done')).toBe('idle');
  });

  it('ranks interrupted above active when both apply', async () => {
    await bindLiveSession('session-both', new Date());
    await storePendingHandoff('session-both', { tagged: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-both']);
    expect(statuses.get('session-both')).toBe('interrupted');
  });

  it('does one query for many sessions rather than one each', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    const statuses = await deriveSessionStatuses(projectId, ids);
    expect(statuses.size).toBe(50);
  });
});
```

Write `bindLiveSession` and `storePendingHandoff` against the real tables — read `src/store/host-session-bindings.ts` and `src/store/session-handoff.ts` and insert what they insert. Do not mock them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/session-status.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/session-status.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/session-status.ts`:

```typescript
import { getClient } from '../store/database.js';

export type SessionStatus = 'active' | 'interrupted' | 'idle';

/** How recent a heartbeat has to be for a bound session to count as live. */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * A status per session, derived and never stored.
 *
 * Storing it would be wrong the moment the session it describes changes, and this is a recall
 * surface: the answer only has to be true when it is read.
 *
 * `interrupted` outranks `active` deliberately. A session can be both -- bound and live, with an
 * unconsumed crash handoff naming it -- and the unfinished business is the more useful thing to
 * surface.
 *
 * One query per signal for the whole batch, not per session: a directory listing 60 sessions
 * would otherwise issue 120 round trips to answer one question.
 */
export async function deriveSessionStatuses(
  projectId: string,
  sessionIds: string[],
  now: Date = new Date(),
): Promise<Map<string, SessionStatus>> {
  const statuses = new Map<string, SessionStatus>(sessionIds.map(id => [id, 'idle']));
  if (sessionIds.length === 0) return statuses;

  const since = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
  const placeholders = sessionIds.map(() => '?').join(', ');

  const live = (await getClient().execute({
    sql: `SELECT external_session_id FROM host_session_bindings
          WHERE external_session_id IN (${placeholders}) AND last_seen_at >= ?`,
    args: [...sessionIds, since],
  })).rows;
  for (const row of live) statuses.set(String(row.external_session_id), 'active');

  // Two shapes on purpose. Newer handoffs carry `session:<id>` as a tag; pre-tag ones name the
  // session only inside the content JSON, and real archives contain both. Matching only the tag
  // silently reports every older session as idle.
  const handoffs = (await getClient().execute({
    sql: `SELECT tags, content FROM knowledge_items
          WHERE status = 'active' AND tags LIKE '%"pending_handoff"%'`,
    args: [],
  })).rows;

  for (const row of handoffs) {
    const tags = String(row.tags ?? '');
    const content = String(row.content ?? '');
    if (content.includes('"consumed":true')) continue;

    for (const id of sessionIds) {
      if (tags.includes(`session:${id}`) || content.includes(id)) statuses.set(id, 'interrupted');
    }
  }

  return statuses;
}
```

Read `host_session_bindings` in `src/store/bootstrap.ts` before writing the first query — use its real column names rather than the ones above if they differ.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/session-status.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/session-status.ts tests/transcripts/session-status.test.ts
git commit -m "feat(transcripts): derive session status from lifecycle signals at read time"
```

---

### Task 3: The session directory query

**Files:**
- Create: `src/transcripts/session-directory.ts`
- Test: `tests/transcripts/session-directory.test.ts`

**Interfaces:**
- Consumes: `openTranscriptDb` / `TranscriptIndexMissingError` (`src/transcripts/database.ts`), `deriveSessionStatuses` (Task 2), the naming columns (Task 1)
- Produces:
  ```typescript
  type SessionEntry = {
    sessionId: string;
    parentSessionId: string | null;
    name: string | null;
    opening: string | null;
    status: SessionStatus;
    messages: number;
    lastActiveAt: string | null;
    card: string | null;
    promoted: string[];
  };
  listSessionDirectory(input: {
    projectId: string;
    projectRoot: string;
    query?: string;
    limit?: number;
  }): Promise<{ sessions: SessionEntry[]; indexComplete: boolean }>
  ```

**Two enrichments a plain transcript viewer cannot offer:**

- **Promoted knowledge.** What each session put into memory, joined through `host_session_bindings → memory_sessions → promotion_items`. This is the one thing that makes a Knowl session directory different from `ls`.
- **Declared cards.** A session can state its own purpose by storing an atom tagged `session-card` + `session:<id>` through the ordinary `knowl_store`. Newest wins. Intent declaration costs no new tool.

**No session cap and no filtering-out of unnamed sessions.** The native `/resume` picker caps at 50 and hides unnamed sessions entirely — issues anthropics/claude-code #23375, #24435, #25130, #29052 and #35698 are all that behaviour. Unnamed sessions are described by their opening ask instead.

**Keyword filter matches intent fields only** — name, opening and card. For content questions the caller wants `knowl_transcript_search`; matching message bodies here would make the two tools indistinguishable.

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/session-directory.test.ts`:

```typescript
describe('listSessionDirectory', () => {
  it('lists sessions newest first with names from the transcript itself', async () => {
    await seedSession('older', { name: 'older-work', lastActive: '2026-08-01T00:00:00Z' });
    await seedSession('newer', { name: 'newer-work', lastActive: '2026-08-03T00:00:00Z' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions.map(s => s.sessionId)).toEqual(['newer', 'older']);
    expect(sessions[0].name).toBe('newer-work');
  });

  it('includes unnamed sessions, described by their opening ask', async () => {
    await seedSession('unnamed', { opening: 'why did the reindex run out of memory?' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeNull();
    expect(sessions[0].opening).toBe('why did the reindex run out of memory?');
  });

  it('answers "which session was about X" with a keyword filter', async () => {
    await seedSession('ui', { name: 'ui-trial-screen' });
    await seedSession('db', { name: 'database-migration' });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'ui' });

    expect(sessions.map(s => s.sessionId)).toEqual(['ui']);
  });

  it('matches the opening ask and the card, not message bodies', async () => {
    await seedSession('a', { opening: 'a question about caching' });
    await seedSession('b', { name: 'unrelated', messages: [{ role: 'user', text: 'caching appears only here' }] });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'caching' });

    expect(sessions.map(s => s.sessionId)).toEqual(['a']);
  });

  it('surfaces knowledge a session promoted, joined through the lifecycle chain', async () => {
    await seedSession('promoter', { name: 'promoter' });
    await seedPromotion('promoter', 'Size embedding batches by text length');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions[0].promoted).toContain('Size embedding batches by text length');
  });

  it('surfaces a declared session card and matches it in the filter', async () => {
    await seedSession('carded', { name: 'carded' });
    await seedCard('carded', 'Investigating the OOM in reindex');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot, query: 'OOM' });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].card).toBe('Investigating the OOM in reindex');
  });

  it('takes the newest card when a session declared more than one', async () => {
    await seedSession('carded', { name: 'carded' });
    await seedCard('carded', 'First intent', '2026-08-01T00:00:00Z');
    await seedCard('carded', 'Revised intent', '2026-08-03T00:00:00Z');

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions[0].card).toBe('Revised intent');
  });

  it('does not cap the number of sessions returned', async () => {
    for (let i = 0; i < 60; i++) await seedSession(`s-${i}`, { name: `session ${i}` });

    const { sessions } = await listSessionDirectory({ projectId, projectRoot });

    expect(sessions).toHaveLength(60);
  });

  it('reports an incomplete index rather than implying the list is whole', async () => {
    await seedSession('a', { name: 'a', bytesIndexed: 10, sizeAtIndex: 999 });

    const { indexComplete } = await listSessionDirectory({ projectId, projectRoot });

    expect(indexComplete).toBe(false);
  });

  it('returns nothing and reports incomplete when there is no index', async () => {
    const result = await listSessionDirectory({ projectId, projectRoot: emptyRoot });

    expect(result.sessions).toEqual([]);
    expect(result.indexComplete).toBe(false);
  });
});
```

`seedSession`, `seedPromotion` and `seedCard` write directly to the real tables. Read `src/store/candidate-promotion.ts` for the promotion chain's actual column names before writing `seedPromotion`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/session-directory.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/session-directory.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/session-directory.ts`. Shape:

1. Open `transcripts.db` **read-only**; on `TranscriptIndexMissingError` return `{ sessions: [], indexComplete: false }`.
2. Select one row per session from `transcript_files` joined to a message count and max timestamp from `transcript_messages`.
3. `indexComplete` is true only when every row has `bytes_indexed = size_at_index`.
4. Call `deriveSessionStatuses` once for the whole batch.
5. Load cards and promoted titles from the knowledge database in one query each.
6. Filter on name + opening + card only, case-insensitively, requiring every query token to appear somewhere across those three fields.
7. Sort by `lastActiveAt` descending, nulls last.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/session-directory.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/session-directory.ts tests/transcripts/session-directory.test.ts
git commit -m "feat(transcripts): a browsable session inventory joined with promoted knowledge"
```

---

### Task 4: The `knowl_session_list` MCP tool

**Files:**
- Modify: `src/transcripts/mcp-handlers.ts` (add `handleSessionList`)
- Modify: `src/mcp/tools.ts` (conditional tool list + dispatcher)
- Modify: `src/core/knowl-guidance.ts` (extend the transcript Route line)
- Test: `tests/transcripts/mcp-gating.test.ts`, `tests/transcripts/mcp-handlers.test.ts`

**Interfaces:**
- Consumes: `listSessionDirectory` (Task 3), `enabledConfig` and `clampInteger` (`src/transcripts/mcp-handlers.ts`)
- Produces: MCP tool `knowl_session_list`; `handleSessionList(input): Promise<string>`

Gated exactly like the other two: it appears in `tools/list` only when `search.transcripts.enabled` is true, and the handler re-checks per call and fails closed if either the captured or the on-disk config says disabled.

- [ ] **Step 1: Write the failing test**

Append to `tests/transcripts/mcp-gating.test.ts`, inside the existing `MCP surface` describe:

```typescript
  it('does not list knowl_session_list when disabled', async () => {
    expect(await toolNames(config(false))).not.toContain('knowl_session_list');
  });

  it('lists knowl_session_list when enabled', async () => {
    expect(await toolNames(config(true))).toContain('knowl_session_list');
  });

  it('refuses a session_list call when disabled', async () => {
    const response = await rpc(config(false), 'tools/call', {
      name: 'knowl_session_list', arguments: {},
    });
    expect(JSON.stringify(response.result ?? response.error)).toMatch(/not enabled/i);
  });
```

And append to `tests/transcripts/mcp-handlers.test.ts`:

```typescript
describe('handleSessionList', () => {
  it('renders each session with a locator-compatible id', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);

    const output = await handleSessionList({ config: config(), projectRoot: local.root, projectId });

    expect(output).toContain('session-abc');
    expect(output).toMatch(/idle|active|interrupted/);
  });

  it('says the index is still warming rather than implying the list is whole', async () => {
    const local = await makeRepo('local', line('content'), false);
    await markIndexIncomplete(local.root);

    expect(await handleSessionList({ config: config(), projectRoot: local.root, projectId }))
      .toMatch(/still warming/i);
  });

  it('refuses when the on-disk config says disabled', async () => {
    const local = await makeRepo('local', line('content'), false);
    await disableOnDisk(local.root);

    expect(await handleSessionList({ config: config(), projectRoot: local.root, projectId }))
      .toMatch(/not enabled/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/mcp-gating.test.ts tests/transcripts/mcp-handlers.test.ts`
Expected: FAIL — `handleSessionList` is not exported and the tool is not registered.

- [ ] **Step 3: Write the handler**

In `src/transcripts/mcp-handlers.ts`:

```typescript
export async function handleSessionList(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  projectId: string | null;
  query?: string;
  limit?: number;
}): Promise<string> {
  const { projectRoot, projectId } = input;
  if (!input.config || !projectRoot || !projectId) return DISABLED_MESSAGE;

  const config = await enabledConfig(projectRoot, input.config);
  if (!config) return DISABLED_MESSAGE;

  const limit = clampInteger(input.limit, 30, 1, 200);
  const { sessions, indexComplete } = await listSessionDirectory({
    projectId, projectRoot,
    query: input.query ? String(input.query).slice(0, MAX_QUERY_CHARS) : undefined,
    limit,
  });

  if (sessions.length === 0) {
    return indexComplete
      ? 'No sessions indexed for this project yet. Run `knowl reindex --transcripts`.'
      : 'No sessions yet. INDEX STILL WARMING - run again once it has caught up.';
  }

  const lines = sessions.map(session => {
    const name = session.name ?? '(unnamed)';
    const parent = session.parentSessionId ? ` (subagent of ${session.parentSessionId})` : '';
    const parts = [`${session.sessionId}  ${name}  [${session.status}]${parent}`];
    if (session.card) parts.push(`  card: ${session.card}`);
    if (session.opening) parts.push(`  opened: ${session.opening}`);
    if (session.promoted.length) parts.push(`  promoted: ${session.promoted.slice(0, 5).join('; ')}`);
    parts.push(`  ${session.messages} messages, last active ${session.lastActiveAt ?? 'unknown'}`);
    return parts.join('\n');
  });

  // A caller told nothing reads "no matches" as proof of absence. A partial index has to say so.
  if (!indexComplete) {
    lines.push('INDEX STILL WARMING - names and openings fill in as it catches up; run again for fuller coverage.');
  }
  lines.push('Read into a session with knowl_transcript_search using its sessionId.');

  return truncate(lines.join('\n\n'), MAX_RESPONSE_CHARS);
}
```

- [ ] **Step 4: Register and dispatch**

In `src/mcp/tools.ts`, inside the same `if (config && isTranscriptSearchEnabled(config))` block that adds the other two:

```typescript
        {
          name: 'knowl_session_list',
          description: "Browse this project's past Claude Code sessions as an inventory: best-known name (a user rename beats a generated title), the opening ask, status, any declared session card, last activity, and what each session promoted into memory. Use to answer 'which session was about X' or to choose between resuming and starting fresh - then knowl_transcript_search with that sessionId to read into it. Filters over intent only; for content questions use knowl_transcript_search.",
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', maxLength: 500, description: 'Keywords over session names, opening asks and declared cards. Omit to list newest first.' },
              limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum sessions; defaults to 30.' },
            },
          },
        },
```

Add the dispatcher branch beside the other two, passing `getProjectId()` through.

In `src/core/knowl-guidance.ts`, extend `TRANSCRIPT_ROUTE_LINE` to name the third tool. The compact card has a 2,000-character ceiling and was 1,885 with the transcript line; measure after the change and report it in the commit message. If it would exceed 2,000, shorten the existing transcript line rather than dropping the mention.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts`
Expected: PASS

Run: `npm test && npm run build && git diff --check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/mcp-handlers.ts src/mcp/tools.ts src/core/knowl-guidance.ts \
        tests/transcripts/mcp-gating.test.ts tests/transcripts/mcp-handlers.test.ts
git commit -m "feat(transcripts): expose knowl_session_list behind the enabled gate"
```

---

## Self-review notes

**PR coverage.** #8's unique work maps as: title precedence and opening capture → Task 1; status derivation and session cards → Tasks 2 and 3; promoted-knowledge join → Task 3; `knowl_session_list` → Task 4.

**Deliberately not ported.** `sessionFiles`, `encodeProjectDir`, `transcriptStores`, `ensureTranscriptIndex`, `transcriptIndexStats`, `searchTranscripts`, `readTranscriptEntry` and `tokenize` from PR #8's `session-directory.ts` are that PR's own copy of the storage layer this repo already has in `src/transcripts/`. Porting them would create a second transcript index alongside the shipped one.

**Two things to confirm rather than assume.** Task 1's Step 7 verifies the three naming entry types exist in a real archive before the feature is trusted — PR #8 observed them, but this repo's archive is the one that matters, and the transcript work already found one place where the real format differed from what a plan assumed. Task 2 says to read `host_session_bindings` and `candidate-promotion.ts` for real column names rather than trusting the queries sketched here.

**Verified, not assumed:** the three columns PR #8 adds (`display_name`, `name_kind`, `opening`) and their `ALTER TABLE` migration; the four-rank precedence (`custom-title` 3 > `agent-name` 2 > `ai-title` 1); that `main`'s `transcript_files` has none of them.
