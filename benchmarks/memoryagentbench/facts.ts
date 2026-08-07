// Parsing and scoring for MemoryAgentBench's Conflict Resolution (CR) track.
//
// Pure: no I/O, no database. The CR context is a numbered list of facts in which a later fact
// silently replaces an earlier one about the same subject, and the gold answer is always the
// LATER value. Verified against the published data before this was written, e.g.
//   [223] goaltender is associated with the sport of ice hockey
//   [310] goaltender is associated with the sport of pesäpallo   <- gold
// The values are deliberately counterfactual, so world knowledge cannot substitute for memory.

export type CrFact = {
  /** Position in the context. Recency comes from this and nothing else. */
  index: number;
  /** Full sentence, stored as the atom's content. */
  text: string;
  /** Subject + relation, shared by every fact that updates the same thing. */
  key: string;
  /** The part that changes between updates. */
  value: string;
};

export type CrInstance = {
  id: string;
  context: string;
  questions: string[];
  answers: string[][];
};

const MIN_KEY_RATIO = 0.6;

/**
 * Give every question a list of accepted gold answers.
 *
 * The dataset server is not uniform across rows: the 6k instances carry one string per question,
 * while the 262k single-hop instance carries an array wherever more than one surface form is
 * accepted. Scoring wants one shape, and a schema admitting only one of them rejects real data.
 */
export function normalizeAnswers(answers: readonly (string | readonly string[])[]): string[][] {
  return answers.map(answer => (Array.isArray(answer) ? [...answer] : [answer as string]));
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/\s*\.\s*$/, '').trim();
}

/**
 * Fail loudly when the serial chain stopped while its successor is still in the text.
 *
 * A strict +1 chain can never resume once broken, so a single break silently buries every later
 * fact inside the last one -- no error, a completed run, and a plausible-looking score. That is
 * exactly the failure mode that produced a bogus 40%.
 *
 * Deliberately NOT implemented by comparing the accepted chain length to a raw marker count:
 * sentences legitimately end in numbers ("Channel 4.", "iOS 6.", years), which inflates the marker
 * count on a perfectly correct parse.
 */
export function assertChainComplete(lastFactText: string, nextSerial: number): void {
  if (!new RegExp(`(^|\\D)${nextSerial}\\.`).test(lastFactText)) return;
  throw new Error(
    `CR fact chain broke at ${nextSerial}: marker "${nextSerial}." is still present in the text ` +
      `the final fact swallowed, so the parse buried every later fact in one atom. ` +
      `Last fact begins: ${lastFactText.slice(0, 120)}`,
  );
}

/**
 * Split the context into facts on the running serial number rather than on newlines.
 *
 * The raw dataset is newline-delimited, but MemoryAgentBench does not deliver it that way: its
 * chunker builds each chunk as `" ".join(nltk.sent_tokenize(text))`, which is strictly
 * sentence-aligned and drops the newline at every seam. Splitting on '\n' there yields ONE fact
 * holding the whole context, which silently disables supersession -- a single atom has nothing to
 * supersede. Both delivery shapes must parse identically, so the serial is the only reliable
 * separator.
 *
 * Two properties matter and are easy to get wrong:
 *   - The marker must not require whitespace around it. At a chunk seam the separator is gone
 *     entirely, giving "America.1163." or "290.Søren". Whitespace does not identify a fact.
 *   - The marker must not consume the whitespace that follows it. Sentences legitimately end in
 *     numbers, and a false marker that eats the space before the real next serial leaves that
 *     serial unmatched, breaking the chain permanently.
 */
export function parseFactLines(context: string): string[] {
  const marker = /(\d+)\./g;
  const starts: number[] = [];
  let expected = 0;

  for (let match = marker.exec(context); match; match = marker.exec(context)) {
    if (Number(match[1]) !== expected) continue;
    // Where the fact's text begins -- computed, never consumed by the pattern.
    starts.push(match.index + match[0].length);
    expected++;
  }

  if (!starts.length) return [];

  const facts = starts.map((start, position) => {
    // Each fact runs to the start of the next accepted marker, so the header before "0." is
    // dropped for free and a false marker inside the text is simply kept.
    const end = position + 1 < starts.length
      ? context.lastIndexOf(`${position + 1}.`, starts[position + 1])
      : context.length;
    return stripTrailingPeriod(context.slice(start, end));
  });

  assertChainComplete(facts[facts.length - 1], expected);
  return facts.filter(Boolean);
}

function commonPrefixKey(a: string, b: string): string | null {
  let position = 0;
  while (position < a.length && position < b.length && a[position] === b[position]) position++;
  const boundary = a.lastIndexOf(' ', position);
  if (boundary < 8) return null;
  const key = a.slice(0, boundary).trim();
  // Guard against merging different subjects that merely share a template opening: "The
  // chairperson of Fatah is ..." and "The chairperson of Harvard University is ..." share only
  // "The chairperson of", which is far short of either sentence.
  if (key.length < MIN_KEY_RATIO * Math.min(a.length, b.length)) return null;
  if (a.slice(boundary).trim() === b.slice(boundary).trim()) return null;
  return key;
}

/**
 * Derive each fact's subject+relation key.
 *
 * Done by shared-prefix discovery rather than a curated list of relation templates: an update is
 * generated by swapping the final value of an existing sentence, so the pair shares everything up
 * to that value. Sorting puts those pairs adjacent, so one linear pass finds them.
 *
 * This reads only the fact text. It never consults the questions or the answers — a rule that
 * peeked at the answer key would be manufacturing the result rather than measuring it.
 */
export function parseFacts(context: string): CrFact[] {
  const lines = parseFactLines(context);
  const order = lines.map((text, index) => ({ text, index })).sort((a, b) => a.text.localeCompare(b.text));

  const keyByIndex = new Map<number, string>();
  for (let position = 0; position < order.length - 1; position++) {
    const current = order[position];
    const next = order[position + 1];
    const key = commonPrefixKey(current.text, next.text);
    if (!key) continue;
    keyByIndex.set(current.index, key);
    keyByIndex.set(next.index, key);
  }

  return lines.map((text, index) => {
    // A fact with no partner keeps its whole sentence as its key, so it can never collide with
    // anything and can never supersede.
    const key = keyByIndex.get(index) ?? text;
    return { index, text, key, value: text.slice(key.length).trim() };
  });
}

/**
 * Reassemble MemoryAgentBench's chunk stream and parse it.
 *
 * The chunker joins sentences with ' ', so the separator it drops at each seam is a space and
 * restoring it is the faithful reconstruction. The serial chain must not *depend* on that
 * though -- a seam shape the chunker happens to emit would otherwise become a silent parse
 * failure, and silence is exactly how this went unnoticed the first time.
 */
export function factsFromChunks(chunks: readonly string[]): CrFact[] {
  return parseFacts(chunks.join(' '));
}

/** Facts that share a key, in context order. The last one is the current value. */
export function conflictGroups(facts: CrFact[]): Map<string, CrFact[]> {
  const groups = new Map<string, CrFact[]>();
  for (const fact of facts) {
    const bucket = groups.get(fact.key);
    if (bucket) bucket.push(fact);
    else groups.set(fact.key, [fact]);
  }
  for (const [key, bucket] of groups) if (bucket.length < 2) groups.delete(key);
  return groups;
}

export type CrCaseResult = {
  question: string;
  golds: string[];
  /** Content of the highest-ranked atom returned, or null when nothing came back. */
  topContent: string | null;
  /** Every returned atom's content, for the stale-value check. */
  returnedContents: string[];
  latencyMs: number;
};

export type CrReport = {
  questions: number;
  answered: number;
  /** Gold value present in the single top-ranked atom. The strict, primary metric. */
  topOneAccuracy: number;
  /** Gold value present anywhere in the returned set. Diagnostic, deliberately weaker. */
  anyRankAccuracy: number;
  /**
   * Questions where a superseded value was returned alongside or instead of the current one.
   * This is the failure conflict resolution is meant to prevent.
   */
  staleLeaks: number;
  emptyResults: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/**
 * Score with substring exact match, the metric the benchmark specifies.
 *
 * `topOneAccuracy` is the headline because the competency is "subsequent queries reflect only the
 * newest valid data". A system that returns the old and the new value together has not resolved
 * the conflict, and would be flattered by an any-rank score.
 *
 * `supersededValues` maps a gold value to the earlier values it replaced, so returning a retired
 * answer is counted rather than ignored.
 */
export function scoreCr(
  results: CrCaseResult[],
  supersededValues: Map<string, string[]>,
): CrReport {
  let topOne = 0;
  let anyRank = 0;
  let staleLeaks = 0;
  let emptyResults = 0;

  for (const result of results) {
    if (!result.returnedContents.length) emptyResults++;
    if (result.topContent && result.golds.some(gold => contains(result.topContent!, gold))) topOne++;
    if (result.golds.some(gold => result.returnedContents.some(content => contains(content, gold)))) anyRank++;

    const retired = result.golds.flatMap(gold => supersededValues.get(gold.toLowerCase()) ?? []);
    if (retired.some(old => result.returnedContents.some(content => contains(content, old)))) staleLeaks++;
  }

  const latencies = results.map(result => result.latencyMs);
  const total = Math.max(1, results.length);
  return {
    questions: results.length,
    answered: results.filter(result => result.returnedContents.length > 0).length,
    topOneAccuracy: topOne / total,
    anyRankAccuracy: anyRank / total,
    staleLeaks,
    emptyResults,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

/**
 * Retired *sentences*, keyed by the replacing value (lowercased).
 *
 * Full sentences rather than bare values, because values collide across unrelated facts: a gold
 * of "India" matched five other facts mentioning India and reported leaks that were not leaks.
 * Matching the whole retired sentence only fires when the actually-superseded record came back.
 */
export function buildSupersededValues(facts: CrFact[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of conflictGroups(facts).values()) {
    const current = group[group.length - 1];
    map.set(current.value.toLowerCase(), group.slice(0, -1).map(fact => fact.text));
  }
  return map;
}
