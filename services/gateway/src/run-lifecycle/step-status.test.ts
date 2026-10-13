import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_STEPS, isTerminalRunStatus } from '@farmslot/protocol';

import { isCompletionPrerequisiteFailure, STEP_TO_STATUS } from './step-status.js';

test('every declared pipeline step has a nonterminal entry/recovery status', () => {
  for (const [flow, steps] of Object.entries(FLOW_STEPS)) {
    for (const step of steps)
      assert.ok(
        Boolean(STEP_TO_STATUS[step]) && !isTerminalRunStatus(STEP_TO_STATUS[step]),
        `${flow}/${step}`,
      );
  }
});

test('only a failed completion prerequisite retains ownership; replay and close release that fence', () => {
  const steps = [
    { name: 'complete', status: 'failed' as const, outputs: { gatePrerequisiteRefusal: {} } },
  ];
  assert.equal(isCompletionPrerequisiteFailure({ status: 'failed', steps }), true);
  for (const status of ['done', 'cancelled', 'completing'] as const)
    assert.equal(isCompletionPrerequisiteFailure({ status, steps }), false);
  assert.equal(
    isCompletionPrerequisiteFailure({
      status: 'failed',
      steps: [{ name: 'monitor', status: 'failed' }],
    }),
    false,
  );
  assert.equal(
    isCompletionPrerequisiteFailure({
      status: 'failed',
      steps: [{ name: 'complete', status: 'failed' }],
    }),
    false,
  );
});
