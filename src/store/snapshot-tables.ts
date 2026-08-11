/**
 * What `snapshot restore` does with each table, decided rather than derived.
 *
 * Restore is a partial operation. That is a design decision -- a store's sessions, host
 * bindings, code index and drift watermark describe the machine and working tree it is running
 * on right now, and rolling those back to a week ago would be wrong. But until this file
 * existed the split was not a decision, it was whatever a one-level foreign-key walk happened
 * to reach, which is how `knowledge_commit_items` came to be destroyed by a *successful*
 * restore and `evidence` came to be silently left at present-day values.
 *
 * Three states, and every table has exactly one:
 *
 * - `restored`  emptied and refilled from the snapshot. The knowledge graph and its history.
 * - `preserved` untouched. Describes the current host, working tree or operator intent, not
 *               the knowledge, so the snapshot's copy is not the truer one.
 * - `rebuilt`   derived data that regenerates itself as restored rows land -- the FTS shadow
 *               tables, which `bootstrap` maintains with triggers. Writing them directly would
 *               fight those triggers.
 *
 * `tests/store/snapshot-table-ownership.test.ts` fails when a table in a bootstrapped store is
 * missing from this map, so adding a table forces the decision instead of deferring it.
 */
export type SnapshotTablePolicy = 'restored' | 'preserved' | 'rebuilt';

export const SNAPSHOT_TABLE_POLICY: Readonly<Record<string, SnapshotTablePolicy>> = {
  // --- the knowledge graph and its history -------------------------------------------------
  knowledge_items: 'restored',
  knowledge_assertions: 'restored',
  evidence: 'restored',
  knowledge_evidence: 'restored',
  knowledge_access: 'restored',
  knowledge_commits: 'restored',
  // The commit-to-item index. Cascaded away with commits and never refilled before 3.0.2;
  // `compactKnowledgeCommits` documents that it is what makes blast radius an equality search.
  knowledge_commit_items: 'restored',
  skill_steps: 'restored',
  skill_metadata: 'restored',
  knowledge_embeddings: 'restored',

  // --- this machine, this working tree, this operator's intent -----------------------------
  // A tombstone records that someone deliberately deleted an item. Restoring older knowledge
  // is not a statement that they changed their mind, so the delete stands.
  knowledge_tombstones: 'preserved',
  // The forget log, for the tombstone's reason and one of its own. Restoring cannot un-delete
  // anything, so the record of what was destroyed still holds. The reason of its own is that
  // `restored` would empty it and refill it from the snapshot, erasing every deletion made
  // since -- which is precisely the window someone asking "was that threshold right?" is
  // asking about. An audit trail a restore can silently truncate is not one.
  knowledge_forget_log: 'preserved',
  // Sessions and their events belong to hosts that are running now. A restored session is a
  // session no host is in.
  memory_sessions: 'preserved',
  memory_session_events: 'preserved',
  host_session_bindings: 'preserved',
  // Watermarks for MCP calls made by the process that is running now.
  mcp_call_commits: 'preserved',
  // The code index describes the working tree on disk, which a restore does not touch.
  code_files: 'preserved',
  code_symbols: 'preserved',
  code_symbol_edges: 'preserved',
  // Last git commit the drift check ran against, keyed by project root. Git history is what
  // moves here, and a snapshot of the knowledge store says nothing about it.
  drift_state: 'preserved',
  // What sessions running *now* have read, and the findings filed against those reads. Both
  // describe live work against the working tree on disk, which a restore does not touch -- the
  // same reason `memory_sessions` and `code_files` are preserved. Restoring them would resurrect
  // one week-old session's beliefs about a file that has moved on since, and every one of those
  // rows is a candidate for interrupting whoever is working now.
  //
  // `impact_findings` has a second reason of its own: its `resolution` column is the adjudication
  // the certain tier's precision number is computed from. Rolling it back would silently restate
  // a measurement, which is worse than losing it.
  work_read_sets: 'preserved',
  impact_findings: 'preserved',
  // Same reason as `impact_findings`' own, one step further along: these rows are the measurement
  // the write gate is not allowed to start blocking without. A restore that rolled them back would
  // silently reset the precision denominator to zero while leaving the findings they point at in
  // place, so the next reading would be taken over a sample that no longer matches the history.
  impact_gate_shadow: 'preserved',
  // Capture health: turns produced and durable writes made, per conversation. Preserved on both
  // of the reasons above at once.
  //
  // It is a measurement, like `impact_gate_shadow`, and rolling it back would restate a number
  // somebody is deciding against -- a repo watching its silent-session rate to judge whether to
  // arm the nudge would see that rate jump on a restore that had nothing to do with capture.
  //
  // And it describes conversations that happened, like `memory_sessions`. A restore does not
  // un-hold them. `nudged` is the sharper case: it is a spent one-shot, and refilling this table
  // from a week-old snapshot would clear the flag on conversations that were already nudged --
  // re-arming a stop-blocking interrupt against sessions that had answered it.
  capture_outcomes: 'preserved',
  // What THIS machine has staged for, and pushed to, a cloud workspace. The server's copy is the
  // truer one and a snapshot cannot roll it back, so restoring an older ledger would only make
  // this machine forget the `remote_version` every republish needs -- turning the next publish
  // into a conflict -- or re-stage atoms the server already holds. Machine-local state, exactly
  // like `drift_state`.
  cloud_published: 'preserved',

  // --- derived, trigger-maintained ---------------------------------------------------------
  knowledge_items_fts: 'rebuilt',
  knowledge_items_fts_config: 'rebuilt',
  knowledge_items_fts_content: 'rebuilt',
  knowledge_items_fts_data: 'rebuilt',
  knowledge_items_fts_docsize: 'rebuilt',
  knowledge_items_fts_idx: 'rebuilt',
};

export function classifySnapshotTable(name: string): SnapshotTablePolicy | undefined {
  return SNAPSHOT_TABLE_POLICY[name];
}
