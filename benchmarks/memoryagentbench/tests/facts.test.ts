import { describe, expect, it } from 'vitest';
import {
  buildSupersededValues,
  conflictGroups,
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
