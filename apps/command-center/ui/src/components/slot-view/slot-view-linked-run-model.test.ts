import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  isSlotViewTerminalRunStatus,
  shouldPreserveSlotViewCachedNullRun,
  slotViewLinkedRunTransition,
} from './slot-view-linked-run-model.js';

test('isSlotViewTerminalRunStatus recognizes terminal run statuses only', () => {
  assert.equal(isSlotViewTerminalRunStatus('done'), true);
  assert.equal(isSlotViewTerminalRunStatus('failed'), true);
  assert.equal(isSlotViewTerminalRunStatus('cancelled'), true);
  assert.equal(isSlotViewTerminalRunStatus('monitoring'), false);
  assert.equal(isSlotViewTerminalRunStatus(null), false);
});

test('shouldPreserveSlotViewCachedNullRun keeps prior identity for cache hydration misses', () => {
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'cache', previousRunId: 'run-1' }),
    true,
  );
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'cache', previousRunId: null }),
    false,
  );
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'rpc', previousRunId: 'run-1' }),
    false,
  );
});

test('slotViewLinkedRunTransition clears contexts when run changes or reaches terminal', () => {
  assert.deepEqual(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-2',
      prevRunStatus: 'running',
      nextRunStatus: 'running',
    }),
    {
      reachedTerminal: false,
      runChanged: true,
      shouldClearAgentContext: true,
      shouldResetUnavailableContexts: true,
      shouldRefreshMonitoringProgress: false,
    },
  );

  assert.deepEqual(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'monitoring',
      nextRunStatus: 'done',
    }),
    {
      reachedTerminal: true,
      runChanged: false,
      shouldClearAgentContext: true,
      shouldResetUnavailableContexts: false,
      shouldRefreshMonitoringProgress: false,
    },
  );
});

test('slotViewLinkedRunTransition refreshes progress on monitoring entry only', () => {
  assert.equal(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'running',
      nextRunStatus: 'monitoring',
    }).shouldRefreshMonitoringProgress,
    true,
  );
  assert.equal(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'monitoring',
      nextRunStatus: 'monitoring',
    }).shouldRefreshMonitoringProgress,
    false,
  );
});
