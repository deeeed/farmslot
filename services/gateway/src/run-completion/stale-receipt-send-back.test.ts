// 961d55d3 (TAT-4769): a stale CI receipt at COMPLETE sends the worker back once. The
// send-back replays from MONITOR, and that replay drops resolved decisions, so the
// "once" must be recorded where the real replay keeps it.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pendingResultDecision,
  type ResultDecisionPayload,
  type RunDecision,
} from '@farmslot/protocol';

import { runReplayStep } from '../methods/run/replay-step.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { sendBackStaleReceiptOnce } from './result-decision.js';

const stale = {
  code: 'deterministic-stale',
  prerequisite: 'deterministic' as const,
  reference: 'ci.local_check',
  message: 'REVIEW-FIX.md step 4 (ci.local_check) is stale.',
  actionId: 'hold',
};

function staleDecision(id: string, resolved: boolean): RunDecision {
  const payload: ResultDecisionPayload = {
    kind: 'result-decision',
    stoppedAt: 'complete',
    reason: 'COMPLETE was refused: 1 prerequisite not met.',
    refusal: { message: 'Deterministic CI gate blocked', reasons: [stale] },
    delivered: { reportPath: 'artifacts/report.md', manifestDigest: 'digest' },
    findingsDigest: 'digest',
    actions: [
      { id: 'send-back', available: true, requiresReason: false },
      { id: 'accept-result', available: false, requiresReason: true },
      { id: 'close-result', available: true, requiresReason: false },
    ],
  };
  return {
    id,
    type: 'engine_result_decision',
    title: 'result needs a decision',
    description: payload.reason,
    actions: [],
    createdAt: '2026-11-25T00:00:00.000Z',
    payload,
    ...(resolved ? { resolvedAt: '2026-11-25T00:01:00.000Z', resolvedAction: 'send-back' } : {}),
  };
}

test('961d55d3: the stale-receipt send-back stays spent across the real completion replay', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-stale-receipt',
    ticketOrPr: 'PROJ-4769',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'needs-decision',
    taskFile: '/tmp/example-stale-receipt/TASK.md',
    decisions: [staleDecision('first', true)],
    engineState: {
      ...getRun(run.id)!.engineState,
      staleReceiptSendBack: { decisionId: 'first', sentAt: '2026-11-25T00:01:00.000Z' },
    },
    steps: run.steps.map((step) => ({ ...step, status: 'done' })),
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor' }, () => {}, {
    startEngine: async () => {},
  });

  const replayed = getRun(run.id)!;
  assert.equal(
    replayed.decisions.some((entry) => entry.id === 'first'),
    false,
    'the replay drops the resolved send-back',
  );
  assert.equal(replayed.engineState?.staleReceiptSendBack?.decisionId, 'first');
  // COMPLETE refuses a stale receipt again: this one waits for a person.
  updateRun(run.id, { status: 'needs-decision', decisions: [staleDecision('second', false)] });
  assert.equal(await sendBackStaleReceiptOnce(getRun(run.id)!), false);
  assert.equal(pendingResultDecision(getRun(run.id)!)?.id, 'second');
});
