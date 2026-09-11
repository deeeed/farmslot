import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '../../src/contracts/runs.js';
import {
  DEFAULT_MONITOR_EXTEND_MINUTES,
  INTERACTIVE_HANDOFF_EXTEND_ACTION,
  INTERACTIVE_HANDOFF_SIGNAL_ACTION,
  interactiveHandoffAllowsExtend,
  interactiveHandoffDecisionActions,
  interactiveHandoffExtendMinutes,
  isAllowedRunDecisionAction,
  parseInteractiveHandoffTimeoutMinutes,
  visibleInteractiveHandoffActions,
} from '../../src/runs/interactive-handoff.js';

function handoff(
  overrides: Partial<Pick<RunDecision, 'actions' | 'description' | 'context'>> = {},
): Pick<RunDecision, 'type' | 'actions' | 'description' | 'context'> {
  return {
    type: 'monitor_interactive_handoff',
    description: 'The agent did not write a terminal signal.',
    actions: [
      {
        id: INTERACTIVE_HANDOFF_SIGNAL_ACTION,
        label: 'Check SIGNAL.json & resume',
        style: 'primary',
      },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    ...overrides,
  };
}

test('parseInteractiveHandoffTimeoutMinutes reads the monitor timeout note', () => {
  assert.equal(parseInteractiveHandoffTimeoutMinutes(undefined), undefined);
  assert.equal(parseInteractiveHandoffTimeoutMinutes('Waiting for SIGNAL.json'), undefined);
  assert.equal(
    parseInteractiveHandoffTimeoutMinutes('Monitor note: exceeded 90 minute timeout.'),
    90,
  );
  assert.equal(
    parseInteractiveHandoffTimeoutMinutes(
      'The agent did not write a terminal signal.\n\nMonitor note: exceeded 150 minute timeout.',
    ),
    150,
  );
});

test('interactiveHandoffDecisionActions adds extend only when minutes are supplied', () => {
  const without = interactiveHandoffDecisionActions();
  assert.deepEqual(
    without.map((action) => action.id),
    [INTERACTIVE_HANDOFF_SIGNAL_ACTION, 'abort'],
  );

  const withExtend = interactiveHandoffDecisionActions({ extendMinutes: 90 });
  assert.deepEqual(
    withExtend.map((action) => action.id),
    [INTERACTIVE_HANDOFF_SIGNAL_ACTION, INTERACTIVE_HANDOFF_EXTEND_ACTION, 'abort'],
  );
  assert.equal(withExtend[1]?.label, 'Extend monitoring 90 min');
});

test('legacy timeout handoffs expose extend even when it was not persisted', () => {
  const decision = handoff({
    description:
      'The agent did not write a terminal signal.\n\nMonitor note: exceeded 90 minute timeout.',
  });
  assert.equal(interactiveHandoffAllowsExtend(decision), true);
  assert.equal(isAllowedRunDecisionAction(decision, INTERACTIVE_HANDOFF_EXTEND_ACTION), true);
  assert.equal(isAllowedRunDecisionAction(decision, 'not-a-real-action'), false);
  assert.deepEqual(
    visibleInteractiveHandoffActions(decision).map((action) => action.id),
    [INTERACTIVE_HANDOFF_SIGNAL_ACTION, INTERACTIVE_HANDOFF_EXTEND_ACTION, 'abort'],
  );
  assert.equal(interactiveHandoffExtendMinutes(decision), 90);
});

test('worker-done interactive handoffs do not get an implicit extend action', () => {
  const decision = handoff();
  assert.equal(interactiveHandoffAllowsExtend(decision), false);
  assert.equal(isAllowedRunDecisionAction(decision, INTERACTIVE_HANDOFF_EXTEND_ACTION), false);
  assert.deepEqual(
    visibleInteractiveHandoffActions(decision).map((action) => action.id),
    [INTERACTIVE_HANDOFF_SIGNAL_ACTION, 'abort'],
  );
  assert.equal(interactiveHandoffExtendMinutes(decision), DEFAULT_MONITOR_EXTEND_MINUTES);
});

test('persisted extendMinutes on context wins over the timeout note', () => {
  const decision = handoff({
    description: 'Monitor note: exceeded 90 minute timeout.',
    context: { extendMinutes: 180 },
  });
  assert.equal(interactiveHandoffExtendMinutes(decision), 180);
});
