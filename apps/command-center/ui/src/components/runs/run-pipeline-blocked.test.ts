import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRunLifecycleView,
  type Run,
  type RunStep,
  runStepDisplayStatus,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import { litText } from '../../testing/lit-text.js';

import { computeLayout, type NodePos } from './run-pipeline-model.js';
import {
  renderHumanGatePipelineNode,
  renderMonitorPipelineNode,
  renderReviewPipelineNode,
  type RunPipelineSpecialNodeRenderContext,
} from './run-pipeline-special-node-renderers.js';
import { renderDefaultPipelineNode } from './run-pipeline-svg-renderers.js';

const reason =
  'Step 6 recipe prerequisite cannot be met: the configured action catalog has no rendered ' +
  'order-book value/change timing observation to assert AC-3 refresh gaps <=500 ms.';

// Run 4237202e (TAT-4158): the worker signaled blocked during monitor.
const blockedRun: Run = {
  id: '4237202e-c2a6-4b60-aa84-1c87ad22da6a',
  familyId: '4237202e-c2a6-4b60-aa84-1c87ad22da6a',
  lane: 'production',
  flowType: 'dev',
  mode: 'autonomous',
  status: 'blocked',
  error: reason,
  project: 'va-mmcx-terminal-farm',
  ticketOrPr: 'TAT-4158',
  slotId: 'macpro-mmt-2',
  branch: 'TAT-4158-feat-order-book-multi-feature-updat',
  taskFile: '/tmp/TASK.md',
  steps: (
    [
      ['find-slot', 'done'],
      ['write-task', 'done'],
      ['prepare', 'done'],
      ['dispatch', 'done'],
      ['monitor', 'done'],
      ['review', 'skipped'],
      ['complete', 'skipped'],
      ['human-gate', 'skipped'],
      ['finalize', 'skipped'],
      ['ci-watch', 'skipped'],
    ] as const
  ).map(([name, status]): RunStep => ({ name, status, durationMs: 60_000 })),
  decisions: [],
  metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol', disposition: 'blocked' },
  createdAt: '2026-10-19T12:38:57.615Z',
  updatedAt: '2026-10-19T12:53:19.034Z',
};

function nodeFor(run: Run, id: string): NodePos {
  const node = computeLayout(run).nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `${id} node is laid out`);
  return node;
}

function context(run: Run): RunPipelineSpecialNodeRenderContext {
  return {
    run,
    visibleStatus: (step) => runStepDisplayStatus(run, step),
    inlineCiFixActive: false,
    monitorTaskProgress: undefined,
    reviewTaskProgress: undefined,
    toggleProgressPanel: () => undefined,
    onStepSelect: () => undefined,
  };
}

test('a blocked run reads as blocked at the step it stopped at, with its reason', () => {
  assert.equal(deriveRunLifecycleView(blockedRun).activityLabel, `Blocked: ${reason}`);

  const monitor = litText(
    renderMonitorPipelineNode(nodeFor(blockedRun, 'monitor'), context(blockedRun)),
  );
  assert.match(monitor, /! blocked/);
  assert.match(monitor, new RegExp(`stroke="${colors.statusWarn}"`));
  assert.doesNotMatch(monitor, new RegExp(`stroke="${colors.statusOk}`));
  assert.ok(monitor.includes(`<title>${reason}</title>`));
  // With no recorded reason the stopped step falls back to its own detail.
  const noReason: Run = {
    ...blockedRun,
    error: undefined,
    steps: blockedRun.steps.map((step) =>
      step.name === 'monitor' ? { ...step, detail: 'Worker signaled blocked' } : step,
    ),
  };
  assert.ok(
    litText(renderMonitorPipelineNode(nodeFor(noReason, 'monitor'), context(noReason))).includes(
      '<title>Worker signaled blocked</title>',
    ),
  );

  const review = litText(
    renderReviewPipelineNode(nodeFor(blockedRun, 'review'), context(blockedRun)),
  );
  assert.match(review, /- skipped/);
  const dispatch = litText(
    renderDefaultPipelineNode(nodeFor(blockedRun, 'dispatch'), {
      run: blockedRun,
      visibleStatus: runStepDisplayStatus(blockedRun, nodeFor(blockedRun, 'dispatch').step),
      onStepSelect: () => undefined,
    }),
  );
  assert.match(dispatch, /v 1m/);
});

test('a step held on a decision keeps pulsing; a settled block does not', () => {
  const run: Run = {
    ...blockedRun,
    error: undefined,
    steps: blockedRun.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'running', detail: 'CI failed' }
        : step.status === 'skipped'
          ? { ...step, status: 'done' }
          : step,
    ),
    decisions: [
      {
        id: 'ci',
        type: 'ci_failure',
        title: 'CI failed',
        description: '',
        createdAt: '2026-10-19T13:00:00.000Z',
        actions: [],
      },
    ],
  };
  const ciWatch = nodeFor(run, 'ci-watch');
  const render = (candidate: Run) =>
    litText(
      renderDefaultPipelineNode(ciWatch, {
        run: candidate,
        visibleStatus: runStepDisplayStatus(candidate, ciWatch.step),
        onStepSelect: () => undefined,
      }),
    );
  const held = render(run);
  assert.match(held, /! blocked/);
  assert.match(held, /node-blocked-anim/);
  assert.match(held, /<title>CI failed<\/title>/);
  assert.doesNotMatch(render({ ...run, decisions: [] }), /node-blocked-anim/);
});

// Run 7721a02b (TAT-4006) as run.get returned it: blocked at the publish gate, its
// human gate decision open with the gate's readiness reason.
test('a run blocked at its open human gate shows the gate waiting with its readiness reason', () => {
  const gateReason = 'Review found 4 issues. Fix and pass review before publishing.';
  const run: Run = {
    ...blockedRun,
    id: '7721a02b-ceda-431a-a741-d743837c40b4',
    ticketOrPr: 'TAT-4006',
    error:
      'Native host stopped. Verify the old process group is stopped, then explicitly resume the saved native identity.',
    steps: blockedRun.steps.map((step) =>
      step.name === 'human-gate'
        ? { ...step, status: 'running', detail: 'Waiting for operator decision' }
        : ['finalize', 'ci-watch'].includes(step.name)
          ? { ...step, status: 'pending' }
          : { ...step, status: 'done' },
    ),
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'TAT-4006 — human gate',
        description: '',
        createdAt: '2026-10-19T17:30:13.466Z',
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: 'MetaMask/core',
          diffStat: { files: 7, additions: 507, deletions: 3 },
          workerReport: '',
          branch: 'TAT-4006-feat-add-environment-type-perps-eve',
          gateReadiness: {
            state: 'not-ready',
            identity: { runId: '7721a02b-ceda-431a-a741-d743837c40b4', generation: 8 },
            reasons: [{ code: 'review-fix-required', prerequisite: 'review', message: gateReason }],
          },
        },
      },
    ],
  };
  assert.equal(deriveRunLifecycleView(run).activityLabel, `Needs your decision: ${gateReason}`);
  const gate = litText(renderHumanGatePipelineNode(nodeFor(run, 'human-gate'), context(run)));
  assert.match(gate, /! waiting/);
  assert.match(gate, /node-blocked-anim/);
  assert.ok(gate.includes(`<title>${gateReason}</title>`));
});
