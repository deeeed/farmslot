import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compilePRProjectFilter,
  type PRProjectField,
  prRuleFieldKey,
  type PRRuleSource,
  type PRRuleSubject,
} from '@farmslot/protocol';

import {
  matchPRSourceScopes,
  projectBindingErrors,
  sourcePredicates,
  unresolvedSourceFilters,
} from './project-scope.js';

const fields: PRProjectField[] = [
  {
    id: 'status',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [{ id: 'review', name: 'Review' }],
  },
];
const project: PRRuleSource = {
  kind: 'github-project',
  projectId: 'project',
  label: 'Board',
  importedView: {
    number: 1,
    name: 'Review',
    filter: 'label:team status:Review',
    terms: compilePRProjectFilter('label:team status:Review', 'project', fields),
  },
};
const subject: PRRuleSubject = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
  headSha: 'head',
  title: 'PR',
  observedAt: new Date().toISOString(),
  facts: {
    labels: { state: 'known', value: ['team'] },
    [prRuleFieldKey({ projectId: 'project', fieldId: 'status', valueType: 'single-select' })]: {
      state: 'known',
      value: 'review',
    },
  },
};

test('matching labels never substitute for Project membership', () => {
  assert.equal(matchPRSourceScopes(subject, [project], new Set()).included, false);
  const matched = matchPRSourceScopes(subject, [project], new Set([0]));
  assert(matched.included);
  assert(matched.reasons.some((reason) => reason.includes('Board / Review')));
  const outsideFilter = structuredClone(subject);
  outsideFilter.facts.labels = { state: 'known', value: ['other'] };
  assert.equal(matchPRSourceScopes(outsideFilter, [project], new Set([0])).included, false);
  const sources: PRRuleSource[] = [project, { kind: 'repository', repo: 'owner/repo' }];
  assert.equal(
    matchPRSourceScopes(outsideFilter, sources, new Set([0, 1])).included,
    true,
    'An explicitly selected repository remains an independent source',
  );
});

test('overlapping views retain provenance while field and option renames preserve saved IDs', () => {
  const second: PRRuleSource = {
    ...project,
    importedView: {
      number: 2,
      name: 'Another view',
      filter: 'is:pr',
      terms: compilePRProjectFilter('is:pr', 'project', fields),
    },
  };
  const matched = matchPRSourceScopes(subject, [project, second], new Set([0, 1]));
  assert(matched.included);
  assert(matched.reasons.some((reason) => reason.includes('Another view')));
  const renamed = [
    { ...fields[0], name: 'Workflow', options: [{ id: 'review', name: 'Needs review' }] },
  ];
  assert.deepEqual(
    projectBindingErrors(sourcePredicates(project), new Map([['project', renamed]])),
    [],
  );
  assert(matchPRSourceScopes(subject, [project], new Set([0])).included);
});

test('deleted fields/options and incompatible types invalidate evaluation even without PR candidates', () => {
  const predicates = sourcePredicates(project);
  assert.match(projectBindingErrors(predicates, new Map())[0], /unavailable/);
  assert.match(
    projectBindingErrors(predicates, new Map([['project', [{ ...fields[0], options: [] }]]]))[0],
    /option review/,
  );
  assert.match(
    projectBindingErrors(
      predicates,
      new Map([['project', [{ ...fields[0], dataType: 'NUMBER' }]]]),
    )[0],
    /incompatible/,
  );
});

test('unmapped terms and unknown Project facts cannot silently qualify a source', () => {
  const unmapped: PRRuleSource = {
    ...project,
    importedView: {
      number: 3,
      name: 'Unmapped',
      filter: 'assignee:@me',
      terms: compilePRProjectFilter('assignee:@me', 'project', fields),
    },
  };
  assert(unresolvedSourceFilters(unmapped).length);
  assert.equal(matchPRSourceScopes(subject, [unmapped], new Set([0])).included, false);
  const unknown = structuredClone(subject);
  unknown.facts.labels = { state: 'unknown', reason: 'Access lost' };
  const result = matchPRSourceScopes(unknown, [project], new Set([0]));
  assert.equal(result.included, false);
  assert(result.errors.includes('labels: Access lost'));
});
