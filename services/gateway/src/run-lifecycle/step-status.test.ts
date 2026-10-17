import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_STEPS, isTerminalRunStatus } from '@farmslot/protocol';

import { STEP_TO_STATUS } from './step-status.js';

test('every declared pipeline step has a nonterminal entry/recovery status', () => {
  for (const [flow, steps] of Object.entries(FLOW_STEPS)) {
    for (const step of steps)
      assert.ok(
        Boolean(STEP_TO_STATUS[step]) && !isTerminalRunStatus(STEP_TO_STATUS[step]),
        `${flow}/${step}`,
      );
  }
});
