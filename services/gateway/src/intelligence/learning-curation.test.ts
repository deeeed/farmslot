import assert from 'node:assert/strict';
import test from 'node:test';

import {
  curateLearningEntries,
  outcomeList,
  setLearningEvaluatorForTest,
  validateCuration,
} from './learning-curation.js';
import { curationFixture, keptCuration } from './learning-curation.test-support.js';

const context = curationFixture();

test('a confirmed recurring diff check keeps its exact source citations', () => {
  const result = validateCuration(keptCuration(context), context);
  assert.equal(result.outcome, 'keep');
  assert.equal(result.citations.length, 3);
});

test('unverified locations, self-confirmation and one-family repeats fail closed', () => {
  const eligible = keptCuration(context);
  assert.equal(
    validateCuration({ ...eligible, observed: [{ ...eligible.observed[0], line: 999 }] }, context)
      .outcome,
    'drop',
  );
  assert.equal(
    validateCuration({ ...eligible, confirmation: eligible.observed }, context).outcome,
    'drop',
  );
  const sameFamily = {
    ...context,
    evidence: context.evidence.map((d) => ({ ...d, familyId: 'one-task' })),
  };
  assert.equal(validateCuration(keptCuration(sameFamily), sameFamily).outcome, 'drop');
  const workerOnly = {
    ...context,
    evidence: context.evidence.map(({ confirms: _confirms, ...d }) => d),
  };
  assert.equal(validateCuration(keptCuration(workerOnly), workerOnly).outcome, 'drop');
});

test("a run's own review never confirms its lesson; an accepted PR comment fix does", () => {
  const source = context.evidence[0]!;
  const ownReview = {
    ...keptCuration(context),
    confirmation: [
      { runId: source.runId, path: source.path, line: 2, quote: source.text.split('\n')[1] },
    ],
  };
  assert.deepEqual(
    [validateCuration(ownReview, context).outcome, validateCuration(ownReview, context).reason],
    ['drop', 'Only the source run confirms the learning'],
  );
  const acceptedFix = {
    ...context,
    evidence: context.evidence.map((d, index) =>
      index === 0 ? { ...d, confirms: 'accepted-fix' as const } : d,
    ),
  };
  assert.equal(validateCuration(ownReview, acceptedFix).outcome, 'keep');
});

test('a single task requires a concrete money/order blocker, and covered checks drop', () => {
  const one = { ...keptCuration(context), observed: [keptCuration(context).observed[0]] };
  assert.equal(validateCuration(one, context).outcome, 'drop');
  assert.equal(
    validateCuration(
      {
        ...one,
        moneyOrderCitation: one.observed[0],
        moneyOrderBlocker:
          'Missing order size can submit the wrong amount; reviewer confirms the loss scenario.',
      },
      context,
    ).outcome,
    'keep',
  );
  assert.equal(
    validateCuration({ ...keptCuration(context), coverage: 'covered' }, context).outcome,
    'drop',
  );
  assert.equal(
    validateCuration(
      { ...keptCuration(context), coverage: 'tighten', gap: 'missing boundary' },
      context,
    ).outcome,
    'drop',
  );
  assert.equal(
    validateCuration(
      {
        ...keptCuration(context),
        coverage: 'tighten',
        gap: 'Add the verified missing boundary',
        rule: { path: 'review/antipatterns.md', line: 2, quote: 'Unrelated rule.' },
      },
      context,
    ).outcome,
    'keep',
  );
});

test('unavailable evidence, malformed provider output and exceptions produce one-line drops', async (t) => {
  assert.equal(
    (await curateLearningEntries(['claim'], { ...context, library: [] }))[0]?.outcome,
    'drop',
  );
  t.after(() => setLearningEvaluatorForTest());
  setLearningEvaluatorForTest(async () => [{ outcome: 'keep' }]);
  assert.equal((await curateLearningEntries(['claim'], context))[0]?.outcome, 'drop');
  setLearningEvaluatorForTest(async () => {
    throw new Error('provider\nunavailable');
  });
  const result = (await curateLearningEntries(['claim'], context))[0]!;
  assert.equal(result.outcome, 'drop');
  assert.equal(result.reason.includes('\n'), false);
});

// Run 6ae37c17 (2026-11-10): the model returned 6 outcomes for 5 lessons and the batch
// dropped all of them. Outcomes are matched by id, so a confused reply costs only the
// lessons it confuses.
test('each lesson gets exactly one outcome when the reply adds, repeats or omits entries', async (t) => {
  t.after(() => setLearningEvaluatorForTest());
  const kept = keptCuration(context);
  const sent: string[] = [];
  setLearningEvaluatorForTest(async (entries) => {
    sent.push(...entries.map(({ id }) => id));
    return [
      { id: 'L9', outcome: 'drop', reason: 'An entry nobody sent' },
      { id: 'L1', ...kept },
      { id: 'L2', outcome: 'drop', reason: 'First answer' },
      { id: 'L2', outcome: 'drop', reason: 'Second answer' },
    ];
  });
  const result = await curateLearningEntries(['first', 'second', 'third'], context);
  assert.deepEqual(sent, ['L1', 'L2', 'L3']);
  assert.deepEqual(
    result.map(({ outcome, reason, retryable }) => ({ outcome, reason, retryable })),
    [
      { outcome: 'keep', reason: kept.reason, retryable: undefined },
      {
        outcome: 'drop',
        reason: 'Curation returned 2 outcomes for this learning',
        retryable: true,
      },
      {
        outcome: 'drop',
        reason: 'Curation returned no outcome for this learning',
        retryable: true,
      },
    ],
  );
  setLearningEvaluatorForTest(async () => ({ results: [] }));
  assert.deepEqual(
    (await curateLearningEntries(['first', 'second'], context)).map((row) => row.reason),
    ['Curation reply is not a list of outcomes', 'Curation reply is not a list of outcomes'],
  );
});

test('the reply is read from its first complete JSON array of outcomes', () => {
  const rows = [{ id: 'L1', outcome: 'drop', reason: 'quote "a]b" and [c' }];
  const kept = { id: 'L2', outcome: 'keep', observed: [{ runId: 'r', line: 1 }] };
  for (const text of [
    JSON.stringify(rows),
    `\`\`\`json\n${JSON.stringify(rows)}\n\`\`\``,
    `Here are the outcomes:\n${JSON.stringify(rows)}\nNote: [L1] was a setup tip.`,
    `[not json] ${JSON.stringify(rows)}`,
    `Checked [1, 2] first. ${JSON.stringify(rows)}`,
  ])
    assert.deepEqual(outcomeList(text), rows);
  // Cut off at the token limit: the outer array never closes, and the inner list is no answer.
  const cut = `[${JSON.stringify(rows[0])}, ${JSON.stringify(kept).slice(0, -1)}`;
  assert.throws(() => outcomeList(cut), /no JSON array of outcomes/);
  assert.throws(() => outcomeList('no outcomes'), /no JSON array of outcomes/);
});
