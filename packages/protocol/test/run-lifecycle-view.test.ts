import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockedRunReason,
  deriveRunLifecycleView,
  openHumanGateDecision,
  type Run,
  runDisplayStatus,
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

// Runs 7721a02b (TAT-4006) and bda11b1a (TAT-4145) as run.get returned them on 2026-10-20:
// status blocked at the publish gate, human-gate running, an open engine_human_gate.
const gateSteps = [
  { name: 'find-slot', status: 'done' },
  { name: 'write-task', status: 'done' },
  { name: 'prepare', status: 'done' },
  { name: 'dispatch', status: 'done' },
  { name: 'monitor', status: 'done' },
  { name: 'review', status: 'done' },
  { name: 'complete', status: 'done' },
  { name: 'human-gate', status: 'running', detail: 'Waiting for operator decision' },
  { name: 'finalize', status: 'pending' },
  { name: 'ci-watch', status: 'pending' },
] satisfies Pick<RunStep, 'name' | 'status' | 'detail'>[];
const gate = (resolvedAt: string | undefined, ...messages: string[]) => ({
  type: 'engine_human_gate',
  ...(resolvedAt ? { resolvedAt } : {}),
  payload: {
    kind: 'ready',
    gateReadiness: {
      state: 'not-ready',
      identity: { runId: 'run', generation: 2, headSha: 'head' },
      reasons: messages.map((message) => ({
        code: 'review-fix-required',
        prerequisite: 'review',
        message,
      })),
    },
  },
});
const tat4006 = {
  status: 'blocked' as const,
  error:
    'Native host stopped. Verify the old process group is stopped, then explicitly resume the saved native identity.',
  steps: gateSteps,
  decisions: [
    gate(
      undefined,
      'Review found 4 issues. Fix and pass review before publishing.',
      'Required current-head reviews need valid structured result artifacts for this package. Review budget 7/7 is exhausted.',
    ),
  ],
};
const tat4145 = {
  status: 'blocked' as const,
  steps: gateSteps,
  decisions: [
    gate(
      '2026-10-19T19:44:41.545Z',
      'Review found 2 issues. Fix and pass review before publishing.',
    ),
    gate(undefined, 'Review found 2 issues. Fix and pass review before publishing.'),
  ],
};

test('a run blocked at its open human gate needs a decision and names the readiness reason', () => {
  for (const [run, reason] of [
    [tat4006, 'Review found 4 issues. Fix and pass review before publishing.'],
    [tat4145, 'Review found 2 issues. Fix and pass review before publishing.'],
  ] as const) {
    const view = deriveRunLifecycleView(run);
    assert.equal(view.label, 'Needs your decision');
    assert.equal(view.activityLabel, `Needs your decision: ${reason}`);
    assert.equal(runDisplayStatus(run), 'Needs your decision');
    const humanGate = run.steps.find((step) => step.name === 'human-gate')!;
    assert.equal(runStepDisplayStatus(run, humanGate), 'running');
    assert.equal(runStepDisplayDetail(run, humanGate), reason);
    assert.ok(!displayStatuses(run).includes('blocked'));
  }
  assert.equal(openHumanGateDecision(tat4145), tat4145.decisions[1]);
  const noReason = { ...tat4145, decisions: [{ type: 'engine_human_gate' }] };
  assert.equal(deriveRunLifecycleView(noReason).activityLabel, 'Needs your decision');
});

test('a blocked run with no open human gate still reads Blocked', () => {
  const resolved = {
    ...tat4006,
    decisions: [gate('2026-10-19T19:44:41.545Z', 'Review found 4 issues.')],
  };
  assert.equal(deriveRunLifecycleView(resolved).label, 'Blocked');
  assert.equal(deriveRunLifecycleView(resolved).activityLabel, `Blocked: ${tat4006.error}`);
  assert.equal(runDisplayStatus(resolved), 'blocked');
  assert.equal(deriveRunLifecycleView(blockedRun).activityLabel, `Blocked: ${blockedRun.error}`);
  assert.equal(runDisplayStatus({ ...tat4145, status: 'human-gating' }), 'human-gating');
  assert.equal(
    deriveRunLifecycleView({ ...tat4145, status: 'human-gating' }).label,
    'Awaiting decision',
  );
});
