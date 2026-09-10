import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRProjectField, PRRuleSubject } from '../../src/contracts/pr-rules.js';
import {
  assertPRImportedProjectView,
  compilePRProjectFilter,
  parsePRProjectURL,
  splitPRProjectFilter,
} from '../../src/integrations/pr-project-import.js';
import {
  evaluatePRRulePredicate,
  prRuleFieldKey,
} from '../../src/integrations/pr-rule-predicates.js';

const fields: PRProjectField[] = [
  {
    id: 'status-id',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [
      { id: 'review-id', name: 'Needs review' },
      { id: 'done-id', name: 'Done' },
    ],
  },
  { id: 'points-id', name: 'Story Points', dataType: 'NUMBER' },
  { id: 'notes-id', name: 'Notes', dataType: 'TEXT' },
];

test('Project/view URLs preserve host and owner kind and refuse temporary filters or legacy boards', () => {
  assert.deepEqual(
    parsePRProjectURL('https://github.com/orgs/example/projects/12/views/3', 'github.com'),
    { ownerKind: 'organization', owner: 'example', number: 12, viewNumber: 3 },
  );
  assert.equal(
    parsePRProjectURL('https://git.example.com/users/person/projects/1', 'git.example.com')
      .ownerKind,
    'user',
  );
  for (const url of [
    'https://other.example/orgs/example/projects/12',
    'https://github.com/orgs/example/projects/12?filterQuery=label:secret',
    'https://github.com/owner/repo/projects/1',
    'http://github.com/orgs/example/projects/12',
    'https://user:secret@github.com/orgs/example/projects/12',
  ])
    assert.throws(() => parsePRProjectURL(url, 'github.com'));
});

test('view terms retain quoted commas/spaces and translate negation, OR values and provider option IDs', () => {
  const filter =
    'is:pr -is:draft label:"team,one",support status:"Needs review",Done story-points:>2';
  const terms = compilePRProjectFilter(filter, 'project-id', fields);
  assert.equal(terms.length, 5);
  assert(terms.every((term) => term.kind !== 'unmapped'));
  assert.deepEqual(terms[0], { text: 'is:pr', kind: 'constant', value: true });
  const status = terms[3];
  assert(status.kind === 'predicate' && status.predicate.kind === 'compare');
  assert.deepEqual(status.predicate.value, ['review-id', 'done-id']);
  assert.equal(
    typeof status.predicate.field === 'object' && status.predicate.field.fieldId,
    'status-id',
  );
  assertPRImportedProjectView({ number: 1, name: 'Review', filter, terms });
  const subject: PRRuleSubject = {
    pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
    headSha: 'head',
    title: 'PR',
    observedAt: new Date().toISOString(),
    facts: {
      draft: { state: 'known', value: false },
      labels: { state: 'known', value: ['TEAM,ONE'] },
      [prRuleFieldKey({
        projectId: 'project-id',
        fieldId: 'status-id',
        valueType: 'single-select',
      })]: { state: 'known', value: 'review-id' },
      [prRuleFieldKey({ projectId: 'project-id', fieldId: 'points-id', valueType: 'number' })]: {
        state: 'known',
        value: 3,
      },
    },
  };
  for (const term of terms)
    if (term.kind === 'predicate')
      assert.equal(evaluatePRRulePredicate(term.predicate, subject).state, 'match');
});

test('unsupported terms remain unmapped and cannot be removed or converted to an unconditional match', () => {
  const filter = 'label:bug assignee:@me notes:"partial text"';
  const terms = compilePRProjectFilter(filter, 'project-id', fields);
  assert.equal(terms.filter((term) => term.kind === 'unmapped').length, 2);
  assertPRImportedProjectView({ number: 1, name: 'View', filter, terms });
  assert.throws(
    () =>
      assertPRImportedProjectView({ number: 1, name: 'View', filter, terms: terms.slice(0, 1) }),
    /discard/,
  );
  assert.throws(
    () =>
      assertPRImportedProjectView({
        number: 1,
        name: 'View',
        filter,
        terms: terms.map((term) => ({ text: term.text, kind: 'constant', value: true })),
      }),
    /Only PR/,
  );
  const mapped = terms.map((term) =>
    term.kind === 'unmapped'
      ? {
          text: term.text,
          kind: 'predicate',
          manuallyMapped: true,
          predicate: { kind: 'compare', field: 'author', operator: 'equals', value: 'reviewer' },
        }
      : term,
  );
  assertPRImportedProjectView({ number: 1, name: 'View', filter, terms: mapped });
});

test('unsupported grouping and malformed quotes cannot become a partially translated scope', () => {
  for (const filter of [
    'label:bug OR label:support',
    '(label:bug label:support)',
    'status:"unclosed',
    "label:'bug'",
    "-label:'bug,support'",
    "label:'team one' is:pr",
  ]) {
    assert.deepEqual(splitPRProjectFilter(filter), [filter]);
    assert.deepEqual(
      compilePRProjectFilter(filter, 'project-id', fields).map((term) => term.kind),
      ['unmapped'],
    );
  }
  assert.equal(compilePRProjectFilter('is:issue', 'project-id', fields)[0].kind, 'constant');
  assert.throws(() => splitPRProjectFilter('x'.repeat(4097)), /4096/);
});

test('missing options, ambiguous field aliases and unsupported comparisons need explicit mapping', () => {
  for (const filter of [
    'status:Deleted',
    'story-points:>=3',
    'story-points:1..4',
    'iteration:@current',
  ])
    assert.equal(compilePRProjectFilter(filter, 'project-id', fields)[0].kind, 'unmapped');
  const ambiguous = [...fields, { id: 'other-points', name: 'Story-Points', dataType: 'NUMBER' }];
  assert.equal(
    compilePRProjectFilter('story-points:2', 'project-id', ambiguous)[0].kind,
    'unmapped',
  );
});
