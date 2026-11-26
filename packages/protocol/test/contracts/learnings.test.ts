// Learnings v1 (ADR-026 Amendment 4): one checked format, and the rules that
// decide what a lesson may become.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideLearningKind,
  LEARNING_KIND_FIELDS,
  learningConfirmationIsOutside,
  parseLearnings,
  REVIEW_RULE_PROPOSAL_KINDS,
} from '../../src/contracts/index.js';

const H = '# Learnings v1\n\n';
const EDIT = `- edit: A price hook returned '$---' and a validator read it as a price.
  evidence: metamask-mobile app/components/UI/Perps/hooks/usePerpsLiquidationPrice.ts:102
  family: antipatterns.md#missing-numeric-data-stays-undefined
  confirmation: run 0f3c2a1b-77aa artifacts/review-ledger.md:40
`;
const issues = (text: string) => {
  const parsed = parseLearnings(text);
  assert.equal(parsed.version, 1);
  return parsed.version === 1 ? parsed.issues : [];
};

test('a v1 entry reads into its kind and fields', () => {
  const parsed = parseLearnings(H + EDIT);
  assert.equal(parsed.version, 1);
  if (parsed.version !== 1) return;
  assert.deepEqual(parsed.issues, []);
  const [entry] = parsed.entries;
  assert.equal(entry?.kind, 'edit');
  assert.equal(entry?.line, 3);
  assert.equal(entry?.source, EDIT.trimEnd());
  assert.deepEqual(entry?.evidence, [
    {
      repo: 'metamask-mobile',
      path: 'app/components/UI/Perps/hooks/usePerpsLiquidationPrice.ts',
      line: 102,
    },
  ]);
  assert.deepEqual(entry?.family, {
    file: 'antipatterns.md',
    anchor: 'missing-numeric-data-stays-undefined',
  });
  assert.deepEqual(entry?.confirmation, {
    kind: 'run',
    runId: '0f3c2a1b-77aa',
    path: 'artifacts/review-ledger.md',
    line: 40,
  });
});

test('each kind accepts its own fields', () => {
  for (const text of [
    '- None\n',
    '- add: Invalidate in-flight estimates.\n  evidence: metamask-mobile a.ts:9, core b.ts:3-7\n  examined: antipatterns.md#data-flow--state, antipatterns.mobile.md#x\n  confirmation: fix MetaMask/core#1\n',
    '- retire: The rule fires on every formatter.\n  evidence: core a.ts:9\n  family: antipatterns.md#shared-formatting\n  confirmation: none\n',
    '- recipe-broken: The selector moved.\n  recipe: perps/open.json#tap-long\n  failed: artifacts/recipe-runs/1/trace.json:4\n',
    '- recipe-missing: No margin-edit flow.\n  criterion: margin edit keeps TP/SL\n  searched: mm-harness run --list\n',
    '- workflow: Use the tag.\n',
  ])
    assert.deepEqual(issues(H + text), [], text);
  const parsed = parseLearnings(
    `${H}- add: x.\n  evidence: core a.ts:1\n  examined: antipatterns.md#data-flow--state\n  confirmation: none\n`,
  );
  assert.equal(
    parsed.version === 1 ? parsed.entries[0]?.examined?.[0]?.anchor : undefined,
    'data-flow-state',
  );
});

test('a malformed entry names its line and what is wrong', () => {
  const cases: [string, RegExp][] = [
    ['- add: x.\n  evidence: core a.ts:1\n  confirmation: none\n', /line 3: add needs examined/],
    ['- edit: x.\n  evidence: core a.ts:1\n  confirmation: none\n', /line 3: edit needs family/],
    ['- idea: x.\n', /line 3: unknown kind "idea"/],
    ['- edit: x.\n  evidence: a.ts:1\n', /line 4: evidence must be/],
    ['- edit: x.\n  family: Missing data\n', /line 4: family must be/],
    ['- edit: x.\n  confirmation: I checked it\n', /line 4: confirmation must be/],
    ['- edit: x.\n  confirmation: fix 1a2b3c4d\n', /line 4: confirmation must be/],
    ['- edit: x.\n  owner: me\n', /line 4: unknown field "owner"/],
    ['- workflow: x.\n  family: antipatterns.md#x\n', /line 4: family does not belong/],
    [
      '- recipe-broken: x.\n  recipe: a.json\n',
      /line 3: recipe-broken needs failed[\s\S]*line 4: recipe must be/,
    ],
    ['- edit: x.\n  family: a.md#x\n  family: a.md#y\n', /line 5: duplicate field "family"/],
    ['prose\n', /line 3: expected/],
    ['', /no entries; write "- None"/],
    [`${EDIT}\n- None\n`, /"- None" stands alone/],
  ];
  for (const [text, message] of cases) assert.match(issues(H + text).join('\n'), message, text);
});

test('a file without the v1 header is legacy and is not judged', () => {
  assert.deepEqual(parseLearnings('# Learnings\n\n- x\n'), { version: 'legacy' });
  assert.deepEqual(parseLearnings(''), { version: 'legacy' });
  assert.equal(parseLearnings(`\r\n${H}- None\r\n`).version, 1);
});

test('the rule kinds are review rule proposal kinds', () => {
  for (const kind of ['add', 'edit', 'retire'] as const) {
    assert.ok(REVIEW_RULE_PROPOSAL_KINDS.includes(kind));
    assert.ok(LEARNING_KIND_FIELDS[kind].includes('confirmation'));
  }
});

test('a run never confirms its own lesson', () => {
  const own = { runId: '0f3c2a1b-77aa-4b5c', prs: ['MetaMask/core#9', '#47777'] };
  for (const confirmation of [
    undefined,
    { kind: 'none' as const },
    { kind: 'run' as const, runId: '0f3c2a1b', path: 'artifacts/review.md' },
    { kind: 'run' as const, runId: '0f3c2a1b-77aa-4b5c', path: 'artifacts/review.md' },
    { kind: 'fix' as const, ref: 'metamask/core#9' },
    { kind: 'fix' as const, ref: 'MetaMask/metamask-extension#47777' },
  ])
    assert.equal(
      learningConfirmationIsOutside(confirmation, own),
      false,
      JSON.stringify(confirmation),
    );
  for (const confirmation of [
    { kind: 'run' as const, runId: '9e1d0c2b', path: 'artifacts/review-ledger.md' },
    { kind: 'fix' as const, ref: 'MetaMask/core#10' },
  ])
    assert.equal(learningConfirmationIsOutside(confirmation, own), true);
});

test('run results decide the rule kind', () => {
  const family = { file: 'antipatterns.md', anchor: 'missing-data' };
  const rows = (outcome: 'PASS' | 'FINDING') => [{ runId: 'r1', family: 'missing-data', outcome }];
  assert.deepEqual(decideLearningKind({ kind: 'edit', family }, rows('FINDING')), {
    kind: 'none',
    reason: 'antipatterns.md#missing-data recorded a FINDING in run r1: the rule worked',
  });
  assert.equal(decideLearningKind({ kind: 'retire', family }, rows('PASS')).kind, 'edit');
  assert.equal(decideLearningKind({ kind: 'edit', family }, rows('PASS')).kind, 'edit');
  assert.deepEqual(decideLearningKind({ kind: 'retire', family }, []), {
    kind: 'retire',
    basis: 'claim',
    reason: 'No review row records antipatterns.md#missing-data',
  });
  assert.equal(decideLearningKind({ kind: 'add' }, rows('FINDING')).kind, 'add');
  assert.equal(
    decideLearningKind({ kind: 'recipe-broken' }, rows('FINDING')).kind,
    'recipe-broken',
  );
});
