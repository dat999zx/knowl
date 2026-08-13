import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { withClientTransaction } from './database.js';
import * as repo from './repository.js';
import type { CommitChange, KnowledgeFreshness, KnowledgeItem } from '../core/types.js';
import { knowledgeMentionsChangedPath, normalizePathForKnowledge } from './freshness.js';
import { listEvidenceForItem, resolveSymbolEvidence } from './evidence-repository.js';

export interface SymbolEvidenceDrift {
  locator: string;
  suggestedLocator?: string;
}

/**
 * What kind of drift this is, which decides whether it is worth anyone's attention.
 *
 * `changed` is the class that used to be everything. Measured on this repo's store, 226 of 339
 * observations were a cited file that had merely been edited -- most often the highest-churn files
 * in the tree -- and a file being edited says nothing about whether an atom is still true. Those
 * are dropped rather than reported, on the same reasoning that took DocPrism's documentation
 * flag rate from 98% to 14%: name the benign category and discard it.
 */
export type DriftKind = 'removed' | 'symbol-removed' | 'untracked-moved' | 'changed';

export interface DriftCandidate {
  itemId: string;
  title: string;
  freshness: KnowledgeFreshness;
  matchedPaths: string[];
  /** Cited paths that are no longer in the tree. The evidence the candidate rests on. */
  removedPaths: string[];
  kind: DriftKind;
  symbolEvidence?: SymbolEvidenceDrift[];
}

/**
 * Paths whose changing carries no information about whether an atom is still true.
 *
 * Not a heuristic about importance -- a lockfile bump is a real change -- but about *aboutness*.
 * These were the most-cited paths among flagged items in the measured store (`package.json` 28,
 * `README.md` 23, `CHANGELOG.md` 14) because they change on nearly every release, so they
 * generated drift on a schedule rather than on an event.
 */
const CHURN_PATH =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG\.md|README\.md)$|^(\.github|dist|build|coverage)\//;

export function isChurnPath(candidate: string): boolean {
  return CHURN_PATH.test(normalizePathForKnowledge(candidate));
}

/**
 * Split cited paths into the ones that are gone and the ones that merely moved underneath.
 *
 * Existence is injected rather than read here so the rule is testable without a tree, and so the
 * caller can answer from git's index -- which it has already loaded -- instead of one `stat` per
 * path per item.
 */
export function classifyDriftPaths(
  citedPaths: string[],
  exists: (candidate: string) => boolean,
  movedFrom: ReadonlySet<string> = new Set(),
): { removed: string[]; changed: string[]; moved: string[] } {
  const removed: string[] = [];
  const changed: string[] = [];
  const moved: string[] = [];
  for (const candidate of citedPaths) {
    if (exists(candidate)) changed.push(candidate);
    // Checked before "removed", because a rename leaves the old path absent from the tree and is
    // otherwise indistinguishable from a deletion by existence alone.
    else if (movedFrom.has(candidate)) moved.push(candidate);
    else removed.push(candidate);
  }
  return { removed, changed, moved };
}

export interface DriftCheckResult {
  sinceCommit: string;
  currentCommit: string | null;
  changedFiles: string[];
  candidates: DriftCandidate[];
  updatedCount: number;
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

export function getCurrentGitCommit(projectRoot: string): string | null {
  try {
    return runGit(['rev-parse', 'HEAD'], projectRoot);
  } catch {
    return null;
  }
}

export function listChangedFilesSince(projectRoot: string, sinceCommit: string, currentCommit?: string | null): string[] {
  const range = currentCommit ? `${sinceCommit}..${currentCommit}` : sinceCommit;
  const output = runGit(['diff', '--name-only', range], projectRoot);
  if (!output) return [];
  return Array.from(new Set(
    output
      .split(/\r?\n/)
      .map(line => normalizePathForKnowledge(line.trim()))
      .filter(Boolean)
  ));
}

/**
 * The paths a rename moved *away from*, over the same range the changed-file list covers.
 *
 * Rename detection has to come from a whole-tree diff. `git log -- <path>` limits the diff to that
 * pathspec, which hides the destination and reports every rename as a plain delete -- the mistake
 * that made the first audit of this rule report zero renames when 30 of 44 flagged items were
 * renames.
 *
 * Best-effort: a git failure yields an empty set, which degrades to treating moves as deletions.
 * That is the old, noisier behaviour rather than a broken drift check.
 */
export function listRenamedPathsSince(
  projectRoot: string,
  sinceCommit: string,
  currentCommit?: string | null,
): Set<string> {
  const range = currentCommit ? `${sinceCommit}..${currentCommit}` : sinceCommit;
  const sources = new Set<string>();
  let output: string;
  try {
    output = runGit(['diff', '--name-status', '-M', range], projectRoot);
  } catch {
    return sources;
  }
  for (const line of output.split(/\r?\n/)) {
    const match = /^R\d*\t(.+?)\t(.+)$/.exec(line.trim());
    if (match) sources.add(normalizePathForKnowledge(match[1]));
  }
  return sources;
}

function matchedPaths(item: KnowledgeItem, changedFiles: string[]): string[] {
  return changedFiles.filter(changedFile => knowledgeMentionsChangedPath(item, [changedFile]));
}

/** What git tracks: the files themselves, and every directory that contains one. */
type TrackedPaths = { files: Set<string>; directories: Set<string> };

/**
 * Every path git tracks, as one call rather than one per affected path.
 *
 * `directories` is derived once here rather than scanned per lookup. The obvious way to ask
 * "does this prefix contain a tracked file" is to iterate the file set, but that runs inside a
 * loop over every affected path of every item, which is O(items x paths x trackedFiles) and
 * quietly turns a session-start check into a scan of the whole index.
 *
 * Returns null when git cannot answer at all — a missing binary, or a directory that is not a
 * checkout. Null means "unknown", which the caller must treat as "check nothing", because
 * assuming an empty set would make every path look untracked and flag the entire store.
 */
function listTrackedPaths(projectRoot: string): TrackedPaths | null {
  try {
    const output = runGit(['ls-files'], projectRoot);
    const files = new Set(
      output.split(/\r?\n/).map(line => normalizePathForKnowledge(line.trim())).filter(Boolean),
    );
    const directories = new Set<string>();
    for (const file of files) {
      let cursor = file;
      for (let slash = cursor.lastIndexOf('/'); slash > 0; slash = cursor.lastIndexOf('/')) {
        cursor = cursor.slice(0, slash);
        // Every ancestor of an already-seen file is also already recorded, so stop climbing.
        if (directories.has(cursor)) break;
        directories.add(cursor);
      }
    }
    return { files, directories };
  } catch {
    return null;
  }
}

/**
 * Affected paths that git cannot report on, which moved after the item was last written.
 *
 * WHY THIS EXISTS. `listChangedFilesSince` is `git diff --name-only`, so the whole drift check
 * sees TRACKED files and nothing else. An atom whose `affectedPaths` name an untracked or
 * ignored directory is therefore unwatchable: the check runs, finds nothing, and reports the
 * atom fresh forever.
 *
 * Measured 2026-08-12, and it is not hypothetical. A state atom recording "STILL OPEN: final
 * atmosphere pick" pointed at `experiments/reskin/` — a working directory that is deliberately
 * not in git. The question was settled days later, the directory changed constantly throughout,
 * the atom was never revised, and a later session read it and believed the question was still
 * open. Every existing defence missed it for its own structural reason; this one missed because
 * the signal source cannot see the files.
 *
 * DIRECTORY MTIME IS DELIBERATELY SHALLOW. A directory's mtime moves when entries are added or
 * removed, not when a file inside is edited, and this does NOT walk the tree to find out. The
 * atom above pointed at a directory that grew 489 MB of new subdirectories, so the shallow
 * signal catches it, while a recursive walk of exactly that directory is what makes the check
 * too expensive to run at every session start. A deep edit inside an untracked directory with a
 * stable entry list is the accepted blind spot.
 *
 * Compared against `updatedAt`, so revising an atom clears its own drift.
 */
function untrackedPathsChangedSince(
  item: KnowledgeItem,
  projectRoot: string,
  tracked: TrackedPaths | null,
): string[] {
  if (!tracked) return [];
  const writtenAt = Date.parse(item.updatedAt);
  if (!Number.isFinite(writtenAt)) return [];

  const moved: string[] = [];
  for (const affectedPath of item.affectedPaths || []) {
    const normalized = normalizePathForKnowledge(affectedPath);
    if (!normalized) continue;
    // A path git tracks is already the git diff's job; checking it here would double-report it
    // and, worse, report it on every run rather than only within the commit window.
    if (tracked.files.has(normalized)) continue;
    // A directory containing a tracked file is a real source directory, not a working area,
    // so `git diff` covers what happens inside it.
    if (tracked.directories.has(normalized)) continue;

    try {
      const stats = statSync(path.resolve(projectRoot, normalized));
      if (stats.mtimeMs > writtenAt) moved.push(normalized);
    } catch {
      // Absent is not moved. A deleted path is a different finding and this check does not
      // make it, because an atom naming a path that never existed would otherwise flag forever.
    }
  }
  return moved;
}

function symbolPath(locator: string): string | null {
  const match = /^symbol:\/\/(.+)#/.exec(locator);
  return match ? normalizePathForKnowledge(match[1]) : null;
}

export async function checkKnowledgeDrift(
  projectId: string,
  options: {
    sinceCommit: string;
    currentCommit?: string | null;
    changedFiles: string[];
    apply?: boolean;
    /**
     * The tree to answer "does this cited path still exist?" against, which is what separates a
     * removal from an edit. Without it nothing can be classified and every matched path is
     * reported, which is the old behaviour and the noisy one.
     */
    projectRoot?: string;
    /**
     * Also examine affected paths git cannot diff -- untracked or ignored directories an atom
     * names. Split out from `projectRoot` on 2026-08-13: classification needs the tree on every
     * run, while this scan remains the deliberate opt-in it always was, so that the automatic
     * session-start check could gain the first without silently acquiring the second.
     */
    includeUntracked?: boolean;
    /**
     * Paths a rename moved away from in this window, from `listRenamedPathsSince`.
     *
     * Without it a moved file is indistinguishable from a deleted one by existence alone, and
     * every atom citing the old path reports as though the code had been removed. Audited on this
     * repo's store, that was **30 of 44** flagged items -- one refactor moving `src/store/` files
     * into `src/session/` accounted for most of them, and every one of those atoms was still true.
     */
    renamedFrom?: ReadonlySet<string>;
  }
): Promise<DriftCheckResult> {
  const items = (await repo.listKnowledgeItems())
    .filter(item => item.status === 'active');
  // One git call for the whole run, not one per item per path.
  const tracked = options.projectRoot ? listTrackedPaths(options.projectRoot) : null;

  /**
   * Does this cited path still exist? Git's index answers for everything it tracks, which is one
   * lookup rather than one `stat`; the filesystem is the fallback for paths git does not track,
   * so an ignored-but-present directory is not mistaken for a deletion.
   */
  const projectRoot = options.projectRoot;
  const exists = projectRoot
    ? (candidate: string): boolean => {
      if (tracked?.files.has(candidate) || tracked?.directories.has(candidate)) return true;
      try {
        statSync(path.join(projectRoot, candidate));
        return true;
      } catch {
        return false;
      }
    }
    : null;
  const entries = await Promise.all(items.map(async item => {
    const evidence = await listEvidenceForItem(item.id);
    const symbolEvidence = (await Promise.all(evidence
      .filter(entry => entry.type === 'symbol')
      .map(async entry => ({ entry, resolution: await resolveSymbolEvidence(entry) }))))
      .filter(({ resolution }) => resolution.stale)
      .map(({ entry, resolution }) => ({ locator: entry.locator, suggestedLocator: resolution.suggestedLocator }));
    const symbolPaths = symbolEvidence
      .map(entry => symbolPath(entry.locator))
      .filter((entry): entry is string => Boolean(entry));
    /**
     * Kept apart from the git-derived paths, because it is a different question with its own
     * precision. The untracked check asks "has a directory this atom names moved *since the atom
     * was written*", comparing mtime against `updated_at`, and it only runs when a caller opts in.
     * That time-scoping is what the removal rule below supplies for git paths, so applying the
     * rule here as well would discard a signal that had already earned its place.
     */
    const untrackedPaths = options.includeUntracked && options.projectRoot
      ? untrackedPathsChangedSince(item, options.projectRoot, tracked)
      : [];
    const gitPaths = Array.from(new Set([
      ...matchedPaths(item, options.changedFiles),
      ...symbolPaths.filter(entry => options.changedFiles.includes(entry)),
    ]));
    const paths = Array.from(new Set([...gitPaths, ...untrackedPaths]));
    // Churn first, so a path that carries no information cannot make an item look removed either.
    const informative = gitPaths.filter(candidate => !isChurnPath(candidate));
    const classified = exists
      ? classifyDriftPaths(informative, exists, options.renamedFrom)
      : null;
    return { item, matchedPaths: paths, untrackedPaths, classified, symbolEvidence };
  }));

  /**
   * What survives.
   *
   * A stale symbol is already a resolved "the thing this cites is not there any more", so it
   * stands on its own. Otherwise the item needs a cited path that has gone. An item whose files
   * were merely edited is dropped -- that was 226 of 339 observations, and reporting it is what
   * made the whole signal unreadable.
   *
   * With no tree to check against, nothing can be classified and the old behaviour stands. That
   * is deliberately the noisy direction: silently reporting less than before would be a worse
   * failure than reporting too much.
   */
  const candidates = entries.filter(entry => {
    if (entry.symbolEvidence.length > 0) return true;
    if (entry.untrackedPaths.length > 0) return true;
    if (!entry.classified) return entry.matchedPaths.length > 0;
    return entry.classified.removed.length > 0;
  });

  let updatedCount = 0;
  if (options.apply && candidates.length > 0) {
    const changes: CommitChange[] = [];

    // Client-level, not db.transaction: see withClientTransaction for the measurement. This
    // runs on every session hook via `runAutoDriftCheckBestEffort`, inside the long-lived MCP
    // server, so it is one of the paths that can actually reach the wrapper's ceiling.
    await withClientTransaction(async tx => {
      for (const candidate of candidates) {
        if (candidate.item.freshness === 'needs_review') {
          continue;
        }

        const updated = await repo.updateKnowledgeItem(candidate.item.id, {
          freshness: 'needs_review',
        }, undefined, tx);
        changes.push({
          itemId: candidate.item.id,
          action: 'update',
          before: candidate.item,
          after: updated,
        });
      }

      if (changes.length > 0) {
        await repo.createKnowledgeCommit(
          projectId,
          `Mark knowledge drift since ${options.sinceCommit}`,
          changes,
          tx
        );
      }
    });

    updatedCount = changes.length;
  }

  return {
    sinceCommit: options.sinceCommit,
    currentCommit: options.currentCommit || null,
    changedFiles: options.changedFiles,
    updatedCount,
    candidates: candidates.map(candidate => {
      const removedPaths = candidate.classified?.removed ?? [];
      return {
        itemId: candidate.item.id,
        title: candidate.item.title,
        freshness: options.apply ? 'needs_review' as const : candidate.item.freshness,
        matchedPaths: candidate.matchedPaths,
        removedPaths,
        // Strongest claim first: a removal names the candidate even when a stale symbol came with
        // it. `changed` is reachable only where nothing could be classified at all.
        kind: (removedPaths.length > 0
          ? 'removed'
          : candidate.symbolEvidence.length > 0
            ? 'symbol-removed'
            : candidate.untrackedPaths.length > 0 ? 'untracked-moved' : 'changed') as DriftKind,
        ...(candidate.symbolEvidence.length > 0 ? { symbolEvidence: candidate.symbolEvidence } : {}),
      };
    }),
  };
}
