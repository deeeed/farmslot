import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BugScore } from '../../src/contracts/bug-input.js';
import {
  computeFinalScore,
  filterBatchIssues,
  type LlmGrade,
  normalizeBugValidation,
  normalizeLlmGrade,
  parseLlmJson,
} from '../../src/contracts/bug-score.js';

// ── parseLlmJson ──────────────────────────────────────────────────────────────

test('parseLlmJson parses a bare JSON object', () => {
  assert.deepEqual(parseLlmJson('{"a": 1}'), { a: 1 });
});

test('parseLlmJson strips a leading markdown fence', () => {
  const fenced = '```json\n{"difficulty": "low"}\n```';
  assert.deepEqual(parseLlmJson(fenced), { difficulty: 'low' });
});

test('parseLlmJson strips a bare fence without a language tag', () => {
  assert.deepEqual(parseLlmJson('```\n{"x": true}\n```'), { x: true });
});

test('parseLlmJson throws on non-JSON', () => {
  assert.throws(() => parseLlmJson('not json at all'), /could not parse LLM response/);
});

// ── normalizeLlmGrade ─────────────────────────────────────────────────────────

function validGrade(overrides: Record<string, unknown> = {}) {
  return {
    difficulty: 'medium',
    confidence: 0.8,
    one_shot_probability: 0.5,
    reasoning: 'State update races with the render cycle.',
    estimated_complexity: 'multi-file change',
    ...overrides,
  };
}

test('normalizeLlmGrade returns the cleaned schema-only shape', () => {
  const grade = normalizeLlmGrade(
    validGrade({ risk_factors: ['flaky test'], similar_past_bugs: ['#100'], extra: 'dropped' }),
  );
  assert.deepEqual(grade, {
    difficulty: 'medium',
    confidence: 0.8,
    one_shot_probability: 0.5,
    reasoning: 'State update races with the render cycle.',
    similar_past_bugs: ['#100'],
    risk_factors: ['flaky test'],
    estimated_complexity: 'multi-file change',
  });
  assert.ok(!('extra' in grade));
});

test('normalizeLlmGrade defaults optional arrays to empty', () => {
  const grade = normalizeLlmGrade(validGrade());
  assert.deepEqual(grade.risk_factors, []);
  assert.deepEqual(grade.similar_past_bugs, []);
});

test('normalizeLlmGrade rejects bad difficulty', () => {
  assert.throws(
    () => normalizeLlmGrade(validGrade({ difficulty: 'critical' })),
    /difficulty must be one of/,
  );
});

test('normalizeLlmGrade rejects out-of-range confidence and probability', () => {
  assert.throws(() => normalizeLlmGrade(validGrade({ confidence: 1.5 })), /confidence must be 0-1/);
  assert.throws(
    () => normalizeLlmGrade(validGrade({ one_shot_probability: -0.1 })),
    /one_shot_probability must be 0-1/,
  );
});

test('normalizeLlmGrade rejects empty reasoning and bad complexity', () => {
  assert.throws(() => normalizeLlmGrade(validGrade({ reasoning: '' })), /reasoning is required/);
  assert.throws(
    () => normalizeLlmGrade(validGrade({ estimated_complexity: 'huge' })),
    /estimated_complexity must be one of/,
  );
});

test('normalizeLlmGrade reports every violation at once', () => {
  assert.throws(
    () => normalizeLlmGrade({ difficulty: 'x', confidence: 5, one_shot_probability: 9 }),
    /difficulty must be one of.*confidence must be 0-1.*one_shot_probability must be 0-1/s,
  );
});

test('normalizeLlmGrade rejects non-objects', () => {
  assert.throws(() => normalizeLlmGrade(null), /must be a JSON object/);
  assert.throws(() => normalizeLlmGrade([1]), /must be a JSON object/);
});

// ── computeFinalScore ─────────────────────────────────────────────────────────

const grade = (o: Partial<LlmGrade> = {}): LlmGrade => ({
  difficulty: 'medium',
  confidence: 0.8,
  one_shot_probability: 0.4,
  reasoning: 'r',
  similar_past_bugs: [],
  risk_factors: [],
  estimated_complexity: 'unknown',
  ...o,
});

const heur = (o: Partial<BugScore> = {}): BugScore => ({
  difficulty: 'medium',
  one_shot_probability: 0.6,
  category: 'state',
  ...o,
});

test('computeFinalScore reports agreement when difficulties match', () => {
  const final = computeFinalScore(grade({ difficulty: 'medium' }), heur({ difficulty: 'medium' }));
  assert.equal(final.source, 'agreement');
  assert.equal(final.difficulty, 'medium');
  assert.equal(final.one_shot_probability, 0.5); // (0.4 + 0.6) / 2
  assert.equal(final.recommended_model, 'sonnet');
});

test('computeFinalScore is conservative, keeping the harder estimate', () => {
  const final = computeFinalScore(grade({ difficulty: 'low' }), heur({ difficulty: 'high' }));
  assert.equal(final.source, 'conservative');
  assert.equal(final.difficulty, 'high');
});

test('computeFinalScore recommends opus for extreme', () => {
  const final = computeFinalScore(
    grade({ difficulty: 'extreme' }),
    heur({ difficulty: 'extreme' }),
  );
  assert.equal(final.recommended_model, 'opus');
});

test('computeFinalScore passes the LLM grade through with no heuristic', () => {
  const final = computeFinalScore(grade({ difficulty: 'high', one_shot_probability: 0.3 }), null);
  assert.equal(final.source, 'llm-only');
  assert.equal(final.difficulty, 'high');
  assert.equal(final.one_shot_probability, 0.3);
});

test('computeFinalScore rounds the merged probability to two decimals', () => {
  const final = computeFinalScore(
    grade({ one_shot_probability: 0.333 }),
    heur({ one_shot_probability: 0.334 }),
  );
  assert.equal(final.one_shot_probability, 0.33);
});

// ── normalizeBugValidation ────────────────────────────────────────────────────

test('normalizeBugValidation keeps present fields', () => {
  assert.deepEqual(
    normalizeBugValidation({ still_valid: false, confidence: 0.9, reason: 'fixed' }),
    {
      still_valid: false,
      confidence: 0.9,
      reason: 'fixed',
    },
  );
});

test('normalizeBugValidation applies defaults for missing fields', () => {
  assert.deepEqual(normalizeBugValidation({}), {
    still_valid: true,
    confidence: 0,
    reason: '',
  });
});

test('normalizeBugValidation coerces wrong-typed fields to defaults', () => {
  assert.deepEqual(normalizeBugValidation({ still_valid: 'yes', confidence: 'high', reason: 5 }), {
    still_valid: true,
    confidence: 0,
    reason: '',
  });
});

test('normalizeBugValidation handles the unparseable fallback', () => {
  assert.deepEqual(normalizeBugValidation({ reason: 'LLM response unparseable' }), {
    still_valid: true,
    confidence: 0,
    reason: 'LLM response unparseable',
  });
});

// ── filterBatchIssues ─────────────────────────────────────────────────────────

const issues = [
  { number: 1, updatedAt: '2026-03-01T00:00:00Z', assigned: false },
  { number: 2, updatedAt: '2026-01-15T00:00:00Z', assigned: true },
  { number: 3, updatedAt: '2026-05-20T00:00:00Z', assigned: true },
];

test('filterBatchIssues drops issues updated before since', () => {
  const kept = filterBatchIssues(issues, { since: '2026-03-01' });
  assert.deepEqual(
    kept.map((i) => i.number),
    [1, 3],
  );
});

test('filterBatchIssues drops assigned issues when requested', () => {
  const kept = filterBatchIssues(issues, { excludeAssigned: true });
  assert.deepEqual(
    kept.map((i) => i.number),
    [1],
  );
});

test('filterBatchIssues combines both filters', () => {
  const kept = filterBatchIssues(issues, { since: '2026-03-01', excludeAssigned: true });
  assert.deepEqual(
    kept.map((i) => i.number),
    [1],
  );
});

test('filterBatchIssues returns all issues with no filters', () => {
  assert.equal(filterBatchIssues(issues, {}).length, 3);
});
