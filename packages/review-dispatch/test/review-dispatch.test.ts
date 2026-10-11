import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewSelection, ReviewSessionTrace, Run } from '@farmslot/protocol';

import {
  assertReviewPolicy,
  assertReviewRequestPayload,
  assertReviewSelection,
  assertReviewSequence,
  catalogWithRunnerModels,
  createReviewDispatchCatalog,
  executionModelFromSelection,
  resolveReviewDispatchDefaults,
  reviewContextFromRequest,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
  reviewRequestContextForPR,
  reviewRequestFromSequence,
  reviewSequenceFromRequest,
} from '../src/index.js';

const cold: ReviewSelection = {
  runner: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  mode: 'cold',
};
const lineage = { repository: 'owner/repo', prNumber: 1, reviewId: 'lineage-a' };

const warm: ReviewSelection = {
  runner: 'codex',
  model: 'gpt-6-astra',
  effort: 'ultra',
  mode: 'warm',
};

function picker(sequence = [cold, warm]) {
  return new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      allowSequence: true,
      reviewContext: {
        reviewLineages: sequence.map((row) => (row.mode === 'warm' ? lineage : null)),
      },
    },
    sequence,
  });
}

test('request receipt round-trips every dimension and row order without mutating input', () => {
  const sequence = [cold, warm, { ...cold, runner: 'pi', model: 'provider/model', effort: 'max' }];
  const receipt = reviewRequestFromSequence(sequence);
  assert.deepEqual(receipt, { ...cold, sequence: [warm, sequence[2]] });
  assert.deepEqual(reviewSequenceFromRequest(receipt), sequence);
  receipt.sequence![0].model = 'changed';
  assert.equal(sequence[1].model, 'gpt-6-astra');
});

test('null is an explicit default and a first row never gains another configurable field', () => {
  const selection: ReviewSelection = { runner: 'claude', model: null, effort: null, mode: 'cold' };
  assert.deepEqual(reviewRequestFromSequence([selection]), selection);
  assert.deepEqual(reviewSequenceFromRequest({ ...selection, sequence: [] }), [selection]);
  for (const key of ['runner', 'model', 'effort', 'mode']) {
    const partial = { ...selection } as Record<string, unknown>;
    delete partial[key];
    assert.throws(() => assertReviewSelection(partial));
  }
});

test('removed review fields and runner sentinel are rejected instead of normalized', () => {
  for (const [field, value] of Object.entries({
    crossRunner: true,
    requireCrossRunner: true,
    sessionIntent: 'resume',
    scope: 'incremental',
    order: 1,
    validationDepth: 'static-code',
  })) {
    assert.throws(() => assertReviewSelection({ ...cold, [field]: value }), /unsupported property/);
  }
  for (const runner of ['same', 'missing', ' codex', 'codex '])
    assert.throws(() => assertReviewSelection({ ...cold, runner }));
  assert.throws(() => assertReviewRequestPayload({ loops: [cold] }), /unsupported property/);
  assert.throws(() => assertReviewRequestPayload({ ...cold, mode: 'resume' }), /warm or cold/);
});

test('catalog validation accepts registered custom runners and refuses unsupported efforts', () => {
  const catalog = createReviewDispatchCatalog({
    runners: [
      {
        id: 'registered',
        models: [{ id: 'model', efforts: ['standard'] }],
        defaultModel: 'model',
        efforts: ['standard'],
        defaultEffort: 'standard',
        allowCustomModels: false,
      },
    ],
  });
  assert.doesNotThrow(() =>
    assertReviewSelection(
      { runner: 'registered', model: null, effort: null, mode: 'warm' },
      { catalog },
    ),
  );
  assert.throws(
    () =>
      assertReviewSelection(
        { runner: 'registered', model: 'missing', effort: null, mode: 'cold' },
        { catalog },
      ),
    /model/,
  );
  assert.throws(
    () => assertReviewSelection({ ...cold, model: 'gpt-6-luna', effort: 'ultra' }),
    /effort/,
  );
  assert.throws(
    () => assertReviewSelection({ runner: 'claude', model: null, effort: 'high', mode: 'cold' }),
    /effort/,
  );
});

test('configuration can clear its sequence and requests enforce their combined row limit', () => {
  assert.doesNotThrow(() => assertReviewSequence([]));
  assert.throws(() => assertReviewSequence([], { allowEmpty: false }), /at least one/);
  assert.throws(() => reviewRequestFromSequence([]), /at least one/);
  assert.throws(
    () => assertReviewRequestPayload({ ...cold, sequence: [warm] }, { allowSequence: false }),
    /at most 1/,
  );
  assert.throws(
    () => assertReviewRequestPayload({ ...cold, sequence: Array.from({ length: 5 }, () => warm) }),
    /at most 5/,
  );
});

test('WARM selection remains WARM across runner changes and is never inferred from runner diversity', () => {
  const vm = picker([warm]);
  const id = vm.rows[0].id;
  vm.setRunner(id, 'claude');
  assert.deepEqual(vm.toSelection(), { runner: 'claude', model: null, effort: null, mode: 'warm' });
  vm.setRunner(id, 'codex');
  vm.setModel(id, 'gpt-6-astra');
  vm.setEffort(id, 'ultra');
  assert.deepEqual(vm.toRequestPayload(), { ...warm, context: { reviewLineages: [lineage] } });
});

test('stable row IDs preserve host resource constraints through row reordering and removal', () => {
  const vm = picker();
  const [first, second] = vm.rows;
  const resources = new Map([
    [first.id, { allowedMachines: ['one'] }],
    [second.id, { allowedMachines: ['two'] }],
  ]);
  vm.moveRow(second.id, 0);
  assert.deepEqual(vm.toSequence(), [warm, cold]);
  assert.deepEqual(
    vm.toExecutionModels(resources).map((row) => [row.mode, row.allowedMachines]),
    [
      ['warm', ['two']],
      ['cold', ['one']],
    ],
  );
  vm.removeRow(first.id);
  assert.equal(vm.rows[0].id, second.id);
  assert.deepEqual(vm.toExecutionModels(resources)[0].allowedMachines, ['two']);
});

test('catalog updates preserve choices and expose unavailable capabilities as validation errors', () => {
  const vm = picker([warm]);
  const catalog = catalogWithRunnerModels(vm.catalog, {
    runner: 'codex',
    status: 'ready',
    source: 'structured-file',
    models: [{ id: 'gpt-6-astra', listed: true, reasoningModes: ['high'] }],
  });
  vm.setCatalog(catalog);
  assert.deepEqual(vm.rows[0].selection, warm);
  assert.equal(vm.canInvoke('request-review'), false);
  assert.match(vm.errors[0], /effort/);
  assert.throws(() => vm.toRequestPayload(), /effort/);
  vm.setEffort(vm.rows[0].id, 'high');
  assert.equal(vm.canInvoke('request-review'), true);
});

test('view model owns count limits and action permissions', () => {
  const vm = new ReviewDispatchViewModel({
    context: { allowedActions: ['configure'], allowSequence: true, allowEmpty: true },
    sequence: [],
  });
  assert.equal(vm.valid, true);
  assert.equal(vm.canInvoke('request-review'), false);
  assert.throws(() => vm.toRequestPayload(), /unavailable/);
  vm.addRow(cold);
  vm.removeRow(vm.rows[0].id);
  assert.deepEqual(vm.toDispatchOptions(), { reviewSequence: [] });
  for (let i = 0; i < 5; i++) vm.addRow(cold);
  assert.equal(vm.canAddRow, false);
  assert.throws(() => vm.addRow(cold), /at most 5/);
});

test('single-row execution has explicit effort defaults and shared project flow defaults', () => {
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['dispatch'],
      defaults: resolveReviewDispatchDefaults(
        { name: 'app', defaults: { dev: { runner: 'codex', model: 'gpt-6-luna', effort: 'max' } } },
        'dev',
      ),
    },
  });
  assert.deepEqual(vm.toSelection(), {
    runner: 'codex',
    model: 'gpt-6-luna',
    effort: 'max',
    mode: 'cold',
  });
  assert.deepEqual(
    vm.effortChoices(vm.rows[0].id).map((choice) => choice.value),
    [null, 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(
    executionModelFromSelection({ runner: 'codex', model: null, effort: null, mode: 'warm' }),
    { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'warm' },
  );
  assert.throws(() => vm.addRow(), /at most 1/);
});

test('row mutation notifications describe committed changes and invalid changes preserve prior state', () => {
  const vm = picker([cold]);
  let changes = 0;
  const unsubscribe = vm.subscribe(() => {
    changes++;
  });
  const id = vm.rows[0].id;
  assert.throws(() => vm.setEffort(id, 'nonsense'), /effort/);
  assert.deepEqual(vm.toSelection(), cold);
  assert.equal(changes, 0);
  vm.setMode(id, 'warm');
  assert.equal(changes, 1);
  unsubscribe();
  vm.setMode(id, 'cold');
  assert.equal(changes, 1);
});

test('policy validation rejects removed diversity/count policy fields', () => {
  assert.doesNotThrow(() => assertReviewPolicy({ minimumReviews: 2, requestedBy: 'dispatch' }));
  for (const policy of [
    { minimumReviews: -1, requestedBy: 'dispatch' },
    { minimumReviews: 1, requestedBy: 'worker' },
    { minimumReviews: 1, requestedBy: 'dispatch', requireCrossRunner: true },
    { minimumReviews: 1, requestedBy: 'dispatch', extraLoopsRequested: 1 },
  ])
    assert.throws(() => assertReviewPolicy(policy));
});

test('saved PR execution rows preserve explicit null defaults without letting resource input overwrite mode', () => {
  const selection: ReviewSelection = { runner: 'codex', model: null, effort: null, mode: 'warm' };
  const vm = picker([selection]);
  const resources = new Map([
    [vm.rows[0].id, { allowedSlots: ['slot'], mode: 'cold', model: 'foreign-model' }],
  ]);
  assert.deepEqual(vm.toExecutionModels(resources), [{ ...selection, allowedSlots: ['slot'] }]);
});

test('WARM lineage remains separate and follows row IDs through sequence reorder', () => {
  const vm = picker();
  vm.moveRow(vm.rows[1].id, 0);
  const request = vm.toRequestPayload();
  assert.deepEqual(reviewSequenceFromRequest(request), [warm, cold]);
  assert.deepEqual(reviewContextFromRequest(request), { reviewLineages: [lineage, null] });
  assert.equal(Object.keys(request).includes('reviewId'), false);
});

test('missing or ambiguous WARM context mounts as a visible invalid draft and never changes to COLD', () => {
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      reviewLineages: [lineage, { ...lineage, reviewId: 'lineage-b' }],
    },
    sequence: [warm],
  });
  assert.equal(vm.rows[0].selection.mode, 'warm');
  assert.equal(vm.valid, false);
  assert.equal(vm.canInvoke('request-review'), false);
  assert.match(vm.errors[0], /requires an unambiguous/);
  assert.throws(() => vm.toRequestPayload(), /requires an unambiguous/);
  vm.setContext({
    allowedActions: ['request-review'],
    reviewContext: { reviewLineages: [lineage] },
  });
  assert.deepEqual(vm.toSelection(), warm);
  assert.equal(vm.valid, true);
  vm.setRunner(vm.rows[0].id, 'claude');
  assert.deepEqual(vm.toReviewContext(), { reviewLineages: [lineage] });
});

test('only verified session/head traces seed exact PR provenance, without selecting by runner', () => {
  const trace: ReviewSessionTrace = {
    ...lineage,
    mode: 'cold',
    continuity: 'fresh',
    sessionId: 'session-a',
    lastReviewedHeadSha: 'head-a',
    runner: 'codex',
  };
  const run = (session: ReviewSessionTrace) =>
    ({
      decisions: [],
      reviewResult: { session, recommendation: 'pass', reviewMd: '', lineComments: [] },
    }) as Pick<Run, 'engineState' | 'decisions' | 'reviewResult' | 'repeatReviewContext'>;
  assert.deepEqual(reviewLineagesForRun(run(trace)), [lineage]);
  assert.deepEqual(reviewLineagesForRun(run({ ...trace, lastReviewedHeadSha: undefined })), []);
  assert.deepEqual(reviewLineagesForRun(run({ ...trace, continuity: 'refused' })), []);
  const runs = [run(trace), run({ ...trace, reviewId: 'lineage-b', runner: 'claude' })];
  const pr = { host: 'github.com', repo: 'owner/repo', number: 1 };
  assert.equal(reviewRequestContextForPR(runs, pr), undefined);
  assert.deepEqual(reviewRequestContextForPR(runs, pr, 'lineage-a'), { reviewLineages: [lineage] });
  assert.equal(reviewRequestContextForPR(runs, { ...pr, number: 2 }), undefined);
});

test('execution alternatives may continue one lineage while counted reviews cannot duplicate it', () => {
  const contexts = { reviewLineages: [lineage, lineage] };
  const alternative = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      allowSequence: true,
      sequenceRole: 'execution-alternatives',
      reviewContext: contexts,
    },
    sequence: [warm, { ...warm, model: 'gpt-6.1-sol' }],
  });
  assert.equal(alternative.valid, true);
  assert.equal(alternative.toExecutionModels().length, 2);
  const counted = new ReviewDispatchViewModel({
    context: { allowedActions: ['request-review'], allowSequence: true, reviewContext: contexts },
    sequence: [warm, warm],
  });
  assert.equal(counted.valid, false);
  assert.match(counted.errors[0], /same review lineage twice/);
});

test('publication sequences serialize their lineage separately from a primary review context', () => {
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['dispatch'],
      allowSequence: true,
      reviewContext: { reviewLineages: [lineage] },
    },
    sequence: [warm],
  });
  assert.deepEqual(vm.toDispatchOptions(), {
    reviewSequence: [warm],
    reviewSequenceContext: { reviewLineages: [lineage] },
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
});

test('QA execution does not validate or serialize dormant static-review lineage', () => {
  const vm = new ReviewDispatchViewModel({
    context: { allowedActions: ['configure'], sequenceRole: 'execution-alternatives' },
    sequence: [warm],
  });
  assert.equal(vm.valid, false);
  vm.setContext({
    allowedActions: ['configure'],
    sequenceRole: 'execution-alternatives',
    workflow: 'qa',
  });
  assert.equal(vm.valid, true);
  assert.equal(vm.toExecutionModels()[0].mode, 'warm');
  assert.equal(vm.toReviewContext(), undefined);
  vm.setContext({
    allowedActions: ['configure'],
    sequenceRole: 'execution-alternatives',
    workflow: 'review',
  });
  assert.equal(vm.valid, false);
  assert.equal(vm.rows[0].selection.mode, 'warm');
  assert.throws(
    () => vm.setContext({ allowedActions: ['request-review'], workflow: 'qa' }),
    /cannot request a static review/,
  );
});
