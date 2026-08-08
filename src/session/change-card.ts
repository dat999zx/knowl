import { inlineUntrusted } from '../core/untrusted.js';
import type { ChangeSummary } from '../store/change-watermark.js';

const MAX_ITEM_LINES = 5;
const MAX_TITLE_LENGTH = 90;
const CLOSING_LINE = 'Call knowl_query before relying on earlier memory in these areas.';

/**
 * Three impact entries, because three is the largest cap that still lands the stanza inside
 * plan §7.5's ≤6-line budget in its common shape: header + 3 entries + `+N more` + the re-read
 * line. An entry that can prove both signatures costs three lines instead of one, so the worst
 * case is 12 -- accepted knowingly, because the `was:`/`now:` pair *is* the payload. Strip it and
 * what is left is the bare announcement SWE-Touch measured at no consistent improvement, and
 * worse than silence for 3 of 4 models. The cap is what keeps the tail bounded: this stanza rides
 * the `PostToolUse`/`additionalContext` channel, which AgentNoiseBench measures at ~20.8% mean
 * accuracy cost when polluted, so every line past the point of persuasion is charged against the
 * agent reading it.
 */
const MAX_IMPACT_ENTRIES = 3;

/** Paths, not entries: several changed symbols in one file collapse to one thing to re-open. */
const MAX_REREAD_PATHS = 3;

// A type alias rather than an interface: only aliases get an implicit index
// signature, which is what keeps this assignable to HostLifecycleResult.hostOutput
// (`Record<string, unknown>`) without a cast.
export type ClaudeChangeCardOutput = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
};

/**
 * One certain-tier impact finding, flattened to exactly what a card line needs.
 *
 * The signatures are nullable because the detector refuses to guess: `provenSignature` in
 * `impact.ts` hands back `observedSignature` only when the pre-change index row hashes to what the
 * reader actually recorded. A null therefore means "cannot prove the agent saw this text", never
 * "no text exists", and the renderer has to treat the two the same way it would treat a lie.
 */
export interface ImpactCardEntry {
  /** Canonical `symbol://path#Name` or `file://path`, as `normalizeLocator` writes it. */
  locator: string;
  wasSignature: string | null;
  nowSignature: string | null;
}

type LocatorView = {
  /** The locator as a human reads it. */
  display: string;
  /** The file to re-open, or null when the locator's shape does not name one. */
  path: string | null;
  phrase: string;
};

/**
 * The locator as a human reads it, plus the path the re-read line may name.
 *
 * The scheme is machine plumbing -- it exists to keep the detector from comparing a file hash
 * against a signature hash -- and it means nothing to an agent, who needs something it can open.
 * Nothing here is truncated: a shortened path is not a path, and this is the actionable half of
 * the stanza. An unrecognised scheme prints raw and contributes no path, because inventing a file
 * to re-read out of a locator we cannot parse is the same fabrication the null-signature rule
 * below exists to prevent.
 */
function describeLocator(locator: string): LocatorView {
  if (locator.startsWith('symbol://')) {
    const display = locator.slice('symbol://'.length);
    // First `#`, matching `normalizeLocator`: the path cannot contain one, a qualified name can.
    const hash = display.indexOf('#');
    const path = hash < 0 ? display : display.slice(0, hash);
    return { display, path: path || null, phrase: 'signature changed since you read it' };
  }
  if (locator.startsWith('file://')) {
    const display = locator.slice('file://'.length);
    return { display, path: display || null, phrase: 'file changed since you read it' };
  }
  return { display: locator, path: null, phrase: 'changed since you read it' };
}

/**
 * The one unbounded field on the card, and the one truncation that must announce itself.
 *
 * A cut-off title is obviously a cut-off title; a cut-off signature still reads as a complete,
 * valid signature, and an agent that believes it writes a call against the parameters that were
 * sliced away. Hence the ellipsis, which the `MAX_TITLE_LENGTH` truncation at the item lines does
 * not need. The length budget is shared with titles deliberately -- same channel, same one-line
 * ceiling, and a second constant would just be a number someone has to remember to keep equal.
 * Whitespace is collapsed because the line caps above are the whole noise argument, and a single
 * newline inside a signature would silently turn one budgeted line into several.
 */
function renderSignature(signature: string): string {
  const flat = inlineUntrusted(signature);
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
}

/**
 * Titles only, never content. A title is the routing information the agent needs —
 * "do I care about this?" — and content is what knowl_query is for.
 *
 * A title is stored text, and this card rides `PostToolUse`/`additionalContext` into the middle
 * of a turn with no human in the loop -- the same channel and the same exposure as
 * `renderSkillUseNudge`. `renderSignature` two functions up has collapsed whitespace since it was
 * written, for the narrower reason that a newline turns one budgeted line into several; the same
 * newline in a title also reaches column 0, where `## SYSTEM` or a fence opener is live markdown.
 * Both now go through the one helper that states why.
 *
 * Collapsed before the slice, not after: `inlineUntrusted` only ever shortens, so the
 * `MAX_TITLE_LENGTH` cap still bounds the line, and slicing first would leave a newline in
 * whatever survived the cut.
 */
function renderKnowledgeStanza(summary: ChangeSummary): string {
  const shown = summary.items.slice(0, MAX_ITEM_LINES);
  const lines = shown.map(item => {
    const action = item.action === 'insert' ? '' : ` (${item.action})`;
    // The repo tag is not decoration: a fact from another repo describes that repo, so
    // an agent that cannot tell where a change landed cannot tell whether it applies here.
    const repo = item.repo ? `[${item.repo}] ` : '';
    return `- ${repo}${item.category}${action}: ${inlineUntrusted(item.title).slice(0, MAX_TITLE_LENGTH)}`;
  });
  const remaining = summary.count - shown.length;
  if (remaining > 0) lines.push(`- +${remaining} more`);
  const noun = summary.count === 1 ? 'item' : 'items';
  return [`KNOWL CHANGED: ${summary.count} ${noun} since you last looked.`, ...lines].join('\n');
}

/**
 * Code that moved under a read this session has on record.
 *
 * Unlike `ChangeSummary` there is no separate count to report: every finding the caller passes is
 * one it could name, so the header counts the array and the cap accounts for itself with `+N more`.
 */
function renderImpactStanza(impact: ImpactCardEntry[]): string {
  const shown = impact.slice(0, MAX_IMPACT_ENTRIES);
  const lines = shown.flatMap(entry => {
    const { display, phrase } = describeLocator(entry.locator);
    const head = `- ${display} — ${phrase}`;
    // Both halves or neither. `wasSignature` is null exactly when the detector could not prove
    // the agent saw that text, so a plausible-looking `was:` would be a fabricated quote inside a
    // notice whose entire value is being trustworthy -- and the agent has no way to tell a
    // fabricated one from a real one, which poisons every other line in the card with it. A lone
    // `now:` goes too: the current text is already in the file the agent is about to open, so
    // without the `was:` to diff against it carries no news, only length.
    if (!entry.wasSignature || !entry.nowSignature) return [head];
    return [
      head,
      `  was: ${renderSignature(entry.wasSignature)}`,
      `  now: ${renderSignature(entry.nowSignature)}`,
    ];
  });
  const remaining = impact.length - shown.length;
  if (remaining > 0) lines.push(`- +${remaining} more`);

  // Drawn from every entry, including the ones the cap dropped. A path costs a few words where an
  // entry costs up to three lines, so cutting the cheap actionable half to fund the expensive
  // explanatory half would be backwards. Distinct and first-seen: five changed symbols in one file
  // are one file to re-open, and the entry lines have already repeated its name five times.
  const paths: string[] = [];
  for (const entry of impact) {
    const { path } = describeLocator(entry.locator);
    if (path && !paths.includes(path)) paths.push(path);
  }
  const shownPaths = paths.slice(0, MAX_REREAD_PATHS);
  const morePaths = paths.length - shownPaths.length;
  const reread = paths.length === 0
    ? []
    : [`Re-read before writing to: ${shownPaths.join(', ')}${morePaths > 0 ? ` (+${morePaths} more)` : ''}`];

  const subject = impact.length === 1 ? '1 thing you read has changed' : `${impact.length} things you read have changed`;
  return [`CODE IMPACT: ${subject}.`, ...lines, ...reread].join('\n');
}

/**
 * One card, both kinds of news. The mid-turn slot is single-occupancy by design
 * (`host-lifecycle.ts`: "At most one card per tool event, never two"), so the impact stanza has
 * to fit inside the existing card rather than compete with it for the slot.
 *
 * Both arguments are optional and either stanza stands alone: knowledge can change with no code
 * moving, and code moves in sessions where the store was never written.
 */
export function renderChangeCard(summary: ChangeSummary | undefined, impact?: ImpactCardEntry[]): string {
  const stanzas: string[] = [];
  if (summary) stanzas.push(renderKnowledgeStanza(summary));
  if (impact && impact.length > 0) stanzas.push(renderImpactStanza(impact));
  // No news renders nothing, not a bare closing line. That line is an instruction *about* the
  // stanzas above it; alone it is tool-side context carrying no information, which is the exact
  // shape of the noise measured at ~20.8% mean accuracy cost. Today's callers both check for
  // changes before rendering, so this is unreachable from them -- it is here so the next caller
  // cannot inject an empty card by accident.
  if (stanzas.length === 0) return '';
  // A blank line between the stanzas because they are separate news; none before the closing
  // line because it applies to both.
  return `${stanzas.join('\n\n')}\n${CLOSING_LINE}`;
}

export function createClaudeChangeCardOutput(
  summary: ChangeSummary | undefined,
  impact?: ImpactCardEntry[],
): ClaudeChangeCardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: renderChangeCard(summary, impact),
    },
  };
}
