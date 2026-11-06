import assert from 'node:assert/strict';
import test from 'node:test';

import {
  curateLearningEntries,
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

test('a single task requires a concrete money/order blocker, and covered checks drop', () => {
  const one = { ...keptCuration(context), observed: [keptCuration(context).observed[0]] };
  assert.equal(validateCuration(one, context).outcome, 'drop');
  assert.equal(
    validateCuration(
      {
        ...one,
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
