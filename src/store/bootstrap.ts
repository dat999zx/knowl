import { Client } from '@libsql/client';
import { DEFAULT_FRESHNESS, hashKnowledgeContent, normalizeAffectedPaths } from './freshness.js';
import {
  assertSchemaSupported, isMigrationCurrent, stampMigrationLevel, stampSchemaVersion,
} from './schema-version.js';
import { synchronousPragma } from '../core/sqlite-sync.js';

/**
 * Per-CONNECTION setup, and deliberately outside the version gate below.
 *
 * `busy_timeout` and `foreign_keys` are connection state, not file state: they are not
 * persisted, so every connection has to set them however current the schema is. Re-issuing
 * `journal_mode = WAL` on a file already in WAL is free -- measured lock-free against a held
 * write lock -- and WAL *is* persisted, so this is the one statement here that usually does
 * nothing. It stays because libsql does not default to WAL, and the version gate's cheap
 * lock-free read depends on being in WAL.
 */
function baseStatements(): string[] {
  return [
    // Must come first: journal_mode = WAL (and everything after it) takes locks, and a
    // connection's default busy_timeout is 0. Applied last, a concurrent writer at that
    // instant fails this whole bootstrap with SQLITE_BUSY instead of waiting for it.
    //
    // Matches the pool's own timeout rather than undercutting it: at 5000 this silently halved
    // the 10000 `acquireClient` had set moments earlier, for the life of the connection.
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA foreign_keys = ON;',
    'PRAGMA journal_mode = WAL;',
    // Chosen, not inherited -- libSQL leaves this at SQLite's default of FULL. See
    // `synchronousPragma` for the measurements, the durability trade, and the override.
    // A function rather than a const array so the value is read per open, not at import.
    synchronousPragma(),
  ];
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    alternatives TEXT,
    tags TEXT,
    source TEXT,
    source_commit TEXT,
    affected_paths TEXT,
    content_hash TEXT,
    freshness TEXT NOT NULL DEFAULT 'fresh',
    confidence REAL NOT NULL DEFAULT 1.0,
    tier TEXT NOT NULL DEFAULT 'asserted',
    tier_since TEXT,
    last_drift_at TEXT,
    provenance TEXT,
    conflict_key TEXT, conflict_scope TEXT, conflict_exclusive INTEGER NOT NULL DEFAULT 0,
    superseded_by_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
    item_id UNINDEXED,
    category UNINDEXED,
    status UNINDEXED,
    title,
    content,
    reasoning,
    tags
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_commits (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    changes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,

  /**
   * Which items each commit touched, so blast radius does not have to recover it by
   * substring match over the JSON that encodes it (K-48).
   *
   * An index over `knowledge_commits.changes`, not a second source of truth: it decides
   * which commits are worth opening, and every answer still comes out of `changes`. The
   * cascade matters -- an index row whose commit is gone is the shape corruption reads as.
   */
  `CREATE TABLE IF NOT EXISTS knowledge_commit_items (
    commit_id TEXT NOT NULL REFERENCES knowledge_commits(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL,
    PRIMARY KEY (commit_id, item_id)
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_assertions (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    recorded_at TEXT NOT NULL,
    replaced_at TEXT,
    confidence REAL NOT NULL,
    source_evidence_id TEXT REFERENCES evidence(id)
    ,conflict_key TEXT, conflict_scope TEXT, conflict_exclusive INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    locator TEXT NOT NULL,
    content_hash TEXT,
    excerpt TEXT,
    observed_at TEXT NOT NULL,
    metadata TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_evidence (
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL CHECK (relationship IN ('supports', 'contradicts', 'derived_from')),
    PRIMARY KEY (knowledge_item_id, evidence_id)
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_access (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    query_fingerprint TEXT,
    retrieved_at TEXT NOT NULL,
    surface TEXT NOT NULL,
    rank INTEGER NOT NULL,
    used INTEGER,
    useful INTEGER,
    caused_correction INTEGER
  );`,

  `CREATE TABLE IF NOT EXISTS memory_sessions (
    id TEXT PRIMARY KEY, agent TEXT, title TEXT NOT NULL, query TEXT, status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'failed', 'abandoned', 'recovered')),
    started_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL, finished_at TEXT, baseline_commit TEXT, expires_at TEXT NOT NULL,
    finalized_at TEXT, promotion_status TEXT NOT NULL DEFAULT 'pending', promotion_items TEXT, promotion_error_code TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS memory_session_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('start', 'command', 'test', 'error', 'git', 'decision', 'checkpoint', 'stop')),
    payload TEXT NOT NULL, observed_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS host_session_bindings (
    host TEXT NOT NULL, project_root TEXT NOT NULL, external_session_id TEXT NOT NULL, external_turn_id TEXT NOT NULL DEFAULT '',
    memory_session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), successful_tool_count INTEGER NOT NULL DEFAULT 0,
    seen_commit_rowid INTEGER NOT NULL DEFAULT 0, seen_commit_initialized INTEGER NOT NULL DEFAULT 0,
    seen_peer_commits TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (host, project_root, external_session_id, external_turn_id)
  );`,

  `CREATE TABLE IF NOT EXISTS mcp_call_commits (
    id TEXT PRIMARY KEY, project_root TEXT NOT NULL, tool_name TEXT NOT NULL,
    from_rowid INTEGER NOT NULL, to_rowid INTEGER NOT NULL, created_at TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_tombstones (
    id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    reason TEXT
  );`,

  /**
   * The forget log: what was true about an item at the instant it was destroyed. See
   * `forget-log.ts` for why this is not the tombstone -- the short version is that tombstones
   * ride in portable exports and merge by upsert, so usage numbers put there would both leak
   * off the machine and be overwritable by a peer.
   *
   * No foreign key to `knowledge_items` on purpose: the row it describes is already gone, and
   * `ON DELETE CASCADE` would destroy the record at the exact moment it became the only copy.
   * A TEXT id rather than AUTOINCREMENT, matching every other table here, so no
   * `sqlite_sequence` appears for `snapshot-table-ownership` to trip over.
   *
   * `origin_repo` is copied off the item rather than resolved from the caller's workspace,
   * because it answers "whose item was this" and not "who ran the collection". Several repos
   * share one database in workspace v2, so without it "which of MY items were taken" is not a
   * question this table can answer -- and the column has to exist from the start, since a row
   * written without it can never be attributed afterwards. NULL outside a workspace.
   */
  `CREATE TABLE IF NOT EXISTS knowledge_forget_log (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    tier TEXT,
    status TEXT,
    origin_repo TEXT,
    deleted_at TEXT NOT NULL,
    policy TEXT NOT NULL,
    reason TEXT NOT NULL,
    retrieval_count INTEGER NOT NULL DEFAULT 0,
    last_retrieved_at TEXT,
    age_days INTEGER,
    bytes INTEGER
  );`,

  `CREATE TABLE IF NOT EXISTS skill_steps (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    instruction TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS skill_metadata (
    knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    last_used TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    profile_fingerprint TEXT,
    dimensions INTEGER NOT NULL,
    vector TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS code_files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS code_symbols (locator TEXT PRIMARY KEY, file_path TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE, qualified_name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, signature_hash TEXT);`,
  `CREATE TABLE IF NOT EXISTS code_symbol_edges (from_locator TEXT NOT NULL, to_locator TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_locator, to_locator, kind));`,

  // Last git commit the automatic drift check ran against, per project root. Git history is
  // the thing that moves here, so a knowledge-commit rowid watermark cannot track it.
  `CREATE TABLE IF NOT EXISTS drift_state (
    project_root TEXT PRIMARY KEY,
    last_checked_commit TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );`,

  /**
   * What a session actually read, and the hash of it AT READ TIME.
   *
   * The one thing this store has never had. The per-tool path stream is already captured
   * (`host-hook.ts` -> `session-capture.ts`), but nothing keys a path to a locator, hashes it
   * at the moment of the read, or scopes it to live work -- so "has anything I relied on moved
   * since I looked at it" is currently unanswerable, and every staleness check has to fall back
   * to path/title matching over the whole store.
   *
   * Filled from that captured stream and never from an agent reporting its own reads.
   * CooperBench measures agents defecting from their own stated commitments 32% of the time,
   * so nothing load-bearing may depend on an agent declaring anything about itself.
   *
   * `observed_hash` is NOT NULL because it is the entire mechanism. A row without the hash as
   * of the read cannot answer the only question the table exists to answer, and a nullable
   * column is an invitation for the capture path to write those rows silently and for the
   * detector to read their absence as "unchanged".
   *
   * No CHECK on `locator`, deliberately: the shape hazard is real -- `Grep` carries a `path`
   * argument through the stdin filter, so it can emit a *directory* where every other tool
   * emits a file -- but rejecting it belongs at insert, where the caller can be told which
   * tool produced the bad locator. A CHECK would only turn that into an opaque SQLITE_CONSTRAINT
   * inside a best-effort capture path that swallows it.
   *
   * No foreign key to `memory_sessions` either. Sessions expire and are collected on their own
   * schedule, and a cascade would take the read-set with them -- but a released read-set is the
   * evidence that a finding was justified, which is the denominator precision is computed
   * against. It is swept by GC on its own terms instead of vanishing with its session.
   *
   * `released_at` NULL means live work; release happens at task-finish and session-stop. An
   * unreleased row makes a historical read look like something an agent is still relying on,
   * which is a false positive -- and tool-side false positives are the expensive kind, measured
   * at ~20.8% mean accuracy cost against the agent that receives them.
   */
  `CREATE TABLE IF NOT EXISTS work_read_sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    locator TEXT NOT NULL,
    observed_hash TEXT NOT NULL,
    tool_name TEXT,
    read_at TEXT NOT NULL,
    released_at TEXT
  );`,

  /**
   * One detected impact: something changed, and something that depended on it may now be wrong.
   *
   * Recorded whether or not anybody is told about it. That is the design, not an implementation
   * detail: notification is measured at approximately zero effect twice independently
   * (SWE-Touch finds an explicit announcement of a conflicting edit no better than the silent
   * edit, and worse for 3 of 4 models; CooperBench finds communication halves conflicts and
   * moves end-to-end success by an amount that is not statistically significant). What the
   * record buys is a gate that reads it and a number that counts it.
   *
   * `resolution` is the column this table is really for. Every finding is adjudicated --
   * 'repaired' | 'dismissed' | 'expired' | 'false_positive' -- which is what gives precision a
   * denominator: 1 - false_positive/total. Nobody in this space publishes that number; STORM
   * rejects 19-33% of writes and never evaluates whether the rejections were correct. It has to
   * be a column or it does not exist.
   *
   * `affected_id` carries no foreign key because `affected_kind` decides which table it points
   * into -- 'knowledge' is a `knowledge_items` id, 'work' is a `work_read_sets` id. The cost is
   * that a deleted target leaves an orphan row rather than cascading, which is survivable
   * precisely because a finding is never re-read once resolved.
   *
   * `tier` ('certain' | 'likely' | 'possible') decides delivery, not merely wording: only
   * 'certain' may push and gate, everything softer is pull-only. `drift-auto.ts` already runs
   * the 'possible' tier with `apply: false` and already refuses to act on it, having measured
   * one commit window matching 36/301 atoms and fifteen windows matching a third of the store.
   * This column is that judgment made explicit instead of hard-coded into one call site.
   *
   * `path_json` holds the edge chain that justified the finding, and is nullable because the
   * certain tier has no chain: the session read that exact locator and there is nothing to
   * explain.
   *
   * `delivered_at` is what stops the card repeating. Without it the mid-turn stanza re-renders
   * every open finding on every tool event until somebody adjudicates it, and the only column that
   * could have quieted it is `resolution` -- which is the adjudication the precision number is
   * computed from, so spending `dismissed` to silence a card would corrupt the one measurement
   * this phase exists to produce. Delivery and adjudication are different facts and now have
   * different columns: the card stamps this one and stops showing the finding, while `resolution`
   * stays NULL and the finding stays open for the gate and for the denominator.
   */
  `CREATE TABLE IF NOT EXISTS impact_findings (
    id TEXT PRIMARY KEY,
    cause_locator TEXT NOT NULL,
    cause_session TEXT,
    affected_kind TEXT NOT NULL,
    affected_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    path_json TEXT,
    detected_at TEXT NOT NULL,
    delivered_at TEXT,
    resolution TEXT,
    resolved_at TEXT
  );`,

  /**
   * What this machine has staged for, and pushed to, a cloud workspace.
   *
   * Publication is deliberately NOT a third value of `visibility` (decision `ee191dd7db024bec`):
   * `repo` and `workspace` describe who may read an item on this machine, and folding "the
   * company can read it" into that column would make one field answer two unrelated questions,
   * with no way to be at workspace visibility locally and unpublished remotely.
   *
   * Two-phase, matching git's index-then-commit. `staged_at` records an intent, formed on any
   * branch at any time; `pushed_at` records that the server accepted it. `staged_on_branch` sits
   * between them because the push is gated on the default branch and the refusal has to be able
   * to say what it is waiting for -- an atom staged on a feature branch describes code nobody
   * else has yet, and there is no unpublish.
   *
   * `remote_version` is the only place on this machine that the server's version number lives,
   * and every republish needs it: a republish with no `expectedVersion` is treated as a conflict
   * deliberately, so an older client cannot acquire overwrite rights by not knowing the field
   * exists.
   *
   * The primary key is `(item_id, remote_workspace)` because one atom can in principle be
   * published to more than one workspace, and a version from one is meaningless to the other.
   */
  `CREATE TABLE IF NOT EXISTS cloud_published (
    item_id TEXT NOT NULL,
    remote_workspace TEXT NOT NULL,
    remote_version INTEGER,
    staged_at TEXT NOT NULL,
    staged_on_branch TEXT,
    pushed_at TEXT,
    retracted_at TEXT,
    PRIMARY KEY (item_id, remote_workspace)
  );`,

  `CREATE INDEX IF NOT EXISTS idx_ki_cat_status ON knowledge_items(category, status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_status ON knowledge_items(status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_updated ON knowledge_items(updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path);`,
  `CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_target ON code_symbol_edges(to_locator);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_item_validity ON knowledge_assertions(knowledge_item_id, valid_from, valid_to);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_recorded ON knowledge_assertions(recorded_at);`,
  `CREATE INDEX IF NOT EXISTS idx_ke_model ON knowledge_embeddings(provider, model);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_locator ON evidence(locator);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence(type);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_observed ON evidence(observed_at);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_relationship ON knowledge_evidence(relationship);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_access_item_time ON knowledge_access(knowledge_item_id, retrieved_at);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_access_fingerprint ON knowledge_access(query_fingerprint);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_sessions_status_heartbeat ON memory_sessions(status, last_heartbeat_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_sessions_expiry ON memory_sessions(expires_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_session_events_expiry ON memory_session_events(expires_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_session_events_session ON memory_session_events(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_call_commits_lookup ON mcp_call_commits(project_root, tool_name, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_host_session_bindings_memory ON host_session_bindings(memory_session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_host_session_bindings_session ON host_session_bindings(host, project_root, external_session_id, active);`,
  // The lookup blast radius actually makes: "which commit inserted this item". Covering, so
  // the plan never has to touch the table itself.
  `CREATE INDEX IF NOT EXISTS idx_knowledge_commit_items_item ON knowledge_commit_items(item_id, action, commit_id);`,

  // The detector's query, and the one that has to be cheap: a write lands on exactly one
  // locator, and the question is who holds an unreleased read of it. `locator` leads because
  // that is the equality the write supplies; `released_at` trails so the live rows for a
  // locator are a contiguous range rather than a filter applied over every read the project
  // has ever recorded. Without it this runs per tool call over a table that only grows, which
  // is the shape the plan already identifies as fatal on a per-call path.
  `CREATE INDEX IF NOT EXISTS idx_work_read_sets_locator ON work_read_sets(locator, released_at);`,
  // Everything one session still holds. Serves the release path as much as the read path:
  // task-finish and session-stop rewrite a whole session's read-set at once, and that is a
  // range scan on this index rather than a table scan per row.
  `CREATE INDEX IF NOT EXISTS idx_work_read_sets_session ON work_read_sets(session_id, released_at);`,
  // The write gate's query -- "does this session have unresolved findings at the tier allowed to
  // block" -- which runs in `PreToolUse` in front of every write, with a user waiting on the tool
  // call behind it. That is a far hotter path than the task-finish gate this index was first
  // written for, so the seek matters more now, not less.
  //
  // `resolution` leads rather than `tier` because open-ness is the prefix every caller shares:
  // the gate adds `tier = 'certain'`, and the pull tool takes tier as an *optional* filter, so
  // a tier-first index would leave the unfiltered pull to a scan. `resolution IS NULL` seeks an
  // index in SQLite exactly as an equality does, so an open finding is a seek and not a filter.
  //
  // The trailing pair makes it covering for the join that resolves a finding to the session
  // that owns it: `affected_id` reaches the read-set row by primary key from here, so the gate
  // never touches the findings table itself.
  `CREATE INDEX IF NOT EXISTS idx_impact_findings_open ON impact_findings(resolution, tier, affected_kind, affected_id);`,
  // The other direction, which detection uses on every candidate: given a thing -- a read-set
  // row, a knowledge item -- is there already an open finding against it? Re-reporting the same
  // impact is not a duplicate row problem, it is a repeated notice into a channel whose noise
  // is measured at ~20.8% mean accuracy cost, so this lookup happens before every insert and
  // must not be a scan.
  `CREATE INDEX IF NOT EXISTS idx_impact_findings_affected ON impact_findings(affected_kind, affected_id, resolution);`,
  // The closing move on the duplicate-notice window `detectCertainImpact` opens. Detection checks
  // for an open finding and then inserts, which is not atomic across processes: two hooks firing on
  // the same file in the same instant each see nothing open and each insert, and the cost is not a
  // wasted row but the same notice pushed into the same agent's context twice. Partial, on
  // `resolution IS NULL`, because the constraint is only wanted while a finding is open -- the same
  // pair may legitimately be found again after the first was adjudicated, which is a re-detection
  // and not a duplicate. `INSERT OR IGNORE` at the call site turns the losing race into a no-op
  // rather than an exception inside a best-effort path.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_findings_unique_open ON impact_findings(cause_locator, affected_id) WHERE resolution IS NULL;`,

  // What an enforcing write gate *would* have refused, recorded while it is refusing nothing.
  //
  // The gate is the one part of this subsystem that can cost somebody their working session, so
  // plan §9 puts a ≥95%-precision-over-≥40-findings bar in front of letting it block. Shadow mode
  // is how that bar is measured: the verdict is computed for real, the refusal is withheld, and
  // every withheld refusal lands here.
  //
  // No `resolution` column of its own, deliberately. Each row names a finding, and findings
  // already carry the adjudication through `knowl_impact({resolve})` -- which plan §15 established
  // is the *only* adjudication path, precisely because the gate leaves findings open by design. A
  // second verdict column here would be a second answer to a question that already has one.
  `CREATE TABLE IF NOT EXISTS impact_gate_shadow (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );`,
  // One row per stale belief, and this index is what makes the measurement mean anything.
  //
  // Shadow mode deliberately does *not* release the read-set rows it names. Enforcing mode does,
  // so a retry is never blocked twice -- safe there, because the agent has been told to re-read.
  // Doing it while merely observing would clear a belief nobody re-read, and `work_read_sets`
  // would stop describing what the session holds while being the evidence this measurement rests
  // on. So the belief stays live, and the same finding comes back on the next write to that file.
  // Unconstrained, the row count would then measure *writes attempted* rather than *denials an
  // enforcing gate would have issued*, and those differ by however many times an agent happens to
  // edit one file.
  //
  // `finding_id` alone, not `(finding_id, read_set_id)`: a finding's `affected_id` already *is*
  // the read-set row id -- `detectCertainImpact` writes `affectedId: entry.id` from the row it
  // compared, and `openFindingsForSession` joins `work_read_sets w ON w.id = f.affected_id`. One
  // finding is therefore one stale belief, and a stored read-set id would be a second copy of a
  // value that can only ever disagree with its source.
  //
  // `session_id` is kept even though that same join reaches it, and this is the one place the
  // denormalization earns itself: `sweepReadSets` hard-deletes released rows, so after GC the join
  // returns nothing and the owning session is unrecoverable. Findings are not swept by that path,
  // so the measurement survives -- but only if the session is recorded where GC cannot reach it.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_gate_shadow_finding ON impact_gate_shadow(finding_id);`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ai AFTER INSERT ON knowledge_items BEGIN
    INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    VALUES (new.id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
  END;`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ad AFTER DELETE ON knowledge_items BEGIN
    DELETE FROM knowledge_items_fts WHERE item_id = old.id;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_au AFTER UPDATE ON knowledge_items BEGIN
    DELETE FROM knowledge_items_fts WHERE item_id = old.id;
    INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    VALUES (new.id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
  END;`,

  `INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    SELECT id, category, status, title, content, coalesce(reasoning, ''), coalesce(tags, '')
    FROM knowledge_items
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items_fts LIMIT 1)
      AND EXISTS (SELECT 1 FROM knowledge_items LIMIT 1);`,
];

function unwrapJson(value: unknown): unknown {
  let current = value;
  while (typeof current === 'string') {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function stripProjectFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripProjectFields);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'projectId' || key === 'project_id') continue;
    normalized[key] = stripProjectFields(entry);
  }
  return normalized;
}

function normalizeCommitChanges(value: unknown): string {
  return JSON.stringify(stripProjectFields(unwrapJson(value)));
}

function parseStringArray(value: unknown): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : null;
  } catch {
    return null;
  }
}

async function executeAll(client: Client, statements: string[]) {
  for (const statement of statements) {
    await client.execute(statement);
  }
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [name],
  });
  return result.rows.length > 0;
}

async function tableColumns(client: Client, name: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${name})`);
  return result.rows.map(row => String(row.name));
}

async function dropLegacySearchArtifacts(client: Client) {
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_ai;');
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_ad;');
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_au;');
  await client.execute('DROP TABLE IF EXISTS knowledge_items_fts;');
}

async function foreignKeyTargets(client: Client, table: string): Promise<string[]> {
  if (!(await tableExists(client, table))) {
    return [];
  }

  const rows = await client.execute(`PRAGMA foreign_key_list(${table})`);
  return rows.rows.map(row => String(row.table));
}

async function repairSkillForeignKeys(client: Client): Promise<void> {
  const staleSteps = (await foreignKeyTargets(client, 'skill_steps'))
    .some(target => target !== 'knowledge_items');
  const staleMetadata = (await foreignKeyTargets(client, 'skill_metadata'))
    .some(target => target !== 'knowledge_items');

  if (!staleSteps && !staleMetadata) {
    return;
  }

  await client.execute('PRAGMA foreign_keys = OFF;');

  if (staleSteps) {
    await client.execute('ALTER TABLE skill_steps RENAME TO skill_steps_stale_fk;');
    await client.execute(`CREATE TABLE skill_steps (
      id TEXT PRIMARY KEY,
      knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    await client.execute(`
      INSERT INTO skill_steps (id, knowledge_item_id, step_order, instruction, created_at)
      SELECT id, knowledge_item_id, step_order, instruction, created_at
      FROM skill_steps_stale_fk;
    `);
    await client.execute('DROP TABLE skill_steps_stale_fk;');
  }

  if (staleMetadata) {
    await client.execute('ALTER TABLE skill_metadata RENAME TO skill_metadata_stale_fk;');
    await client.execute(`CREATE TABLE skill_metadata (
      knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );`);
    await client.execute(`
      INSERT INTO skill_metadata (knowledge_item_id, usage_count, success_count, last_used)
      SELECT knowledge_item_id, usage_count, success_count, last_used
      FROM skill_metadata_stale_fk;
    `);
    await client.execute('DROP TABLE skill_metadata_stale_fk;');
  }

  await client.execute('PRAGMA foreign_keys = ON;');
}

/**
 * Tier (standing earned by use) and provenance (how the knowledge came to be believed).
 * Existing rows get tier 'asserted' -- nothing has confirmed them here -- and provenance
 * NULL, which is what a row written before the class existed means.
 */
async function ensureQualityColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) return;
  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('tier')) {
    await client.execute("ALTER TABLE knowledge_items ADD COLUMN tier TEXT NOT NULL DEFAULT 'asserted';");
  }
  if (!columns.includes('tier_since')) {
    // Left NULL rather than backfilled to now: an existing row has never had its standing
    // reset, so every confirmation it already carries still belongs to its current tier.
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN tier_since TEXT;');
  }
  if (!columns.includes('provenance')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN provenance TEXT;');
  }
}

async function ensureFreshnessColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) {
    return;
  }

  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('source_commit')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN source_commit TEXT;');
  }
  if (!columns.includes('affected_paths')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN affected_paths TEXT;');
  }
  if (!columns.includes('content_hash')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN content_hash TEXT;');
  }
  if (!columns.includes('last_drift_at')) {
    // Left NULL rather than backfilled: an existing row has no recorded drift observation,
    // and inventing one would refuse promotion for items nothing has actually contradicted.
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN last_drift_at TEXT;');
  }
  if (!columns.includes('freshness')) {
    await client.execute(`ALTER TABLE knowledge_items ADD COLUMN freshness TEXT NOT NULL DEFAULT '${DEFAULT_FRESHNESS}';`);
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_ki_freshness ON knowledge_items(freshness);');

  await client.execute(`UPDATE knowledge_items SET freshness = '${DEFAULT_FRESHNESS}' WHERE freshness IS NULL OR freshness = '';`);

  const rows = await client.execute(`
    SELECT id, title, content, reasoning, source, affected_paths
    FROM knowledge_items
    WHERE content_hash IS NULL OR content_hash = '';
  `);

  for (const row of rows.rows) {
    const affectedPaths = normalizeAffectedPaths(parseStringArray(row.affected_paths));
    await client.execute({
      sql: 'UPDATE knowledge_items SET content_hash = ?, affected_paths = ? WHERE id = ?',
      args: [
        hashKnowledgeContent({
          title: String(row.title),
          content: String(row.content),
          reasoning: row.reasoning ? String(row.reasoning) : null,
          source: row.source ? String(row.source) : null,
          affectedPaths,
        }),
        affectedPaths ? JSON.stringify(affectedPaths) : null,
        String(row.id),
      ],
    });
  }
}

async function ensureConflictColumns(client: Client): Promise<void> {
  for (const table of ['knowledge_items', 'knowledge_assertions']) {
    const columns = await tableColumns(client, table);
    if (!columns.includes('conflict_key')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_key TEXT;`);
    if (!columns.includes('conflict_scope')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_scope TEXT;`);
    if (!columns.includes('conflict_exclusive')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_exclusive INTEGER NOT NULL DEFAULT 0;`);
  }
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_conflict_active ON knowledge_items(conflict_key, conflict_scope, status, conflict_exclusive);');
}

/**
 * Ownership and visibility for multi-repo workspaces.
 *
 * Created unconditionally. bootstrapSchema receives only a client -- no root, no config --
 * so it cannot know whether a workspace exists, which makes "create these only when one
 * does" inexpressible. Outside a workspace origin_repo stays NULL and visibility stays
 * 'repo', which is exactly today's behavior; the columns cost one page and keep a single
 * code path instead of a tableExists guard on every read.
 */
async function ensureOwnershipColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) return;
  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('origin_repo')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN origin_repo TEXT;');
  }
  if (!columns.includes('visibility')) {
    await client.execute("ALTER TABLE knowledge_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'repo';");
  }
  // Lifecycle fingerprint, added here rather than in its own migration because it covers
  // origin_repo and visibility and would otherwise have to run after them anyway. Left NULL
  // for existing rows: a NULL local hash reads as "unknown", and `classifyIncomingItem`
  // treats an incoming hash against a NULL local one as divergent, so the first export that
  // carries one converges the row. Backfilling here would need every row's lifecycle fields
  // read and hashed in SQL, which SQLite cannot do.
  if (!columns.includes('lifecycle_hash')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN lifecycle_hash TEXT;');
  }
  // A NOT NULL default does not apply retroactively to rows written before the column
  // existed, and SQLite backfills an added NOT NULL column with its default only for the
  // ALTER itself -- a row inserted by an older client into an older table can still be null.
  await client.execute("UPDATE knowledge_items SET visibility = 'repo' WHERE visibility IS NULL OR visibility = '';");
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_items_origin ON knowledge_items(origin_repo, visibility, status);');
}

async function ensureMemorySessionColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'memory_sessions'))) return;
  const columns = await tableColumns(client, 'memory_sessions');
  if (!columns.includes('finalized_at')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN finalized_at TEXT;');
  if (!columns.includes('promotion_status')) await client.execute("ALTER TABLE memory_sessions ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'pending';");
  if (!columns.includes('promotion_items')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_items TEXT;');
  if (!columns.includes('promotion_error_code')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_error_code TEXT;');
}

async function ensureHostSessionBindingColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'host_session_bindings'))) return;
  const columns = await tableColumns(client, 'host_session_bindings');
  if (!columns.includes('successful_tool_count')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN successful_tool_count INTEGER NOT NULL DEFAULT 0;');
  }
  if (!columns.includes('seen_commit_rowid')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_commit_rowid INTEGER NOT NULL DEFAULT 0;');
  }
  // Carries what overloading `seen_commit_rowid = 0` used to: whether this row's watermark
  // has ever been set. Rows migrated here default to 0 and so adopt head on their first
  // tool event rather than reporting all history as new -- while a session legitimately
  // bound at zero commits is now marked initialized and does report its first commit.
  if (!columns.includes('seen_commit_initialized')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_commit_initialized INTEGER NOT NULL DEFAULT 0;');
  }
  // JSON map of peer repo name -> that peer's last seen commit rowid. Nullable rather
  // than defaulted to '{}': NULL means "never looked at peers", which adopts their heads
  // silently, exactly as seen_commit_rowid = 0 does for the local repo.
  if (!columns.includes('seen_peer_commits')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_peer_commits TEXT;');
  }
}

/**
 * Backfills with the repository's current profile fingerprint, which is by
 * definition the profile that produced the existing rows -- nothing else could
 * have written them.
 *
 * A null fingerprint means the caller could not read config. The column is still
 * added, because the alternative is a schema that varies by whether config parsed;
 * existing rows stay NULL and the next reindex replaces them.
 */
async function ensureEmbeddingProfileColumns(client: Client, fingerprint: string | null): Promise<void> {
  if (!(await tableExists(client, 'knowledge_embeddings'))) return;
  const columns = await tableColumns(client, 'knowledge_embeddings');
  if (!columns.includes('profile_fingerprint')) {
    await client.execute('ALTER TABLE knowledge_embeddings ADD COLUMN profile_fingerprint TEXT;');
    if (fingerprint) {
      await client.execute({
        sql: 'UPDATE knowledge_embeddings SET profile_fingerprint = ? WHERE profile_fingerprint IS NULL',
        args: [fingerprint],
      });
    }
  }
  await client.execute('CREATE INDEX IF NOT EXISTS idx_ke_profile ON knowledge_embeddings(profile_fingerprint);');
}

async function ensureCodeIndexColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'code_symbols'))) return;
  const columns = await tableColumns(client, 'code_symbols');
  if (!columns.includes('signature_hash')) await client.execute('ALTER TABLE code_symbols ADD COLUMN signature_hash TEXT;');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_target ON code_symbol_edges(to_locator);');
}

async function backfillKnowledgeAssertions(client: Client): Promise<void> {
  await client.execute(`INSERT INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id)
    SELECT lower(hex(randomblob(8))), id, content, created_at, NULL, updated_at, NULL, confidence, NULL
    FROM knowledge_items
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_assertions WHERE knowledge_item_id = knowledge_items.id);`);
}

/**
 * Index every commit already on disk, so an existing history is not half-covered.
 *
 * Blast radius falls back to the old scan for a commit it finds no index rows for, which
 * makes a missing row cost speed rather than a sibling -- but a store that never ran this
 * would take that fallback forever and the index would buy nothing. It runs once, inside the
 * migration transaction, gated on the version like everything else here.
 *
 * The parse happens in SQL-adjacent JS rather than with `json_each` because `changes` is
 * written by this codebase and has been through several shapes; a row that will not parse is
 * skipped and keeps the fallback, which is the same contract the readers already have.
 */
async function backfillCommitItems(client: Client): Promise<void> {
  const rows = (await client.execute(
    `SELECT commits.id AS id, commits.changes AS changes FROM knowledge_commits commits
     WHERE NOT EXISTS (SELECT 1 FROM knowledge_commit_items WHERE commit_id = commits.id)`,
  )).rows;

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.changes));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    // Deduplicated here rather than left to the primary key: one commit legitimately carries
    // several changes to one item, and INSERT OR IGNORE would hide a real collision too.
    const seen = new Set<string>();
    for (const change of parsed as Array<Record<string, unknown>>) {
      const itemId = typeof change?.itemId === 'string' ? change.itemId : null;
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      await client.execute({
        sql: 'INSERT OR IGNORE INTO knowledge_commit_items (commit_id, item_id, action) VALUES (?, ?, ?)',
        args: [String(row.id), itemId, String(change?.action ?? 'unknown')],
      });
    }
  }
}

async function migrateLegacyProjectSchema(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) {
    return;
  }

  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('project_id')) {
    return;
  }

  await client.execute('PRAGMA foreign_keys = OFF;');
  await dropLegacySearchArtifacts(client);

  await client.execute('ALTER TABLE knowledge_items RENAME TO knowledge_items_legacy;');

  const hasLegacyCommits = await tableExists(client, 'knowledge_commits');
  if (hasLegacyCommits) {
    await client.execute('ALTER TABLE knowledge_commits RENAME TO knowledge_commits_legacy;');
  }

  const hasLegacyEmbeddings = await tableExists(client, 'knowledge_embeddings');
  if (hasLegacyEmbeddings) {
    await client.execute('ALTER TABLE knowledge_embeddings RENAME TO knowledge_embeddings_legacy;');
  }

  const hasLegacySkillSteps = await tableExists(client, 'skill_steps');
  if (hasLegacySkillSteps) {
    await client.execute('ALTER TABLE skill_steps RENAME TO skill_steps_legacy;');
  }

  const hasLegacySkillMetadata = await tableExists(client, 'skill_metadata');
  if (hasLegacySkillMetadata) {
    await client.execute('ALTER TABLE skill_metadata RENAME TO skill_metadata_legacy;');
  }

  await executeAll(client, SCHEMA_STATEMENTS);

  await client.execute(`
    INSERT INTO knowledge_items (
      id, category, status, title, content, reasoning, alternatives, tags, source,
      confidence, superseded_by_id, version, created_at, updated_at
    )
    SELECT
      id, category, status, title, content, reasoning, alternatives, tags, source,
      confidence, superseded_by_id, version, created_at, updated_at
    FROM knowledge_items_legacy;
  `);

  if (hasLegacyCommits) {
    const commits = await client.execute('SELECT id, message, changes, created_at FROM knowledge_commits_legacy ORDER BY created_at ASC;');
    for (const row of commits.rows) {
      await client.execute({
        sql: 'INSERT INTO knowledge_commits (id, message, changes, created_at) VALUES (?, ?, ?, ?)',
        args: [
          String(row.id),
          String(row.message),
          normalizeCommitChanges(row.changes),
          String(row.created_at),
        ],
      });
    }
  }

  if (hasLegacyEmbeddings) {
    await client.execute(`
      INSERT INTO knowledge_embeddings (
        knowledge_item_id, provider, model, dimensions, vector, updated_at
      )
      SELECT knowledge_item_id, provider, model, dimensions, vector, updated_at
      FROM knowledge_embeddings_legacy;
    `);
  }

  if (hasLegacySkillSteps) {
    await client.execute(`
      INSERT INTO skill_steps (
        id, knowledge_item_id, step_order, instruction, created_at
      )
      SELECT id, knowledge_item_id, step_order, instruction, created_at
      FROM skill_steps_legacy;
    `);
  }

  if (hasLegacySkillMetadata) {
    await client.execute(`
      INSERT INTO skill_metadata (
        knowledge_item_id, usage_count, success_count, last_used
      )
      SELECT knowledge_item_id, usage_count, success_count, last_used
      FROM skill_metadata_legacy;
    `);
  }

  await client.execute('DROP TABLE knowledge_items_legacy;');
  if (hasLegacyCommits) {
    await client.execute('DROP TABLE knowledge_commits_legacy;');
  }
  if (hasLegacyEmbeddings) {
    await client.execute('DROP TABLE knowledge_embeddings_legacy;');
  }
  if (hasLegacySkillSteps) {
    await client.execute('DROP TABLE skill_steps_legacy;');
  }
  if (hasLegacySkillMetadata) {
    await client.execute('DROP TABLE skill_metadata_legacy;');
  }
  await client.execute('DROP TABLE IF EXISTS projects;');
  await client.execute('PRAGMA foreign_keys = ON;');
}

/**
 * Directly bootstraps the schema using SQL commands.
 * This keeps the binary self-contained and free from file migration dependencies.
 */
/**
 * Bring the schema up to date, at most once across every process on the machine.
 *
 * **The steady-state open path is read-only.** That is the whole design. Knowl runs one
 * process per connected session plus whatever is started from a terminal, and every one of
 * them used to run this in full: a legacy migration, ~40 `CREATE TABLE IF NOT EXISTS`, ten
 * `PRAGMA table_info` + conditional `ALTER TABLE` passes, and two data repairs. Measured,
 * most of that is genuinely free -- SQLite compiles a no-op `CREATE TABLE IF NOT EXISTS` to
 * a *read* transaction, so it takes no lock at all. Two things were not free: the assertion
 * backfill, whose `INSERT..SELECT` takes a write lock before it knows it will insert nothing,
 * and (already fixed) an unconditional version stamp.
 *
 * But cost was never the real defect. **The ten column passes are check-then-act across
 * processes.** Two processes that both observe a column missing both issue the `ALTER`, and
 * the loser dies on `duplicate column name` -- a `SQLITE_ERROR`, invisible to `busy_timeout`
 * and unreachable by any BUSY retry. Reproduced against this code at 1 in 96 cold-start
 * opens with twelve processes racing. It fires exactly when a column is genuinely absent:
 * the first opens after an upgrade adds one, which is precisely when many sessions restart
 * at once.
 *
 * So: read the migration level first (an O(1) header read, lock-free in WAL) and do nothing
 * at all when it is current. Only a database that actually needs work takes a lock, and it is
 * `BEGIN IMMEDIATE` -- never `DEFERRED`, which upgrades a read transaction to a write one
 * and is answered with `SQLITE_BUSY_SNAPSHOT` that no busy handler is allowed to wait out.
 * The level is re-read *under* the lock, so processes that queued behind the winner see
 * the finished work and leave. Measured over eight racing processes: IMMEDIATE elects one
 * migrator and the other seven skip cleanly; DEFERRED killed seven of eight; no election at
 * all applied the migration eight times.
 *
 * The gate is `KNOWL_MIGRATION_LEVEL` and not `KNOWL_SCHEMA_VERSION` because those two
 * numbers answer different questions -- "has my migration run here" versus "can an older
 * build read this file" -- and only the second is allowed to lock anyone out. Both are
 * stamped inside the transaction below; see schema-version.ts.
 *
 * Everything, stamps included, commits as one transaction, so a process killed mid-migration
 * leaves the database exactly as it found it.
 */
export async function bootstrapSchema(
  client: Client,
  options: { profileFingerprint?: string | null } = {},
): Promise<void> {
  // Connection state, not file state -- every connection needs these however current the
  // schema is, so they sit outside the gate. All three are free when nothing changes.
  await executeAll(client, baseStatements());

  // Before any migration touches the file. Running migrateLegacyProjectSchema against a
  // database written by a newer Knowl is the case this exists to prevent.
  await assertSchemaSupported(client, '(open database)');

  if (await isMigrationCurrent(client)) return;

  // Exactly one migrator. IMMEDIATE takes the write lock up front rather than upgrading into
  // it, which is what makes the losers wait politely instead of failing.
  await client.execute('BEGIN IMMEDIATE');
  try {
    // The winner may have finished while this process waited for the lock. Re-reading here
    // is what turns a queue of migrators into a queue of no-ops.
    if (await isMigrationCurrent(client)) {
      await client.execute('COMMIT');
      return;
    }

    // `PRAGMA foreign_keys` is silently IGNORED inside a transaction -- verified, it still
    // reads 1 after being set to 0 -- so the table rebuilds below cannot use it here.
    // `defer_foreign_keys` is the in-transaction equivalent: enforcement is postponed to
    // COMMIT, which also means an inconsistent rebuild fails loudly instead of persisting.
    await client.execute('PRAGMA defer_foreign_keys = ON;');

    await migrateLegacyProjectSchema(client);
    await executeAll(client, SCHEMA_STATEMENTS);
    await ensureFreshnessColumns(client);
    await ensureQualityColumns(client);
    await ensureConflictColumns(client);
    await ensureOwnershipColumns(client);
    await ensureMemorySessionColumns(client);
    await ensureHostSessionBindingColumns(client);
    await ensureCodeIndexColumns(client);
    await ensureEmbeddingProfileColumns(client, options.profileFingerprint ?? null);
    await backfillKnowledgeAssertions(client);
    await backfillCommitItems(client);
    await repairSkillForeignKeys(client);
    // The compatibility floor first, then the gate. Order matters only if the process dies
    // between them, and the whole block is one transaction, so it cannot.
    await stampSchemaVersion(client);
    await stampMigrationLevel(client);

    await client.execute('COMMIT');
  } catch (error) {
    // Best-effort: if the transaction is already gone the rollback throws, and surfacing
    // that instead of the real failure would hide why the migration died.
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  }
}
