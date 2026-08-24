/**
 * Event-shaped capture signals: a destructive command that just ran, and a prompt that reads
 * as the user correcting the agent.
 *
 * These exist because nothing else inspects the event. Every storage cue in the guidance is a
 * taxonomy of nouns, and the two kinds of knowledge these detect -- "I damaged the
 * environment" and "the user had to correct me" -- map to none of them, which is exactly why
 * they get apologised for in chat and never stored. The cue approach has been patched twice
 * before (stated intent, recurring diagnoses; see `knowl-guidance.ts`), each time by adding
 * the noun whose absence had already cost a measured miss. A detector on the event itself is
 * the first fix that does not need the *next* miss to learn the next noun.
 *
 * Pure functions over text, in `core` so both the CLI hook layer and the store can reach
 * them. Tuned for PRECISION over recall throughout: every pattern here can spend a turn of
 * somebody's session, and a gate that cries wolf is a gate that gets switched off. The narrow
 * forms of each operation -- kill by PID, delete with a WHERE, rm -rf on a build dir -- are
 * exempted by design, so doing it the right way never trips anything.
 */

export type DestructiveCommandId =
  'process-kill-broad' | 'git-discard' | 'git-rewrite-remote' | 'recursive-delete' | 'container-destroy' | 'db-destructive';

export type DestructiveCommandHit = { id: DestructiveCommandId; label: string };

/**
 * One place the classes are named. The stop gate renders lessons from a stored `class` column
 * long after the hit object is gone, so a second list over there drifts from this one -- it
 * already had.
 */
export const DESTRUCTIVE_LABELS: Readonly<Record<DestructiveCommandId, string>> = {
  'process-kill-broad': 'a process kill with a broad selector (name, image, filter or pipeline)',
  'git-discard': 'a git command that discards uncommitted work',
  'git-rewrite-remote': 'a git command that rewrites shared history or force-deletes a branch',
  'recursive-delete': 'a recursive force-delete outside build or scratch directories',
  'container-destroy': 'a container or image force-removal',
  'db-destructive': 'a destructive database statement',
};

const hit = (id: DestructiveCommandId): DestructiveCommandHit => ({ id, label: DESTRUCTIVE_LABELS[id] });

/**
 * Quoted spans collapse to a placeholder before any verb is matched, because the measured
 * false positives were all mentions rather than commands: a `pkill` inside an agent prompt's
 * quoted argument, `git reset --hard` inside a PR body, a correction phrase inside a pasted
 * bug report. The placeholder carries no separators, so a newline inside a quoted body cannot
 * fabricate a segment that starts with a verb.
 */
const maskQuoted = (text: string): string => text
  .replace(/```[\s\S]*?```/g, ' __fence__ ')
  .replace(/"(?:[^"\\]|\\.)*"/g, ' __q__ ')
  .replace(/'(?:[^'\\]|\\.)*'/g, ' __q__ ');

/**
 * A verb only counts at command position: the start of a segment, where segments are cut at
 * the separators a shell actually honours. Found the hard way (and re-found by review): a
 * bare word-boundary match reads any command that TALKS about killing as a kill, and a
 * whole-string read-only exemption reads `ls && rm -rf src` as an `ls`.
 */
const SEGMENT_SEPARATOR = /\r?\n|;|&&|\|\||\||\(|\b(?:then|do|else)\b/gi;

/** Wrappers that put the real command one token later. Stripped repeatedly: `sudo timeout 5 pkill`. */
const COMMAND_WRAPPER = /^(?:sudo|command|npx|timeout\s+\d+[a-z]*|env(?:\s+\w+=\S+)*)\s+/i;

/** A segment that only reads or prints must not arm anything -- investigating a incident mentions its command. */
const READ_ONLY_HEAD = /^(?:grep|rg|ag|ack|findstr|sls|select-string|cat|type|head|tail|less|more|echo|printf|ls|dir|which|where|write-host|get-\w+|git\s+(?:log|show|diff|grep|status|blame))\b/i;

/** Programs whose arguments are prose or patches, never executed SQL. */
const SQL_EXEMPT_HEAD = /^(?:claude|codex|cursor|aider|gemini|gh|git|echo|printf)\b/i;

/**
 * Build artefacts and scratch space: blowing these away is routine, not a lesson.
 *
 * Both boundaries are load-bearing and both were wrong once. A leading separator is
 * OPTIONAL: `rm -rf dist` is how the clean is actually written, and requiring `/dist` made
 * the most common safe delete there is fire. A trailing one is REQUIRED, so `/var/dist-data`
 * is not read as the build directory. Tested per SEGMENT, never against the whole command --
 * the whole-string form is the same defect as a whole-string read-only exemption, and it let
 * `rm -rf dist && rm -rf ~/live` off entirely.
 */
const SAFE_RM_TARGET = /(?:^|[\s\\/])(?:node_modules|dist|build|out|target|coverage|\.next|\.turbo|\.cache|\.vite|\.tmp[^\\/\s]*|te?mp|scratchpad|\.knowl-[\w-]*test)(?:[\\/]|\s|$)/i;

/** `-n` / `--dry-run` means nothing happened, so nothing was learned. Segment-scoped. */
const DRY_RUN = /(?:^|\s)(?:--dry-run|-[a-z]*n)\b/i;

const rmFlagsRecursiveForce = (segment: string): boolean => {
  if (!/^rm\s/i.test(segment)) return false;
  const flags = segment.match(/(?:^|\s)-[a-zA-Z]+/g)?.join('') ?? '';
  return /r/i.test(flags) && /f/i.test(flags);
};

function segments(command: string): Array<{ masked: string; original: string }> {
  const masked = maskQuoted(command);
  const maskedSegs = masked.split(SEGMENT_SEPARATOR).map(s => s.trim()).filter(Boolean);
  const originalSegs = command.split(SEGMENT_SEPARATOR).map(s => s.trim()).filter(Boolean);
  // Pairing by index only holds when quoting hid no separators; when it did, the original
  // split is wrong by construction, so the masked segment stands in for both sides. The SQL
  // class loses quoted statement bodies in that case, which is the precision-preserving
  // direction to lose in.
  const paired = maskedSegs.map((seg, i) => ({
    masked: seg,
    original: maskedSegs.length === originalSegs.length ? originalSegs[i] : seg,
  }));
  return paired.map(pair => {
    let masked = pair.masked;
    let original = pair.original;
    for (let strip = 0; strip < 3; strip += 1) {
      const next = masked.replace(COMMAND_WRAPPER, '');
      if (next === masked) break;
      original = original.replace(COMMAND_WRAPPER, '');
      masked = next;
    }
    return { masked, original };
  });
}

/**
 * Which class of irreversible command this is, or null. One verdict per command -- the first
 * matching segment names it, which is enough for a nudge that fires once per class anyway.
 */
export function classifyDestructiveCommand(command: string): DestructiveCommandHit | null {
  const text = String(command ?? '');
  if (!text.trim()) return null;

  for (const { masked, original } of segments(text)) {
    if (READ_ONLY_HEAD.test(masked)) continue;

    // Stop-Process without -Id is a name or pipeline match: it takes every process that fits
    // the predicate, which is exactly the shape that has already destroyed a live session.
    if ((/^stop-process\b/i.test(masked) && !/-id\b/i.test(original))
      || (/^taskkill\b/i.test(masked) && /\/(?:im|fi)\b/i.test(original))
      || /^(?:pkill|killall)\b/i.test(masked)
      || /^pm2\s+(?:kill|delete)\b/i.test(masked)) {
      return hit('process-kill-broad');
    }

    if (/^git\s+reset\s+(?:--hard|--merge)\b/i.test(masked)
      || (/^git\s+clean\s+-[a-z]*[fdx]/i.test(masked) && !DRY_RUN.test(original))
      || /^git\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/i.test(masked)
      || /^git\s+stash\s+(?:drop|clear)\b/i.test(masked)
      || (/^git\s+worktree\s+remove\b/i.test(masked) && /(?:--force\b|\s-f\b)/i.test(original))) {
      return hit('git-discard');
    }

    if ((/^git\s+push\b/i.test(masked) && /(?:--force(?!-with-lease)\b|\s-f\b)/i.test(original))
      || /^git\s+branch\s+(?:\S+\s+)*-D\b/.test(masked)
      || (/^git\s+(?:rebase|filter-branch)\b/i.test(masked) && /--(?:root|force-rebase|all)\b/i.test(original))) {
      return hit('git-rewrite-remote');
    }

    if ((rmFlagsRecursiveForce(masked)
      || (/^remove-item\b/i.test(masked) && /-recurse\b/i.test(original) && /-force\b/i.test(original))
      || (/^rmdir\b/i.test(masked) && /\/s\b/i.test(original))
      || (/^del\b/i.test(masked) && /\/s\b/i.test(original)))
      && !SAFE_RM_TARGET.test(original)) {
      return hit('recursive-delete');
    }

    if ((/^docker\s+(?:rm|rmi)\b/i.test(masked) && /(?:\s-f\b|--force\b)/i.test(original))
      || /^docker\s+(?:system|volume|container|image)\s+prune\b/i.test(masked)) {
      return hit('container-destroy');
    }

    if (!SQL_EXEMPT_HEAD.test(masked)) {
      if (/^dropdb\b/i.test(masked)
        || /\bdrop\s+(?:table|database|schema|index|column)\b/i.test(original)
        || /\btruncate\s+(?:table\s+)?\w/i.test(original)
        || (/\bdelete\s+from\s+\w+/i.test(original) && !/\bwhere\b/i.test(original))
        || (/\bupdate\s+\w+\s+set\b/i.test(original) && !/\bwhere\b/i.test(original))) {
        return hit('db-destructive');
      }
    }
  }
  return null;
}

/**
 * Whether a prompt reads as the user correcting the agent -- the highest-precision "store
 * this" signal that exists, and the one nothing was watching. A correction is, by definition,
 * durable knowledge the agent was supposed to be holding and was not.
 *
 * Three guards, each one a measured false positive:
 * - quoted and fenced spans are masked first, so a pasted bug report, a review brief, or a
 *   test-fixture string cannot arm it by quoting somebody else's correction;
 * - only the opening of the prompt is scanned -- a correction leads, an aside trails;
 * - the "should have" form requires a verb of memory or care, so "you should have write
 *   access now" stays what it is.
 */
const CORRECTION_WINDOW = 240;

const CORRECTION_PATTERNS = [
  /\byou\s+should(?:'?ve|\s+have)\s+(?:saved|stored|remembered|checked|asked|known|written|kept|read|verified|queried)\b/i,
  /\bwhy\s+(?:didn'?t|did\s+not|don'?t|doesn'?t|won'?t)\s+you\b/i,
  /\b(?:i|we)\s+(?:already\s+)?told\s+you\b/i,
  /\bwe\s+already\s+(?:decided|agreed|discussed|went\s+over)\b/i,
  /\b(?:that|this)\s+was\s+(?:careless|sloppy|reckless|dangerous)\b/i,
  /\byou\s+(?:broke|killed|destroyed|deleted|wiped|nuked|lost)\s+(?:my|the|our)\b/i,
  /\byou\s+keep\s+(?:forgetting|ignoring|missing|breaking|repeating|losing)\b/i,
  /\bnever\s+(?:do|run|use)\s+(?:that|this|it)\s+again\b/i,
  /\bfor\s+the\s+(?:last|second|third|hundredth|nth)\s+time\b/i,
  /\bstop\s+(?:doing|running|using)\s+(?:that|this)\b/i,
];

export function detectCorrectionSignal(prompt: string): boolean {
  const text = String(prompt ?? '');
  if (!text.trim()) return false;
  const window = maskQuoted(text).slice(0, CORRECTION_WINDOW);
  return CORRECTION_PATTERNS.some(pattern => pattern.test(window));
}
