import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPRExecutionProfile,
  type ReviewSelection,
  type ReviewSessionTrace,
  type Run,
} from '@farmslot/protocol';

import {
  assertReviewPolicy,
  assertReviewRequestPayload,
  assertReviewSelection,
  assertReviewSequence,
  catalogWithRunnerModels,
  createReviewDispatchCatalog,
  executionModelFromSelection,
  executionModelsFromReviewSequence,
  parseReviewSequence,
  resolveReviewDispatchDefaults,
  resolveReviewMode,
  reviewContextFromRequest,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
  reviewRequestContextForPR,
  reviewRequestFromSequence,
  reviewSequenceForExecution,
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

test('review mode has one precedence across explicit selection, run, PR options and defaults', () => {
  const run = {
    reviewMode: 'warm',
    prWork: { review: { options: { mode: 'cold' } } },
    repeatReviewContext: { mode: 'cold' },
  } as Run;
  assert.equal(resolveReviewMode(), 'cold');
  assert.equal(resolveReviewMode({ run, explicitMode: 'cold', defaultMode: 'warm' }), 'cold');
  assert.equal(resolveReviewMode({ run, defaultMode: 'cold' }), 'warm');
  assert.equal(
    resolveReviewMode({ run: { ...run, reviewMode: 'cold' }, explicitMode: 'warm' }),
    'warm',
  );
  assert.equal(
    resolveReviewMode({ run: { ...run, reviewMode: undefined }, defaultMode: 'warm' }),
    'cold',
  );
  assert.equal(
    resolveReviewMode({
      run: { repeatReviewContext: { mode: 'warm' } as Run['repeatReviewContext'] },
      defaultMode: 'cold',
    }),
    'warm',
  );
  assert.equal(resolveReviewMode({ defaultMode: 'warm' }), 'warm');
  assert.equal(run.reviewMode, 'warm');
  assert.equal(run.prWork!.review!.options.mode, 'cold');
});

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
      familyId: 'family-a',
      decisions: [],
      reviewResult: { session, recommendation: 'pass', reviewMd: '', lineComments: [] },
    }) as Pick<
      Run,
      'familyId' | 'engineState' | 'decisions' | 'reviewResult' | 'repeatReviewContext'
    >;
  assert.deepEqual(reviewLineagesForRun(run(trace)), [lineage]);
  assert.deepEqual(reviewLineagesForRun(run({ ...trace, lastReviewedHeadSha: undefined })), []);
  assert.deepEqual(reviewLineagesForRun(run({ ...trace, continuity: 'refused' })), []);
  const runs = [run(trace), run({ ...trace, reviewId: 'lineage-b', runner: 'claude' })];
  const pr = { host: 'github.com', repo: 'owner/repo', number: 1 };
  assert.equal(reviewRequestContextForPR(runs, pr), undefined);
  assert.deepEqual(reviewRequestContextForPR(runs, pr, 'lineage-a'), { reviewLineages: [lineage] });
  assert.equal(reviewRequestContextForPR(runs, { ...pr, number: 2 }), undefined);
});

test('a lineage before a PR exists is keyed by its run family and stays valid', () => {
  const trace: ReviewSessionTrace = {
    mode: 'cold',
    continuity: 'fresh',
    reviewId: 'pipeline-review-run-a',
    sessionId: 'session-a',
    lastReviewedHeadSha: 'head-a',
    runner: 'codex',
  };
  const run = {
    familyId: 'family-a',
    decisions: [],
    reviewResult: { session: trace, recommendation: 'pass', reviewMd: '', lineComments: [] },
  } as Pick<Run, 'familyId' | 'engineState' | 'decisions' | 'reviewResult' | 'repeatReviewContext'>;
  const prePublish = { reviewId: 'pipeline-review-run-a', familyId: 'family-a' };
  assert.deepEqual(reviewLineagesForRun(run), [prePublish]);
  // A refused request's row ran no session; its earlier validated attempt keeps the lineage.
  const refused: ReviewSessionTrace = { mode: 'warm', continuity: 'refused', reviewId: 'rev-a' };
  assert.deepEqual(
    reviewLineagesForRun({
      familyId: 'family-a',
      decisions: [],
      engineState: {
        publishGate: {
          reviews: [
            {
              id: 'pipeline-review-rev-a',
              mode: 'warm',
              session: refused,
              loopNumber: 1,
              verdict: 'failed',
              unresolvedCount: 0,
              attempts: [
                {
                  mode: 'cold',
                  session: { ...trace, reviewId: 'rev-a' },
                  loopNumber: 1,
                  verdict: 'issues',
                  unresolvedCount: 1,
                },
                {
                  mode: 'warm',
                  session: refused,
                  loopNumber: 2,
                  verdict: 'failed',
                  unresolvedCount: 0,
                },
              ],
            },
          ],
        },
      },
    }),
    [{ reviewId: 'rev-a', familyId: 'family-a' }],
  );
  assert.deepEqual(
    reviewContextFromRequest({ ...warm, context: { reviewLineages: [prePublish] } }),
    { reviewLineages: [prePublish] },
  );
  assert.throws(
    () => assertReviewRequestPayload({ ...warm, context: { reviewLineages: [{ reviewId: 'x' }] } }),
    /run family or repository\/PR/,
  );
  assert.throws(
    () =>
      assertReviewRequestPayload({
        ...warm,
        context: { reviewLineages: [{ ...prePublish, repository: 'owner/repo' }] },
      }),
    /PR number/,
  );
});

test('a gate request preselects each row runner latest validated lineage in WARM, once', () => {
  const option = (reviewId: string, runner: string, reviewedAt: string, extra = {}) => ({
    context: { reviewId, familyId: 'family-a' },
    runner,
    model: `${runner}-model-${reviewId}`,
    effort: runner === 'codex' ? 'high' : null,
    reviewedAt,
    ...extra,
  });
  const lineageOptions = [
    option('older-codex', 'codex', '2026-10-20T10:00:00Z'),
    option('latest-codex', 'codex', '2026-10-20T12:00:00Z'),
    option('claude', 'claude', '2026-10-20T11:00:00Z', {
      unavailableReason: 'the retained reviewer belongs to a different slot',
    }),
  ];
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      allowSequence: true,
      lineageOptions,
      defaults: { runner: 'codex' },
    },
  });
  assert.deepEqual(vm.rows[0].selection, {
    runner: 'codex',
    model: 'codex-model-latest-codex',
    effort: 'high',
    mode: 'warm',
  });
  assert.deepEqual(vm.rows[0].context, { reviewId: 'latest-codex', familyId: 'family-a' });
  // A later row with the same runner takes that runner's next most recent lineage.
  vm.addRow({ runner: 'codex' });
  assert.equal(vm.rows[1].selection.mode, 'warm');
  assert.equal(vm.rows[1].context?.reviewId, 'older-codex');
  // No lineage left for the runner: a new review, COLD by default.
  vm.addRow({ runner: 'codex' });
  assert.equal(vm.rows[2].selection.mode, 'cold');
  assert.equal(vm.rows[2].context, null);
  assert.equal(vm.rows[2].note, undefined);
  // COLD changes stay explicit; WARM then inherits the retained model and effort.
  vm.setRunner(vm.rows[2].id, 'claude');
  assert.equal(vm.rows[2].selection.mode, 'cold');
  vm.setMode(vm.rows[2].id, 'warm');
  assert.equal(vm.rows[2].selection.mode, 'warm');
  assert.equal(vm.rows[2].selection.model, 'claude-model-claude');
  assert.match(vm.rows[2].note ?? '', /different slot/);
  assert.throws(() => vm.toRequestPayload(), /different slot/);
  // A fresh session requires the person's explicit COLD choice.
  vm.setMode(vm.rows[2].id, 'cold');
  assert.deepEqual(vm.toRequestPayload().context, {
    reviewLineages: [
      { reviewId: 'latest-codex', familyId: 'family-a' },
      { reviewId: 'older-codex', familyId: 'family-a' },
      { reviewId: 'claude', familyId: 'family-a' },
    ],
  });
  vm.setMode(vm.rows[2].id, 'warm');
  assert.throws(() => vm.toRequestPayload(), /different slot/);
});

test('a person choosing COLD at the gate keeps the review in its lineage', () => {
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      defaults: { runner: 'codex' },
      lineageOptions: [
        {
          context: { reviewId: 'lineage-a', familyId: 'family-a' },
          runner: 'codex',
          model: null,
          effort: null,
          reviewedAt: '2026-10-20T12:00:00Z',
        },
      ],
    },
  });
  assert.equal(vm.rows[0].selection.mode, 'warm');
  vm.setMode(vm.rows[0].id, 'cold');
  assert.deepEqual(vm.toRequestPayload(), {
    runner: 'codex',
    model: null,
    effort: null,
    mode: 'cold',
    context: { reviewLineages: [{ reviewId: 'lineage-a', familyId: 'family-a' }] },
  });
  // Outside a gate, a COLD row starts a new review as before.
  const dispatch = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      reviewContext: { reviewLineages: [lineage] },
    },
    sequence: [cold],
  });
  assert.equal(dispatch.toRequestPayload().context, undefined);
});

test('a runner change reallocates gate lineages so no two rows share one', () => {
  const option = (reviewId: string, runner: string, reviewedAt: string) => ({
    context: { reviewId, familyId: 'family-a' },
    runner,
    model: null,
    effort: null,
    reviewedAt,
  });
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      allowSequence: true,
      defaults: { runner: 'claude' },
      lineageOptions: [
        option('claude-lineage', 'claude', '2026-10-20T10:00:00Z'),
        option('codex-lineage', 'codex', '2026-10-20T11:00:00Z'),
      ],
    },
  });
  vm.setReviewContext(vm.rows[0].id, { reviewId: 'claude-lineage', familyId: 'family-a' });
  vm.addRow({ runner: 'codex' });
  assert.deepEqual(
    vm.rows.map((row) => [row.context?.reviewId ?? null, row.selection.mode]),
    [
      ['claude-lineage', 'warm'],
      ['codex-lineage', 'warm'],
    ],
  );
  // The first row takes codex's only lineage; the second row is now a new COLD review.
  vm.setMode(vm.rows[0].id, 'cold');
  vm.setRunner(vm.rows[0].id, 'codex');
  vm.setMode(vm.rows[0].id, 'warm');
  assert.deepEqual(
    vm.rows.map((row) => [row.context?.reviewId ?? null, row.selection.mode]),
    [
      ['codex-lineage', 'warm'],
      [null, 'cold'],
    ],
  );
  assert.equal(vm.valid, true);
  // A WARM row moved to a runner with no lineage starts a new COLD review.
  vm.setMode(vm.rows[0].id, 'cold');
  vm.setRunner(vm.rows[0].id, 'grok');
  assert.deepEqual(
    vm.rows.map((row) => [row.context?.reviewId ?? null, row.selection.mode]),
    [
      [null, 'cold'],
      ['codex-lineage', 'warm'],
    ],
  );
  assert.equal(vm.valid, true);
});

test('gate lineages arriving after the picker was built preselect its default rows', () => {
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      allowSequence: true,
      defaults: { runner: 'claude', model: 'claude-opus-5-5' },
    },
  });
  assert.equal(vm.rows[0].selection.mode, 'cold');
  vm.setContext({
    ...vm.context,
    lineageOptions: [
      {
        context: { reviewId: 'pipeline-review-run-a', familyId: 'family-a' },
        runner: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        reviewedAt: '2026-10-20T12:00:00Z',
      },
    ],
  });
  assert.equal(vm.rows[0].selection.mode, 'warm');
  assert.deepEqual(vm.toRequestPayload(), {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    mode: 'warm',
    context: { reviewLineages: [{ reviewId: 'pipeline-review-run-a', familyId: 'family-a' }] },
  });
  vm.setMode(vm.rows[0].id, 'cold');
  // A later refresh keeps the person's choice.
  vm.setContext({ ...vm.context });
  assert.equal(vm.rows[0].selection.mode, 'cold');
  assert.equal(vm.rows[0].context?.reviewId, 'pipeline-review-run-a');
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

test('a project WARM default starts COLD without lineage, while explicit WARM stays refused', () => {
  const vm = new ReviewDispatchViewModel({
    context: { allowedActions: ['request-review'], defaults: { mode: 'warm' } },
  });
  assert.equal(vm.selection?.mode, 'cold');
  assert.equal(vm.valid, true);
  vm.setMode(vm.rows[0].id, 'warm');
  assert.equal(vm.selection?.mode, 'warm');
  assert.equal(vm.canInvoke('request-review'), false);
});

for (const count of [6, 20]) {
  test(`${count}-alternative PR profiles open, reorder and serialize through the shared model`, () => {
    const sequence = Array.from({ length: count }, (_, index) => ({
      ...cold,
      model: index % 2 ? null : cold.model,
      effort: index % 2 ? null : cold.effort,
    }));
    const resources = sequence.map((_, index) => ({ allowedMachines: [`machine-${index}`] }));
    const models = executionModelsFromReviewSequence(sequence, resources);
    assertPRExecutionProfile({ workspacePolicy: { kind: 'pool' }, models });
    const context = {
      allowedActions: ['configure'] as const,
      allowSequence: true,
      sequenceRole: 'execution-alternatives' as const,
    };
    const vm = new ReviewDispatchViewModel({
      context,
      sequence: reviewSequenceForExecution(models),
    });
    const rowResources = new Map(vm.rows.map((row, index) => [row.id, resources[index]]));
    assert.equal(vm.valid, true);
    assert.equal(vm.canAddRow, count < 20);
    assert.deepEqual(vm.toExecutionModels(rowResources), models);
    assert.deepEqual(parseReviewSequence(sequence, context), sequence);
    vm.moveRow(vm.rows[count - 1].id, 0);
    assert.deepEqual(vm.toExecutionModels(rowResources), [
      models[count - 1],
      ...models.slice(0, -1),
    ]);
    assert.deepEqual(vm.toSequence(), [sequence[count - 1], ...sequence.slice(0, -1)]);
  });
}

test('execution alternatives stop at 20 while counted review serialization stops at 5', () => {
  const twenty = Array.from({ length: 20 }, () => ({ ...cold }));
  const options = { allowSequence: true, sequenceRole: 'execution-alternatives' as const };
  const vm = new ReviewDispatchViewModel({
    context: { ...options, allowedActions: ['configure'] },
    sequence: twenty,
  });
  assert.throws(() => vm.addRow(cold), /at most 20/);
  assert.throws(() => vm.setSequence([...twenty, cold]), /at most 20/);
  assert.equal(vm.toExecutionModels().length, 20);
  assert.throws(() => executionModelsFromReviewSequence([...twenty, cold]), /at most 20/);
  assert.throws(() => reviewSequenceForExecution([...twenty, cold]), /at most 20/);
  assert.throws(() => vm.toDispatchOptions(), /at most 5/);
  const six = twenty.slice(0, 6);
  assert.throws(
    () =>
      new ReviewDispatchViewModel({
        context: { allowedActions: ['request-review'], allowSequence: true },
        sequence: six,
      }),
    /at most 5/,
  );
  assert.throws(() => assertReviewSequence(six, { maxRows: 20 }), /at most 5/);
  assert.throws(() => reviewRequestFromSequence(six, options), /at most 5/);
  assert.throws(
    () => assertReviewRequestPayload({ ...cold, sequence: six.slice(1) }, options),
    /at most 5/,
  );
  assert.throws(
    () => reviewSequenceFromRequest({ ...cold, sequence: six.slice(1) }, options),
    /at most 5/,
  );
  assert.doesNotThrow(() => reviewRequestFromSequence(twenty.slice(0, 5)));
});

test('stored selection overrides inherit undefined fields and preserve explicit null defaults', () => {
  const project = {
    name: 'app',
    defaults: { dev: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
  };
  const fallback = { runner: 'claude', model: 'opus', effort: null, mode: 'cold' as const };
  assert.deepEqual(
    resolveReviewDispatchDefaults(project, 'dev', fallback, {
      runner: undefined,
      model: undefined,
      effort: undefined,
    }),
    cold,
  );
  assert.deepEqual(
    resolveReviewDispatchDefaults(project, 'dev', fallback, {
      runner: 'pi',
      model: null,
      effort: null,
    }),
    { runner: 'pi', model: null, effort: null, mode: 'cold' },
  );
  assert.deepEqual(
    resolveReviewDispatchDefaults(project, 'dev', fallback, {
      model: 'gpt-6-astra',
      effort: 'ultra',
      mode: 'warm',
    }),
    { runner: 'codex', model: 'gpt-6-astra', effort: 'ultra', mode: 'warm' },
  );
  assert.deepEqual(
    resolveReviewDispatchDefaults(undefined, 'dev', fallback, {
      model: undefined,
      effort: undefined,
    }),
    fallback,
  );
});

test('project review defaults contain only selection fields and preserve precedence', () => {
  const project = {
    name: 'app',
    defaults: {
      'review-pr': { runner: 'claude', model: 'sonnet', effort: 'high' },
      dev: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    },
    review: { enabled: true, max_retries: 2, review_timeout_min: 15, ...warm },
  };
  const fallback = { runner: 'pi', model: 'provider/model', effort: 'max', mode: 'cold' as const };
  const defaults = resolveReviewDispatchDefaults(project, 'review-pr', fallback);
  assert.deepEqual(defaults, warm);
  assertReviewSelection(defaults);
  assert.throws(() => assertReviewSelection(project.review), /unsupported property: enabled/);
  assert.deepEqual(resolveReviewDispatchDefaults(project, 'dev', fallback), cold);
  const partialProject = { ...project, review: { enabled: true, model: null, effort: null } };
  assert.deepEqual(resolveReviewDispatchDefaults(partialProject, 'review-pr', fallback), {
    runner: 'claude',
    model: null,
    effort: null,
    mode: 'cold',
  });
  assert.deepEqual(
    resolveReviewDispatchDefaults(project, 'review-pr', fallback, {
      runner: 'claude',
      model: null,
      effort: null,
      mode: 'cold',
    }),
    { runner: 'claude', model: null, effort: null, mode: 'cold' },
  );
});

test('model picker chips share filtering, custom selection and long-list policy', () => {
  const models = Array.from({ length: 9 }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index}`,
  }));
  const vm = new ReviewDispatchViewModel({
    context: { allowedActions: ['configure'] },
    catalog: {
      runners: [
        {
          id: 'codex',
          models,
          defaultModel: 'model-0',
          efforts: [],
          defaultEffort: null,
          allowCustomModels: true,
        },
      ],
    },
    sequence: [{ runner: 'codex', model: 'my-custom-model', effort: null, mode: 'cold' }],
  });
  const row = vm.rows[0].id;
  assert.deepEqual(vm.modelPickerState(row, 'MODEL 2'), {
    choices: [models[2]],
    customModel: true,
    searchable: true,
  });
  assert.equal(vm.toSequence()[0].model, 'my-custom-model');
  vm.setModel(row, 'model-2');
  assert.equal(vm.modelPickerState(row).customModel, false);
  assert.equal(vm.modelPickerState(row, 'missing').choices.length, 0);
  vm.setModel(row, null);
  assert.equal(vm.modelPickerState(row).customModel, false);
  vm.setCatalog({
    runners: [
      {
        id: 'codex',
        models: models.slice(0, 2),
        defaultModel: 'model-0',
        efforts: [],
        defaultEffort: null,
      },
    ],
  });
  assert.equal(vm.modelPickerState(row).searchable, false);
});

test('a retained Codex WARM review replaces COLD runner defaults in the request', () => {
  const retained = {
    context: { familyId: 'family-4190', reviewId: 'pipeline-review-fc324f59' },
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    reviewedAt: '2026-10-21T02:52:09Z',
  };
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      defaults: { runner: 'claude', model: 'claude-opus-5-5', mode: 'warm' },
      reviewLineages: [retained.context],
      lineageOptions: [retained],
    },
  });
  assert.deepEqual(vm.toRequestPayload(), {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    mode: 'warm',
    context: { reviewLineages: [retained.context] },
  });
  assert.equal(vm.executionLocked(vm.rows[0].id), true);
  assert.throws(() => vm.setRunner(vm.rows[0].id, 'claude'), /retained reviewer settings/);
  assert.throws(() => vm.setModel(vm.rows[0].id, 'gpt-6-astra'), /retained reviewer settings/);
  assert.throws(() => vm.setEffort(vm.rows[0].id, 'ultra'), /retained reviewer settings/);
});

test('selecting a retained WARM review fills its settings and refuses an unavailable session', () => {
  const retained = {
    context: { familyId: 'family-4190', reviewId: 'pipeline-review-fc324f59' },
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    reviewedAt: '2026-10-21T02:52:09Z',
    unavailableReason: 'The retained session cannot be resumed on this slot.',
  };
  const vm = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      defaults: { runner: 'claude', model: 'claude-opus-5-5' },
      reviewLineages: [retained.context],
      lineageOptions: [retained],
    },
  });
  const id = vm.rows[0].id;
  vm.setMode(id, 'warm');
  vm.setReviewContext(id, retained.context);
  assert.equal(vm.rows[0].selection.runner, 'codex');
  assert.equal(vm.rows[0].selection.model, 'gpt-6.1-sol');
  assert.equal(vm.rows[0].selection.effort, 'high');
  assert.equal(vm.canInvoke('request-review'), false);
  assert.match(vm.errors[0], /cannot be resumed/);
  assert.throws(() => vm.toRequestPayload(), /cannot be resumed/);
});
