import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRRulePredicate, PRRuleSubject } from '../../src/contracts/pr-rules.js';
import { assertPRReviewOptions } from '../../src/integrations/pr-rule-config.js';
import {
  assertPRRulePredicate,
  evaluatePRRulePredicate,
  prRuleFieldKey,
  prRuleGlob,
} from '../../src/integrations/pr-rule-predicates.js';

const subject: PRRuleSubject = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
  headSha: 'head-a',
  title: 'PR',
  observedAt: '2026-09-09T12:00:00.000Z',
  facts: {
    repository: { state: 'known', value: 'owner/repo' },
    labels: { state: 'unknown', reason: 'Access unavailable' },
  },
};
const repository: PRRulePredicate = {
  kind: 'compare',
  field: 'repository',
  operator: 'equals',
  value: 'Owner/Repo',
};
const label: PRRulePredicate = {
  kind: 'compare',
  field: 'labels',
  operator: 'contains-any',
  value: ['team-example'],
};

test('review configuration validates explicit session, scope and QA choices', () => {
  const options = { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'full-live' };
  assert.doesNotThrow(() => assertPRReviewOptions(options));
  assert.throws(
    () => assertPRReviewOptions({ ...options, sessionIntent: 'maybe' }),
    /Continue or Fresh/,
  );
  assert.throws(() => assertPRReviewOptions({ ...options, scope: 'changed-files' }), /scope/);
  assert.throws(
    () => assertPRReviewOptions({ ...options, validationDepth: undefined }),
    /validation/,
  );
  assert.throws(
    () => assertPRReviewOptions({ ...options, sessionId: 'untrusted-session' }),
    /Unsupported property/,
  );
});

test('unknown facts stay unknown under negation and only decisive known branches resolve composites', () => {
  assert.equal(evaluatePRRulePredicate(repository, subject).state, 'match');
  assert.equal(evaluatePRRulePredicate({ kind: 'not', item: label }, subject).state, 'unknown');
  assert.equal(
    evaluatePRRulePredicate({ kind: 'all', items: [repository, label] }, subject).state,
    'unknown',
  );
  assert.equal(
    evaluatePRRulePredicate({ kind: 'any', items: [repository, label] }, subject).state,
    'match',
  );
  assert.equal(
    evaluatePRRulePredicate(
      { kind: 'all', items: [{ kind: 'not', item: repository }, label] },
      subject,
    ).state,
    'no-match',
  );
});

test('Project option IDs survive display renames; unset differs from unavailable', () => {
  const field = {
    projectId: 'project-id',
    fieldId: 'status-field',
    valueType: 'single-select' as const,
  };
  const predicate: PRRulePredicate = {
    kind: 'compare',
    field,
    operator: 'equals',
    value: 'needs-review-option',
  };
  const facts = {
    ...subject.facts,
    [prRuleFieldKey(field)]: { state: 'known' as const, value: 'needs-review-option' },
  };
  assert.equal(evaluatePRRulePredicate(predicate, { ...subject, facts }).state, 'match');
  assert.equal(
    evaluatePRRulePredicate({ ...predicate, value: 'Needs review' }, { ...subject, facts }).state,
    'no-match',
  );
  assert.equal(
    evaluatePRRulePredicate({ kind: 'compare', field, operator: 'is-set', value: false }, subject)
      .state,
    'unknown',
  );
  assert.equal(
    evaluatePRRulePredicate(
      { kind: 'compare', field, operator: 'is-set', value: false },
      { ...subject, facts: { [prRuleFieldKey(field)]: { state: 'known', value: null } } },
    ).state,
    'match',
  );
  assert.equal(
    evaluatePRRulePredicate(predicate, {
      ...subject,
      facts: { [prRuleFieldKey(field)]: { state: 'known', value: 2 } },
    }).state,
    'unknown',
  );
});

test('path globs distinguish directory wildcards and support root files without regex backtracking', () => {
  for (const [pattern, value, expected] of [
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/nested/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/nested/a.ts', true],
    ['src/**/a?.ts', 'src/a1.ts', true],
    ['src/**/a?.ts', 'src/deep/a1.ts', true],
    ['a.b', 'axb', false],
    ['a?', 'ab/c', false],
  ] as const)
    assert.equal(prRuleGlob(pattern).test(value), expected, `${pattern} against ${value}`);
  assert.equal(prRuleGlob('*a'.repeat(100) + 'z').test('a'.repeat(2000)), false);
  assert.throws(() => prRuleGlob('src/[ab].ts'), /supports only/);
});

test('predicates reject unbounded trees, wrong operators, and arbitrary executable fields', () => {
  assert.throws(() => assertPRRulePredicate({ kind: 'all', items: [] }), /at least one/);
  assert.throws(
    () =>
      assertPRRulePredicate({
        kind: 'compare',
        field: 'draft',
        operator: 'equals',
        value: 'false',
      }),
    /field type/,
  );
  assert.throws(
    () =>
      assertPRRulePredicate({
        kind: 'compare',
        field: 'labels',
        operator: 'equals',
        value: ['one'],
      }),
    /field type/,
  );
  assert.throws(
    () => assertPRRulePredicate({ ...repository, command: 'echo matched' }),
    /Unsupported/,
  );
  let nested: PRRulePredicate = repository;
  for (let i = 0; i < 10; i++) nested = { kind: 'not', item: nested };
  assert.throws(() => assertPRRulePredicate(nested), /nesting/);
});
