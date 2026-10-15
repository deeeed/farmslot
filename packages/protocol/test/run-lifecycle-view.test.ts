import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRunLifecycleView, type RunGateReadiness } from '../src/index.js';

const ready: RunGateReadiness = {
  state: 'ready',
  identity: { runId: 'run', generation: 2, headSha: 'head' },
  reasons: [],
};

test('operator activity names the dependency without authorizing a gate transition', () => {
  const waitingForOperator = {
    who: 'release owner',
    reason: 'Review the approach before continuing',
    since: '2026-10-15T00:00:00.000Z',
  };
  const view = deriveRunLifecycleView({
    status: 'monitoring',
    waitingForOperator,
    gateReadiness: ready,
  });
  assert.equal(view.activityLabel, 'Waiting on operator: release owner');
  assert.equal(view.status, 'monitoring');
  assert.equal(view.canAdvance, false);
  for (const status of ['done', 'failed', 'cancelled', 'blocked', 'paused'] as const)
    assert.equal(deriveRunLifecycleView({ status, waitingForOperator }).activityLabel, undefined);
});

test('a retained ready snapshot cannot expose advancement during a correction or uncertain delivery', () => {
  for (const status of ['fixing', 'reviewing', 'reconciling', 'review-failed'] as const) {
    const view = deriveRunLifecycleView({ status, gateReadiness: ready });
    assert.equal(view.canAdvance, false);
    assert.notEqual(view.gateLabel, 'Ready for decision');
  }
  assert.equal(
    deriveRunLifecycleView({ status: 'human-gating', gateReadiness: ready }).canAdvance,
    true,
  );
});

test('the shared view retains the gateway refusal and distinguishes reviewer failure', () => {
  const reason = {
    code: 'acceptance-unrecorded',
    prerequisite: 'acceptance' as const,
    message: '11 acceptance criteria need a verdict.',
  };
  const view = deriveRunLifecycleView({
    status: 'human-gating',
    gateReadiness: { ...ready, state: 'not-ready', reasons: [reason] },
  });
  assert.equal(view.gateLabel, 'Prerequisites incomplete');
  assert.deepEqual(view.reasons, [reason]);
  assert.equal(view.canAdvance, false);
  assert.equal(deriveRunLifecycleView({ status: 'review-failed' }).label, 'Review failed');
});
