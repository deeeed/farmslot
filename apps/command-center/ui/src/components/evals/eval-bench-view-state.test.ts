import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createViewStateContext, EVAL_BENCH_FILTERS, EVAL_BENCH_VIEW } from '@farmslot/protocol';
import { validViewRoute } from '@farmslot/protocol/surfaces/view-links';

test('benchmark choices use the shared context, preserve planner state and omit defaults', () => {
  let params = new URLSearchParams('state=planner&model=model-id&view=plan');
  const context = createViewStateContext({
    read: () => params,
    write: (next) => {
      params = next;
    },
    subscribe: () => () => {},
  });
  assert.equal(context.get(EVAL_BENCH_VIEW), 'plan');
  assert.equal(context.get(EVAL_BENCH_FILTERS.model), 'model-id');
  context.set(EVAL_BENCH_VIEW, 'results');
  context.set(EVAL_BENCH_FILTERS.problem, 'dev');
  assert.equal(params.has('view'), false);
  assert.equal(params.get('state'), 'planner');
  assert.equal(params.get('model'), 'model-id');
  context.set(EVAL_BENCH_FILTERS.model, '');
  assert.equal(params.has('model'), false);
  assert.equal(params.get('problem'), 'dev');
});

test('benchmark filter and planner choices survive the shared view-link contract', () => {
  assert.equal(
    validViewRoute('#evals?problem=dev&area=Core&size=medium&model=model-id&view=plan'),
    true,
  );
});
