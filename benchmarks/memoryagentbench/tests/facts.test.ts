import { describe, expect, it } from 'vitest';
import {
  assertChainComplete,
  buildSupersededValues,
  conflictGroups,
  factsFromChunks,
  normalizeAnswers,
  parseFacts,
  parseFactLines,
  scoreCr,
  type CrCaseResult,
} from '../facts.js';

const CONTEXT = [
  'Here is a list of facts:',
  '0. goaltender is associated with the sport of ice hockey.',
  '1. The chairperson of Fatah is Mahmoud Abbas.',
  '2. The chairperson of Harvard University is Lawrence S. Bacow.',
  '3. goaltender is associated with the sport of pesäpallo.',
  '4. Ferdowsi is famous for Shahnameh.',
  '5. The chairperson of Fatah is Moshe Kahlon.',
].join('\n');

function caseResult(overrides: Partial<CrCaseResult> = {}): CrCaseResult {
  return {
    question: 'q',
    golds: ['pesäpallo'],
    topContent: 'goaltender is associated with the sport of pesäpallo',
    returnedContents: ['goaltender is associated with the sport of pesäpallo'],
    latencyMs: 5,
    ...overrides,
  };
}

describe('CR fact parsing', () => {
  it('drops the header and the numbering', () => {
    expect(parseFactLines(CONTEXT)[0]).toBe('goaltender is associated with the sport of ice hockey');
  });

  it('gives updates of the same thing a shared key, taken only from the fact text', () => {
    const facts = parseFacts(CONTEXT);
    const goaltender = facts.filter(fact => fact.text.startsWith('goaltender'));

    expect(goaltender).toHaveLength(2);
    expect(goaltender[0].key).toBe(goaltender[1].key);
    expect(goaltender[0].value).toBe('ice hockey');
    expect(goaltender[1].value).toBe('pesäpallo');
  });

  it('does not merge different subjects that share a template opening', () => {
    const facts = parseFacts(CONTEXT);
    const fatah = facts.find(fact => fact.text.includes('Fatah is Mahmoud'))!;
    const harvard = facts.find(fact => fact.text.includes('Harvard'))!;

    // "The chairperson of" alone is far shorter than either sentence, so it must not become a key.
    expect(fatah.key).not.toBe(harvard.key);
    expect(fatah.key).toContain('Fatah');
  });

  it('leaves a fact with no update keyed to its own full sentence', () => {
    const facts = parseFacts(CONTEXT);
    const unique = facts.find(fact => fact.text.startsWith('Ferdowsi'))!;

    expect(unique.key).toBe('Ferdowsi is famous for Shahnameh');
    expect(conflictGroups(facts).has(unique.key)).toBe(false);
  });

  it('groups conflicts in context order so the last entry is current', () => {
    const groups = conflictGroups(parseFacts(CONTEXT));
    const goaltender = [...groups.values()].find(group => group[0].text.startsWith('goaltender'))!;

    expect(goaltender.map(fact => fact.value)).toEqual(['ice hockey', 'pesäpallo']);
  });

  it('maps a current value back to the values it retired', () => {
    const superseded = buildSupersededValues(parseFacts(CONTEXT));

    expect(superseded.get('pesäpallo')).toEqual(['goaltender is associated with the sport of ice hockey']);
    expect(superseded.get('moshe kahlon')).toEqual(['The chairperson of Fatah is Mahmoud Abbas']);
  });
});

describe('CR fact parsing, sentence-joined delivery', () => {
  // MemoryAgentBench does not deliver the context newline-delimited. Its chunker builds every
  // chunk as `" ".join(nltk.sent_tokenize(text))`, so the newlines are gone and the facts are
  // separated by a single space -- or by nothing at all, at a chunk seam. Splitting on '\n' sees
  // one giant line and stores the whole context as a single fact, which silently disables
  // supersession: one atom can never supersede another.

  it('splits on the serial number when the facts are space-joined instead of newline-delimited', () => {
    const joined = [
      'Here is a list of facts:',
      '0. goaltender is associated with the sport of ice hockey.',
      '1. The chairperson of Fatah is Mahmoud Abbas.',
      '2. goaltender is associated with the sport of pesäpallo.',
    ].join(' ');

    expect(parseFactLines(joined)).toEqual([
      'goaltender is associated with the sport of ice hockey',
      'The chairperson of Fatah is Mahmoud Abbas',
      'goaltender is associated with the sport of pesäpallo',
    ]);
  });

  it('splits a seam where the separator was dropped entirely', () => {
    // Both shapes occur at real chunk seams: the serial can be glued to the text that follows it,
    // or to the sentence that precedes it. Whitespace does not identify a fact; the serial does.
    const glued = 'Here is a list of facts: 0. Fact about America.1. Søren Kierkegaard was born in Denmark.';

    expect(parseFactLines(glued)).toEqual([
      'Fact about America',
      'Søren Kierkegaard was born in Denmark',
    ]);
  });

  it('keeps the chain when a fact legitimately ends in a number', () => {
    // "Channel 4." matches the shape of a serial marker. The running count rejects it, but a
    // parser that lets the false marker consume the separator before the real one breaks the
    // chain -- and a strict +1 chain can never resume, hiding every later fact in one atom.
    const withTrailingNumber = [
      'Here is a list of facts:',
      '0. The original broadcaster of The Last Leg is Channel 4.',
      '1. Ken Burns speaks the language of English.',
    ].join(' ');

    expect(parseFactLines(withTrailingNumber)).toEqual([
      'The original broadcaster of The Last Leg is Channel 4',
      'Ken Burns speaks the language of English',
    ]);
  });

  it('accepts a chain that ends because the successor genuinely is not there', () => {
    // A gap in the source numbering is not a parser defect. Only an unreachable successor is.
    const gap = 'Here is a list of facts: 0. First fact. 2. Skipped one.';

    expect(parseFactLines(gap)).toEqual(['First fact. 2. Skipped one']);
  });
});

describe('CR fact chain guard', () => {
  // Every parsing defect here fails silently and still reports a plausible score -- that is what
  // produced the bogus 40%. A break in a strict +1 chain is always terminal, so checking that the
  // successor is absent from the text the last fact swallowed catches all of them at once.
  //
  // This is a white-box invariant, not a data-driven behaviour: a forward scan always finds a
  // successor that is textually present, so a correct parser cannot be made to violate it from
  // the outside. It is tested directly for that reason.

  it('passes when the successor really is absent from the swallowed tail', () => {
    expect(() => assertChainComplete('First fact. 2. Skipped one', 1)).not.toThrow();
  });

  it('throws when the successor is still sitting in the text the last fact swallowed', () => {
    expect(() => assertChainComplete('The Last Leg is Channel 4. 6342. Ken Burns speaks English', 6342))
      .toThrow(/chain/i);
  });
});

describe('CR chunk reassembly', () => {
  // MemoryAgentBench delivers the context as a stream of ~4096-token chunks, each already
  // sentence-joined. The bridge buffers them and reassembles before parsing, because a fact can
  // sit either side of a seam.

  const CHUNKS = [
    'Here is a list of facts: 0. goaltender is associated with the sport of ice hockey. 1. The chairperson of Fatah is Mahmoud Abbas.',
    '2. goaltender is associated with the sport of pesäpallo. 3. Ferdowsi is famous for Shahnameh.',
  ];

  it('recovers every fact across a chunk seam', () => {
    expect(factsFromChunks(CHUNKS).map(fact => fact.text)).toEqual([
      'goaltender is associated with the sport of ice hockey',
      'The chairperson of Fatah is Mahmoud Abbas',
      'goaltender is associated with the sport of pesäpallo',
      'Ferdowsi is famous for Shahnameh',
    ]);
  });

  it('is unaffected by whether the dropped seam separator is restored', () => {
    // The chunker joins sentences with ' ', so the separator it drops at a seam is a space --
    // restoring it is correct. But the serial chain must not DEPEND on that, or a seam shape the
    // chunker happens to produce becomes a silent parse failure.
    const glued = factsFromChunks(CHUNKS);
    const spaced = parseFacts(CHUNKS.join(' '));

    expect(glued.map(fact => fact.text)).toEqual(spaced.map(fact => fact.text));
  });

  it('still supersedes across the seam, which one giant atom could never do', () => {
    const groups = conflictGroups(factsFromChunks(CHUNKS));

    expect(groups.size).toBe(1);
    expect([...groups.values()][0].map(fact => fact.value)).toEqual(['ice hockey', 'pesäpallo']);
  });
});

describe('CR answer normalisation', () => {
  // The dataset server is not uniform across rows: the 6k instances return one string per
  // question, while the 262k single-hop instance returns an array for questions that accept more
  // than one surface form. A schema that admits only one of those shapes rejects real data.

  it('wraps a single answer so every question carries a list of accepted golds', () => {
    expect(normalizeAnswers(['pesäpallo'])).toEqual([['pesäpallo']]);
  });

  it('keeps a multi-answer question as its list of alternatives', () => {
    expect(normalizeAnswers([['Washington, D.C.', 'Washington DC']])).toEqual([
      ['Washington, D.C.', 'Washington DC'],
    ]);
  });

  it('accepts a row that mixes both shapes', () => {
    expect(normalizeAnswers(['pesäpallo', ['a', 'b']])).toEqual([['pesäpallo'], ['a', 'b']]);
  });
});

describe('CR scoring', () => {
  it('scores a correct top-ranked answer', () => {
    const report = scoreCr([caseResult()], buildSupersededValues(parseFacts(CONTEXT)));

    expect(report.topOneAccuracy).toBe(1);
    expect(report.staleLeaks).toBe(0);
  });

  it('does not credit top-1 when the gold is only lower down', () => {
    const report = scoreCr([caseResult({
      topContent: 'something unrelated',
      returnedContents: ['something unrelated', 'goaltender is associated with the sport of pesäpallo'],
    })], buildSupersededValues(parseFacts(CONTEXT)));

    expect(report.topOneAccuracy).toBe(0);
    expect(report.anyRankAccuracy).toBe(1);
  });

  it('counts a returned superseded value as a stale leak', () => {
    // Returning the retired answer beside the current one is the exact failure this track exists
    // to detect, so it must be counted even though the gold was also present.
    const report = scoreCr([caseResult({
      returnedContents: [
        'goaltender is associated with the sport of pesäpallo',
        'goaltender is associated with the sport of ice hockey',
      ],
    })], buildSupersededValues(parseFacts(CONTEXT)));

    expect(report.topOneAccuracy).toBe(1);
    expect(report.staleLeaks).toBe(1);
  });

  it('reports empty results rather than scoring them as wrong answers', () => {
    const report = scoreCr([caseResult({ topContent: null, returnedContents: [] })], new Map());

    expect(report.emptyResults).toBe(1);
    expect(report.answered).toBe(0);
    expect(report.topOneAccuracy).toBe(0);
  });
});
