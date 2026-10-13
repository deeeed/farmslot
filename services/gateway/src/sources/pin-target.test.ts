import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSourcePinTarget, type SourcePinTargetState } from './pin-target.js';
import { sourceTestPlan } from './source.test-support.js';

const target = { scope: 'run' as const, targetId: 'run-1' };
const createdRun = (): NonNullable<SourcePinTargetState['run']> => ({
  id: 'run-1',
  createdAt: '2026-10-12T01:00:00Z',
  status: 'created',
  sourcePlan: sourceTestPlan(),
  steps: [],
  decisions: [],
  metrics: { nudgeCount: 0, model: null, runner: 'codex', runnerSessionId: null },
});

test('a real pending slot-picker wait permits pins before admission, while failed or resolved waits refuse', () => {
  const current = state();
  const run = current.run!;
  run.status = 'blocked';
  run.steps = [{ name: 'find-slot', status: 'running' }];
  run.decisions = [
    {
      id: 'pick-slot',
      type: 'engine_no_suitable_slot',
      title: 'No suitable slot',
      description: 'All allowed slots are occupied',
      actions: [],
      createdAt: run.createdAt,
      payload: { kind: 'slot_picker', project: 'demo', candidates: [], reason: 'no_free_slots' },
    },
  ];
  assert.doesNotThrow(() => assertSourcePinTarget(target, current));
  run.decisions[0].resolvedAt = run.createdAt;
  assert.throws(() => assertSourcePinTarget(target, current), /admitted or have effects/);
  delete run.decisions[0].resolvedAt;
  run.steps[0].status = 'failed';
  assert.throws(() => assertSourcePinTarget(target, current), /admitted or have effects/);
});
const state = (): SourcePinTargetState => ({
  knownNodes: ['node-1'],
  activatedAt: '2026-10-12T00:00:00Z',
  run: createdRun(),
});

test('only farm, configured nodes and known unstarted runs can own a pin', () => {
  assert.doesNotThrow(() => assertSourcePinTarget({ scope: 'farm', targetId: 'farm' }, state()));
  assert.doesNotThrow(() => assertSourcePinTarget({ scope: 'node', targetId: 'node-1' }, state()));
  assert.doesNotThrow(() => assertSourcePinTarget(target, state()));
  assert.throws(
    () => assertSourcePinTarget({ scope: 'node', targetId: 'unknown' }, state()),
    /Unknown source node/,
  );
  assert.throws(() => assertSourcePinTarget(target, { ...state(), run: undefined }), /Unknown/);
  assert.throws(
    () => assertSourcePinTarget({ ...target, targetId: 'sibling' }, state()),
    /Unknown source run/,
  );
});

test('historical, active and already-started runs refuse changing their inputs', () => {
  const current = state();
  const run = current.run!;
  run.createdAt = '2026-05-13T00:00:00Z';
  assert.throws(() => assertSourcePinTarget(target, current), /Historical/);
  run.createdAt = 'invalid';
  assert.throws(() => assertSourcePinTarget(target, current), /Historical/);
  run.createdAt = createdRun().createdAt;
  for (const status of ['monitoring', 'done', 'paused', 'blocked', 'cancelled'] as const) {
    run.status = status;
    assert.throws(() => assertSourcePinTarget(target, current), /admitted or have effects/);
  }
  run.status = 'created';
  run.steps = [{ name: 'write-task', status: 'done' }];
  assert.throws(() => assertSourcePinTarget(target, current), /effects/);
  run.steps = [];
  run.metrics.runnerSessionId = 'native-session';
  assert.throws(() => assertSourcePinTarget(target, current), /effects/);
});
