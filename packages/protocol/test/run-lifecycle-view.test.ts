import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockedRunReason,
  deriveRunLifecycleView,
  type Run,
  type RunGateReadiness,
  type RunStep,
  runStepDisplayDetail,
  runStepDisplayStatus,
} from '../src/index.js';

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
  for (const status of ['done', 'failed', 'cancelled', 'paused'] as const)
    assert.equal(deriveRunLifecycleView({ status, waitingForOperator }).activityLabel, undefined);
  assert.equal(
    deriveRunLifecycleView({ status: 'blocked', waitingForOperator }).activityLabel,
    'Blocked',
  );
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

// Run 4237202e (TAT-4158) as run.get returned it: the worker signaled blocked during monitor.
const blockedRun = {
  status: 'blocked' as const,
  error:
    'Step 6 recipe prerequisite cannot be met: the configured action catalog has no ' +
    'rendered order-book value/change timing observation to assert AC-3 refresh gaps ' +
    '<=500 ms. TASK.md requires every AC proven by an eligible hosted recipe assertion ' +
    'and CHECKLIST.md forbids implementation before the baseline gate. Analysis and ' +
    'missing proof actions are retained in artifacts/approach.md and artifacts/report.md; ' +
    'tracked source remains unchanged.',
  steps: [
    { name: 'find-slot', status: 'done' },
    { name: 'write-task', status: 'done' },
    { name: 'prepare', status: 'done' },
    { name: 'dispatch', status: 'done' },
    { name: 'monitor', status: 'done' },
    { name: 'review', status: 'skipped' },
    { name: 'complete', status: 'skipped' },
    { name: 'human-gate', status: 'skipped' },
    { name: 'finalize', status: 'skipped' },
    { name: 'ci-watch', status: 'skipped' },
  ] satisfies Pick<RunStep, 'name' | 'status'>[],
};

const displayStatuses = (
  run: Pick<Run, 'status'> & { steps: Pick<RunStep, 'name' | 'status'>[] },
) => run.steps.map((step) => runStepDisplayStatus(run, step));

test('a blocked run names its reason and the step it stopped at, not a finished pipeline', () => {
  assert.deepEqual(displayStatuses(blockedRun), [
    'done',
    'done',
    'done',
    'done',
    'blocked',
    'skipped',
    'skipped',
    'skipped',
    'skipped',
    'skipped',
  ]);
  const view = deriveRunLifecycleView(blockedRun);
  assert.equal(view.activityLabel, `Blocked: ${blockedRun.error}`);
  assert.match(view.activityLabel ?? '', /^Blocked: Step 6 recipe prerequisite cannot be met: /);
  assert.equal(view.tone, 'warn');
  assert.equal(blockedRunReason(' \n  first line  \nsecond'), 'first line');
  assert.equal(
    deriveRunLifecycleView({ status: 'blocked', error: '\n  Worker lost  \nstack' }).activityLabel,
    'Blocked: Worker lost',
  );
});

test('the step a blocked run stopped at carries its reason; other steps keep their detail', () => {
  const monitor = { name: 'monitor', status: 'done' as const, detail: 'Worker signaled blocked' };
  const run = {
    ...blockedRun,
    steps: blockedRun.steps.map((step) => (step.name === 'monitor' ? monitor : step)),
  };
  assert.equal(runStepDisplayDetail(run, monitor), blockedRun.error);
  assert.equal(runStepDisplayDetail({ ...run, error: undefined }, monitor), monitor.detail);
  assert.equal(runStepDisplayDetail({ ...run, status: 'failed' }, monitor), monitor.detail);
  assert.equal(
    runStepDisplayDetail(run, { name: 'dispatch', status: 'done', detail: 'Prompt sent' }),
    'Prompt sent',
  );
});

test('a blocked run with no error reads plain Blocked', () => {
  assert.equal(deriveRunLifecycleView({ status: 'blocked' }).activityLabel, 'Blocked');
  assert.equal(
    deriveRunLifecycleView({ status: 'blocked', error: ' \n ' }).activityLabel,
    'Blocked',
  );
});

test('a cancelled run skips its unfinished steps; done and failed runs show steps as recorded', () => {
  const steps: Pick<RunStep, 'name' | 'status'>[] = [
    { name: 'prepare', status: 'done' },
    { name: 'monitor', status: 'running' },
    { name: 'review', status: 'failed' },
    { name: 'complete', status: 'pending' },
    { name: 'finalize', status: 'skipped' },
  ];
  assert.deepEqual(displayStatuses({ status: 'cancelled', steps }), [
    'done',
    'skipped',
    'failed',
    'skipped',
    'skipped',
  ]);
  for (const status of ['done', 'failed'] as const) {
    assert.deepEqual(
      displayStatuses({ status, steps }),
      steps.map((step) => step.status),
    );
    assert.equal(deriveRunLifecycleView({ status, error: 'boom' }).activityLabel, undefined);
  }
});
