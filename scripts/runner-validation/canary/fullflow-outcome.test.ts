import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../../../packages/protocol/src/index.js';

import { fullflowCloseAction, fullflowFailure, fullflowGateFailure, fullflowNativeFailure, fullflowSummary, fullflowTerminal, fullflowTimings } from './fullflow-outcome.js';
import type { CheckResult } from './outcome.mjs';

test('step attribution quotes the engine refusal before later unfinished steps', () => {
  const detail = 'Baseline evidence is off the base: task-marker commit abc123';
  assert.equal(fullflowFailure({
    steps: [{ name: 'monitor', status: 'failed', detail }], decisions: [], error: 'Run failed',
  }), `monitor: ${detail}`);
});

test('waiting attribution preserves the decision message', () => {
  assert.equal(fullflowFailure({
    steps: [{ name: 'complete', status: 'running' }],
    decisions: [{ id: 'd', type: 'engine_worker_left_running', title: 'Blocked', description: 'Before evidence must be captured on its unchanged baseline.', actions: [], createdAt: '2026-11-08T00:00:00Z' }],
  }), 'complete: Before evidence must be captured on its unchanged baseline.');
});

test('normal publication and output cards are not product failures', () => {
  assert.equal(fullflowFailure({ steps: [{ name: 'human-gate', status: 'running' }], decisions:
    (['engine_human_gate', 'engine_output_review', 'retrospective'] as const).map((type) => ({
      id: type, type, title: 'Review the retained output', description: 'Close without publication', actions: [], createdAt: '2026-11-08T00:00:00Z',
    })),
  }), undefined);
});

for (const message of [
  'slot.release: slot is owned by a different run',
  'run.cancel: stop-runner: runner termination failed',
]) {
  test(`held cleanup preserves the thrown failure verbatim: ${message}`, () => {
    const run: Pick<Run, 'steps' | 'decisions' | 'error'> = {
      steps: [{ name: 'human-gate', status: 'skipped' }, { name: 'finalize', status: 'pending' }],
      decisions: [], error: 'canary: held publication verified; test cleanup',
    };
    assert.equal(fullflowFailure(run), undefined);
    assert.equal(fullflowFailure(run) ?? new Error(message).message, message);
    assert.equal(fullflowFailure({ ...run, error: 'Actual engine failure' }), 'run: Actual engine failure');
  });
}

test('publication always selects offered hold, including when a later close action appears', () => {
  const gate: Pick<Run['decisions'][number], 'type' | 'actions'> = {
    type: 'engine_human_gate', actions: [
      { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'request-review', label: 'Request Review', style: 'secondary' },
    ],
  };
  assert.equal(fullflowCloseAction(gate), 'hold');
  assert.equal(fullflowGateFailure(gate), undefined);
  const safe: typeof gate = { ...gate, actions: [...gate.actions, { id: 'decline', label: 'Decline', style: 'secondary' }] };
  assert.equal(fullflowCloseAction(safe), 'hold');
  assert.equal(fullflowGateFailure(safe), undefined);
  const noHold: typeof gate = { ...gate, actions: gate.actions.filter((action) => action.id !== 'hold') };
  assert.equal(fullflowCloseAction(noHold), undefined);
  assert.equal(fullflowGateFailure(noHold), 'human-gate: no hold action offered; offered: approve-publish, request-review');
});

test('fullflow status retains long reasons and makes one physical line', () => {
  const reason = `monitor: ${'exact engine message '.repeat(12)}\nsecond line`;
  const failed: CheckResult = {
    case: 'fix-bug', variant: '-', target: 'isolated', status: 'fail', model: 'haiku',
    modelCalls: 1, differences: [reason], observations: [],
  };
  assert.equal(fullflowSummary([failed, { ...failed, case: 'qa', status: 'pass', differences: [] }], 'fallback'),
    `1/2 checks pass; fix-bug ${reason.replace(/\s*\n\s*/g, ' ')}`);
  assert.equal(fullflowSummary([], 'could not run: no Claude'), '0/0 checks pass; could not run: no Claude');
});

test('normalized provider failure is retained verbatim ahead of unfinished monitor', () => {
  const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  const reason = fullflowNativeFailure({ steps: [{ name: 'monitor', status: 'running' }] }, [
    { sessionId: 's', sequence: 1, generation: 'g', at: '2026-11-08T00:00:00Z', type: 'error', text: message },
  ]);
  assert.equal(reason, `monitor: ${message}`);
  assert.equal(fullflowNativeFailure({ steps: [] }, [
    { sessionId: 's', sequence: 2, generation: 'g', at: '2026-11-08T00:00:00Z', type: 'text.delta', text: message },
  ]), undefined);
  assert.equal(fullflowNativeFailure({ steps: [{ name: 'monitor', status: 'running' }] }, [
    { sessionId: 's', sequence: 3, generation: 'g', at: '2026-11-08T00:00:00Z', type: 'turn.completed', status: 'interrupted', text: 'Pi interrupted' },
  ]), 'monitor: Pi interrupted');
});

test('interrupt finalizes running timing without extending completed steps', () => {
  assert.deepEqual(fullflowTimings({ steps: [
    { name: 'dispatch', status: 'done', startedAt: '2026-11-08T00:00:00Z', completedAt: '2026-11-08T00:00:02Z' },
    { name: 'monitor', status: 'running', startedAt: '2026-11-08T00:00:02Z' },
    { name: 'complete', status: 'pending' },
  ] }, Date.parse('2026-11-08T00:00:07Z')), { dispatch: 2, monitor: 5 });
  assert.equal(fullflowTerminal('decline'), 'cancelled');
  assert.equal(fullflowTerminal('hold'), 'cancelled');
  assert.equal(fullflowTerminal('close-run'), 'done');
});

test('shared timings keep completed-only defaults and round interruption durations', () => {
  const run: Pick<Run, 'steps'> = { steps: [
    { name: 'dispatch', status: 'done', startedAt: '2026-11-08T00:00:00Z', completedAt: '2026-11-08T00:00:02.140Z' },
    { name: 'monitor', status: 'running', startedAt: '2026-11-08T00:00:02Z' },
    { name: 'complete', status: 'pending' },
    { name: 'finalize', status: 'done', completedAt: '2026-11-08T00:00:07Z' },
  ] };
  assert.deepEqual(fullflowTimings(run), { dispatch: 2.1 });
  assert.deepEqual(fullflowTimings(run, Date.parse('2026-11-08T00:00:07.260Z')), { dispatch: 2.1, monitor: 5.3 });
  assert.deepEqual(fullflowTimings({ steps: [{ name: 'monitor', status: 'running', startedAt: '1969-12-31T23:59:59Z' }] }, 0), { monitor: 1 });
});
