import { describe, expect, it } from 'vitest';
import { generateCodingMemoryBundle } from '../../benchmarks/accuracy/src/generator.js';
import { validateBenchmarkBundle } from '../../benchmarks/accuracy/src/validate.js';

describe('coding-memory benchmark dataset', () => {
  it('generates the release corpus deterministically with the required coverage', () => {
    const first = generateCodingMemoryBundle('coding-memory-v1');
    const second = generateCodingMemoryBundle('coding-memory-v1');
    const summary = validateBenchmarkBundle(first, { release: true });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(summary).toMatchObject({
      projectCount: 5,
      historyCount: 100,
      sessionCount: 400,
      questionCount: 200,
    });
    expect(summary.questionsPerProject).toEqual([40, 40, 40, 40, 40]);
    expect(summary.categories).toEqual([
      'abstention',
      'architecture_decision',
      'code_symbol',
      'command_workflow',
      'constraint',
      'contradiction',
      'current_state',
      'failed_approach',
      'historical_state',
      'multi_session',
      'stale_evidence',
      'superseded_decision',
    ]);
    expect(first.queries.every(query => /^question_[a-f0-9]{24}$/u.test(query.questionId))).toBe(true);
    expect(first.normalizedRecords.every(record => /^src_[a-f0-9]{24}$/u.test(record.sourceId))).toBe(true);
    expect(first.nativeHistories.flatMap(history => history.sessions).flatMap(session => session.events)
      .every(event => /^src_[a-f0-9]{24}$/u.test(event.sourceId))).toBe(true);
  });

  it('changes wording without changing stable IDs when the seed changes', () => {
    const first = generateCodingMemoryBundle('seed-one');
    const second = generateCodingMemoryBundle('seed-two');

    expect(second.queries.map(query => query.questionId)).toEqual(first.queries.map(query => query.questionId));
    expect(second.normalizedRecords.map(record => record.sourceId)).toEqual(first.normalizedRecords.map(record => record.sourceId));
    expect(second.queries.map(query => query.text)).not.toEqual(first.queries.map(query => query.text));
  });

  it('keeps evaluator labels out of every public adapter payload', () => {
    const bundle = generateCodingMemoryBundle('public-isolation');
    const publicJson = JSON.stringify({
      records: bundle.normalizedRecords,
      histories: bundle.nativeHistories,
      queries: bundle.queries,
    });

    for (const forbidden of [
      'acceptedText', 'answer', 'canonical', 'disposition', 'expected', 'grade',
      'harmful', 'judgments', 'relevance', 'shouldAbstain', 'shouldPromote',
    ]) {
      expect(publicJson).not.toContain(`"${forbidden}"`);
    }
  });

  it('rejects positive evidence on abstention questions and dangling source IDs', () => {
    const withPositiveAbstention = structuredClone(generateCodingMemoryBundle('invalid-abstention'));
    const abstention = withPositiveAbstention.questionGold.find(gold => gold.shouldAbstain)!;
    abstention.judgments.push({ sourceId: withPositiveAbstention.normalizedRecords[0].sourceId, grade: 3, role: 'answer' });
    expect(() => validateBenchmarkBundle(withPositiveAbstention)).toThrow('Abstention question');

    const withDanglingSource = structuredClone(generateCodingMemoryBundle('invalid-source'));
    withDanglingSource.questionGold[0].judgments[0].sourceId = 'source:missing';
    expect(() => validateBenchmarkBundle(withDanglingSource)).toThrow('unknown source');
  });
});
