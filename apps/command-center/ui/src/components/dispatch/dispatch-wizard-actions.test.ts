import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ReviewContinuationContext } from '@farmslot/protocol';
import { executionModelFromSelection, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import {
  setObservedVisibleModels,
  visibleReviewDispatchCatalog,
} from '../../utils/runner-visible-models.js';

import type { DispatchPayloadDraftInput } from './dispatch-wizard-actions.js';
import { buildDispatchQueueAddParams, buildRunCreateParams } from './dispatch-wizard-payload.js';

mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
const { buildDispatchWizardPayloadDraft, dispatchWizardExecutionOptions } =
  await import('./dispatch-wizard-actions.js');
const { DispatchWizardState } = await import('./dispatch-wizard-state.js');

class DispatchStateFixture extends DispatchWizardState {}

const input: Omit<DispatchPayloadDraftInput, 'flowType' | 'runner' | 'model' | 'effort'> = {
  project: 'fixture',
  ticketId: 'fixture/repo#1',
  reviewMachine: 'review-node',
  slotOverride: '',
  allowedSlots: undefined,
  branch: undefined,
  app: undefined,
  taskTemplate: undefined,
  skipPrepare: false,
  prepareProfile: '',
  nudgeIntent: undefined,
  mode: 'autonomous',
  devInteractiveProfile: 'lightweight',
  comparison: {},
};

const lineage: ReviewContinuationContext = {
  repository: 'fixture/repo',
  prNumber: 1,
  reviewId: 'retained-review',
};

for (const transport of ['tmux', 'native'] as const) {
  test(`${transport} standalone WARM dispatch preserves selected lineage in direct and queued requests`, () => {
    const picker = new ReviewDispatchViewModel({
      context: { allowedActions: ['dispatch'], reviewLineages: [lineage] },
    });
    const row = picker.rows[0];
    picker.setRunner(row.id, 'codex');
    picker.setModel(row.id, 'gpt-6-astra');
    picker.setEffort(row.id, 'ultra');
    picker.setMode(row.id, 'warm');
    const draft = buildDispatchWizardPayloadDraft({
      ...input,
      transport,
      flowType: 'review-pr',
      ...dispatchWizardExecutionOptions('review-pr', picker),
    });
    assert.ok(draft);
    for (const payload of [buildRunCreateParams(draft), buildDispatchQueueAddParams(draft)]) {
      assert.equal(payload.reviewMode, 'warm');
      assert.deepEqual(payload.reviewContext, { reviewLineages: [lineage] });
      assert.equal(payload.reviewSequenceContext, undefined);
      assert.equal(payload.model, 'gpt-6-astra');
      assert.equal(payload.effort, 'ultra');
    }
  });
}

test('standalone WARM dispatch refuses an unbound retained review', () => {
  const picker = new ReviewDispatchViewModel({ context: { allowedActions: ['dispatch'] } });
  picker.setMode(picker.rows[0].id, 'warm');
  assert.throws(() => dispatchWizardExecutionOptions('review-pr', picker), /reviewId lineage/);
});

const observed = (models: string[], defaultModel: string) => [
  {
    runner: 'claude',
    models,
    pickerModels: models,
    defaultModel,
    defaultConfigured: true,
    configured: true,
  },
];

test('wizard runner defaults honor saved preferences without replacing restored model choices', () => {
  setObservedVisibleModels([]);
  try {
    const state = new DispatchStateFixture();
    setObservedVisibleModels(observed(['sonnet', 'opus'], 'sonnet'));
    state._executionPicker.setCatalog(visibleReviewDispatchCatalog());
    assert.equal(state._executionPicker.selection!.model, null);
    assert.equal(
      executionModelFromSelection(
        state._executionPicker.toSelection(),
        state._executionPicker.catalog,
      ).model,
      'sonnet',
    );
    const draft = buildDispatchWizardPayloadDraft({
      ...input,
      flowType: 'dev',
      ...dispatchWizardExecutionOptions('dev', state._executionPicker),
    });
    assert.ok(draft);
    assert.equal(buildRunCreateParams(draft).model, 'sonnet');
    assert.equal(buildDispatchQueueAddParams(draft).model, 'sonnet');

    state._model = 'opus';
    setObservedVisibleModels(observed(['haiku'], 'haiku'));
    state._executionPicker.setCatalog(visibleReviewDispatchCatalog());
    assert.equal(state._executionPicker.selection!.model, 'opus');
    assert.equal(dispatchWizardExecutionOptions('dev', state._executionPicker).model, 'opus');
  } finally {
    setObservedVisibleModels([]);
  }
});
