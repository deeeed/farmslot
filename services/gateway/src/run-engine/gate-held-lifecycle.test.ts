import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import {
  completeStepDisposition,
  isGateHeldPublicationRun,
} from './gate-held-lifecycle.js';
import { makeRun } from './test-fixtures.js';

test('isGateHeldPublicationRun is true for blocked runs awaiting publication gate', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', status: 'blocked' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  run.decisions = [
    {
      id: 'decision-1',
      type: 'engine_human_gate',
      title: 'Gate',
      description: 'Review package',
      actions: [],
      createdAt: new Date().toISOString(),
    },
  ];
  assert.equal(isGateHeldPublicationRun(run), true);
});

test('isGateHeldPublicationRun is false after gate-held complete without open decision', () => {
  const run = makeRun({ flowType: 'fix-bug', status: 'blocked' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  run.decisions = [
    {
      id: 'decision-1',
      type: 'engine_human_gate',
      title: 'Gate',
      description: 'Review package',
      actions: [],
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      resolvedAction: 'approve-publish',
    },
  ];
  assert.equal(isGateHeldPublicationRun(run), false);
});

test('completeStepDisposition reads COMPLETE step output', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous' });
  run.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
  ];
  assert.equal(completeStepDisposition(run), 'gate-held');
});