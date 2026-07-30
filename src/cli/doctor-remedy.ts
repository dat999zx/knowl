/**
 * A doctor finding's fix, in a form code can execute.
 *
 * `DoctorCheck.fix` is prose for a human to read and run. Automating it meant matching
 * doctor's printed output with regular expressions, which turns every wording change into a
 * silently skipped repair. The prose stays; this is what `doctor --fix` and `upgrade --all`
 * dispatch on.
 *
 * Only findings with a genuinely safe automatic answer get one. Integrity errors, an empty
 * knowledge store and the MCP tool-surface checks deliberately have none: they need a person
 * or a new build, and pretending otherwise would let a sweep report a repo healthy when it
 * is not.
 */
export type DoctorRemedy =
  | { kind: 'guidance' }
  | { kind: 'gitignore' }
  | { kind: 'session-recover' }
  | { kind: 'reindex-vectors' }
  /** Re-run a host's registration. Only ever emitted for a host the repo already uses. */
  | { kind: 'host-init'; host: string };

/** Stable label for summaries and for de-duplicating remedies within one repo. */
export function remedyLabel(remedy: DoctorRemedy): string {
  return remedy.kind === 'host-init' ? `host-init:${remedy.host}` : remedy.kind;
}
