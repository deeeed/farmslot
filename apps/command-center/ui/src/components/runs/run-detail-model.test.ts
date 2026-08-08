import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyObservabilityArtifact,
  PRStatus,
  RecipeRunArtifactGroup,
  Run,
  RunStep,
} from '@farmslot/protocol';
import {
  CI_FIX_CHECKLIST,
  SELF_REVIEW_CHECKLIST,
  SELF_REVIEW_FIX_CHECKLIST,
  TASK_PROGRESS_MARKDOWN,
} from '@farmslot/protocol/checklist-target';

import {
  buildRerunAlongsideHref,
  buildRunDiagnosisPrompt,
  canReplayRunSteps,
  hasActiveInlineCiFix,
  INTERACTIVE_DEV_ACTIONS,
  isActiveInteractiveDevRun,
  isLiveTimeoutPrStatusAllGreen,
  isTaskProgressRunActive,
  pendingCITimeoutDecision,
  readCiWatchOutputs,
  runDetailDesiredRecipeRunId,
  runEvidenceLightboxItems,
  runEvidenceSummary,
  runFamilyPrStatus,
  shouldAcceptTaskProgressUpdate,
  shouldShowRunCiStatus,
} from './run-detail-model.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farmslot-farm',
    ticketOrPr: 'BUG-123',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      runner: 'codex',
      model: 'gpt-5.4',
    },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

const artifact: FamilyObservabilityArtifact = {
  runId: 'run-1',
  familyId: 'family-1',
  stepName: 'complete',
  path: 'artifacts/final.png',
  purpose: 'screenshot',
  source: 'step-output',
};

function recipeRun(id: string): RecipeRunArtifactGroup {
  return {
    id,
    label: id,
    groupKind: 'live-run',
    promoted: false,
    status: 'unknown',
    source: 'recipe-run-live',
    recipeRunId: id,
    artifactRoot: null,
    artifactManifest: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    selectionReason: 'latest-run',
  };
}

test('readCiWatchOutputs normalizes persisted ci-watch step output bags', () => {
  const outputs: RunStep['outputs'] = {
    checkSummary: { passed: 1, failed: 2, pending: 3, skipped: 0, total: 6 },
    checkTimeline: [
      {
        timestamp: '2026-05-14T00:00:00.000Z',
        status: '1/6 passed, 2 failed, 3 pending',
        detail: 'waiting',
      },
    ],
    passedNames: ['unit'],
    failedChecks: ['lint'],
    pendingNames: ['e2e'],
    pollCount: 4,
    pollIntervalMs: 60_000,
    phase: 'fixing',
    fixInProgress: true,
    fixTrigger: 'failed_checks',
    fixProgress: { completed: 1, total: 2, currentLabel: 'lint' },
    activeTaskFile: '/tmp/TASK.md',
  };

  const normalized = readCiWatchOutputs(outputs);

  assert.deepEqual(normalized?.checkSummary, {
    passed: 1,
    failed: 2,
    pending: 3,
    skipped: 0,
    total: 6,
  });
  assert.deepEqual(normalized?.failedNames, ['lint']);
  assert.equal(normalized?.phase, 'fixing');
  assert.equal(normalized?.fixInProgress, true);
  assert.deepEqual(normalized?.fixProgress, { completed: 1, total: 2, currentLabel: 'lint' });
});

test('readCiWatchOutputs preserves failedNames precedence even when empty', () => {
  const outputs: RunStep['outputs'] = {
    failedNames: [],
    failedChecks: ['fallback-check'],
  };

  assert.deepEqual(readCiWatchOutputs(outputs)?.failedNames, []);
});

test('readCiWatchOutputs drops unknown ci-watch fix trigger strings', () => {
  const outputs: RunStep['outputs'] = {
    fixTrigger: 'legacy-shape-drift',
  };

  assert.equal(readCiWatchOutputs(outputs)?.fixTrigger, undefined);
});

test('runEvidenceSummary renders artifact-only replay copy and complete-step status', () => {
  const run = makeRun({
    completionPolicy: 'artifact-only',
    startRef: {
      requestedRef: 'main',
      resolvedSha: 'abc123',
    },
    steps: [{ name: 'complete', status: 'failed', durationMs: 1234 }],
  });

  const summary = runEvidenceSummary(run, [artifact]);

  assert.equal(summary.shouldRender, true);
  assert.equal(summary.title, 'Replay evidence');
  assert.equal(summary.badge, 'comparison · artifact-only');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.completeStep?.durationMs, 1234);
  assert.equal(summary.showEvalPackageHint, true);
  assert.match(summary.copy, /abc123/);
  assert.match(summary.copy, /eval Reference and Candidate packages/);
});

test('runEvidenceSummary hides non-replay runs without collected artifacts', () => {
  assert.equal(runEvidenceSummary(makeRun({ status: 'done' }), []).shouldRender, false);
  assert.equal(runEvidenceSummary(makeRun({ status: 'failed' }), [artifact]).status, 'failed');
});

test('runEvidenceLightboxItems derives stable captions from artifact provenance', () => {
  const items = runEvidenceLightboxItems([artifact], (entry) => `/artifact/${entry.runId}`);

  assert.deepEqual(items, [
    {
      url: '/artifact/run-1',
      path: 'artifacts/final.png',
      purpose: 'screenshot',
      caption: 'step complete · step output',
    },
  ]);
});

test('buildRunDiagnosisPrompt includes failure context and omits blank optional fields', () => {
  const prompt = buildRunDiagnosisPrompt(
    makeRun({
      id: 'run-failed',
      status: 'failed',
      ticketOrPr: 'BUG-456',
      flowType: 'review-pr',
      slotId: 'runner-a-mobile-1',
      error: 'Worker exited',
      steps: [
        { name: 'prepare', status: 'done' },
        { name: 'review', status: 'failed' },
        { name: 'complete', status: 'failed' },
      ],
    }),
  );

  assert.match(prompt, /^Why did run run-failed fail\?/);
  assert.match(prompt, /Ticket or PR: BUG-456/);
  assert.match(prompt, /Flow: review-pr/);
  assert.match(prompt, /Slot: runner-a-mobile-1/);
  assert.match(prompt, /Run error: Worker exited/);
  assert.match(prompt, /Failed steps: review, complete/);
  assert.match(prompt, /propose_run_recovery/);

  const minimal = buildRunDiagnosisPrompt(makeRun({ slotId: null, error: undefined, steps: [] }));
  assert.doesNotMatch(minimal, /Slot:/);
  assert.doesNotMatch(minimal, /Run error:/);
  assert.doesNotMatch(minimal, /Failed steps:/);
});

test('buildRerunAlongsideHref creates comparison dispatch prefill with baseline runner/model', () => {
  const href = buildRerunAlongsideHref(
    makeRun({
      id: 'run 1',
      familyId: 'family/1',
      flowType: 'review-pr',
      ticketOrPr: 'https://github.com/org/repo/pull/90',
      project: 'command-center',
      metrics: {
        nudgeCount: 0,
        runner: 'codex',
        model: 'gpt-5.4 mini',
      },
    }),
    '#run/run-1?machines=macwork',
  );

  assert.equal(
    href,
    '#dispatch?flow=review-pr&ticket=https%3A%2F%2Fgithub.com%2Forg%2Frepo%2Fpull%2F90&project=command-center&lane=comparison&familyId=family%2F1&parentRunId=run+1&runner=codex&model=gpt-5.4+mini&variant=codex-gpt-5-4-mini&machines=macwork',
  );
});

test('buildRerunAlongsideHref omits runner/model when baseline engine is unknown', () => {
  const href = buildRerunAlongsideHref(
    makeRun({
      metrics: {
        nudgeCount: 0,
        runner: null,
        model: null,
      },
    }),
  );

  assert.equal(
    href,
    '#dispatch?flow=fix-bug&ticket=BUG-123&project=farmslot-farm&lane=comparison&familyId=family-1&parentRunId=run-1',
  );
});

test('canReplayRunSteps allows terminal runs when actions are not blocked', () => {
  assert.equal(canReplayRunSteps(makeRun({ status: 'failed' })), true);
  assert.equal(canReplayRunSteps(makeRun({ status: 'done' })), true);
  assert.equal(canReplayRunSteps(makeRun({ status: 'cancelled' })), true);
  assert.equal(canReplayRunSteps(makeRun({ status: 'blocked' })), true);
  assert.equal(
    canReplayRunSteps(
      makeRun({
        status: 'blocked',
        decisions: [
          {
            id: 'decision-1',
            type: 'engine_human_gate',
            title: 'Publication gate',
            description: 'Waiting for operator',
            actions: [],
            createdAt: '2026-05-14T00:00:00.000Z',
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(canReplayRunSteps(makeRun({ status: 'monitoring' })), false);
  assert.equal(canReplayRunSteps(makeRun({ status: 'failed' }), true), false);
  assert.equal(canReplayRunSteps(null), false);
});

test('run detail recipe selection preserves pending current gateway precedence', () => {
  const recipeRuns = [recipeRun('first'), recipeRun('pending'), recipeRun('current')];

  assert.equal(
    runDetailDesiredRecipeRunId({
      recipeRuns,
      pendingRecipeRunId: 'pending',
      currentRecipeRunId: 'current',
      gatewaySelectedRecipeRunId: 'first',
    }),
    'pending',
  );
  assert.equal(
    runDetailDesiredRecipeRunId({
      recipeRuns,
      pendingRecipeRunId: 'missing',
      currentRecipeRunId: 'current',
      gatewaySelectedRecipeRunId: 'first',
    }),
    'current',
  );
  assert.equal(
    runDetailDesiredRecipeRunId({
      recipeRuns,
      pendingRecipeRunId: 'missing',
      currentRecipeRunId: 'also-missing',
      gatewaySelectedRecipeRunId: 'first',
    }),
    'first',
  );
});

test('run detail recipe selection defaults to first run when desired ids are unavailable', () => {
  assert.equal(
    runDetailDesiredRecipeRunId({
      recipeRuns: [recipeRun('first')],
      pendingRecipeRunId: 'missing',
      currentRecipeRunId: '',
      gatewaySelectedRecipeRunId: null,
    }),
    'first',
  );
  assert.equal(
    runDetailDesiredRecipeRunId({
      recipeRuns: [],
      pendingRecipeRunId: 'missing',
      currentRecipeRunId: '',
      gatewaySelectedRecipeRunId: null,
    }),
    '',
  );
});

test('run detail CI timeout helpers derive pending decisions and all-green state', () => {
  const pendingDecision: Run['decisions'][number] = {
    id: 'decision-1',
    type: 'ci_ci_timeout',
    title: 'CI timeout',
    description: 'Continue?',
    actions: [],
    createdAt: '2026-05-14T00:00:00.000Z',
  };
  const run = makeRun({
    status: 'monitoring',
    steps: [{ name: 'ci-watch', status: 'running' }],
    decisions: [pendingDecision],
  });

  assert.equal(pendingCITimeoutDecision(run), pendingDecision);
  assert.equal(shouldShowRunCiStatus(run), true);
  assert.equal(shouldShowRunCiStatus(makeRun({ status: 'ci-watching' })), true);
  assert.equal(shouldShowRunCiStatus(makeRun()), false);
  assert.equal(
    isLiveTimeoutPrStatusAllGreen({
      checkSummary: { passed: 2, failed: 0, pending: 0, skipped: 0, total: 2 },
    }),
    true,
  );
  assert.equal(
    isLiveTimeoutPrStatusAllGreen({
      checkSummary: { passed: 1, failed: 0, pending: 1, skipped: 0, total: 2 },
    }),
    false,
  );
  assert.equal(isLiveTimeoutPrStatusAllGreen(null), false);
});

test('runFamilyPrStatus resolves PR status from sibling runs in the same family', () => {
  const selected = makeRun({ id: 'selected', familyId: 'family-a', prNumber: undefined });
  const siblingWithPr = makeRun({ id: 'sibling', familyId: 'family-a', prNumber: 42 });
  const otherFamily = makeRun({ id: 'other', familyId: 'family-b', prNumber: 7 });
  const prs = [
    { pr: 7, prState: 'OPEN' },
    { pr: 42, prState: 'MERGED' },
  ] as unknown as PRStatus[];

  assert.equal(runFamilyPrStatus(selected, [selected, siblingWithPr, otherFamily], prs), prs[1]);
  assert.equal(runFamilyPrStatus(selected, [selected], prs), null);
});

test('run detail task-progress helpers preserve worker active and self-review filtering rules', () => {
  assert.equal(isTaskProgressRunActive(makeRun({ status: 'monitoring' })), true);
  assert.equal(isTaskProgressRunActive(makeRun({ status: 'completing' })), false);
  assert.equal(
    isTaskProgressRunActive(makeRun({ status: 'completing' }), { includeCompleting: true }),
    true,
  );
  assert.equal(
    isTaskProgressRunActive(
      makeRun({
        status: 'done',
        taskFile: TASK_PROGRESS_MARKDOWN,
        activeTaskFile: SELF_REVIEW_CHECKLIST,
      }),
    ),
    true,
  );
  assert.equal(
    hasActiveInlineCiFix(
      makeRun({
        steps: [
          {
            name: 'ci-watch',
            status: 'running',
            outputs: { fixInProgress: true, phase: 'waiting_for_worker' },
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: SELF_REVIEW_CHECKLIST }),
      { contextId: 'self-review' },
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: SELF_REVIEW_CHECKLIST }),
      { contextId: 'worker' },
    ),
    false,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: SELF_REVIEW_FIX_CHECKLIST }),
      { contextId: 'self-review-fix' },
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: SELF_REVIEW_FIX_CHECKLIST }),
      { contextId: 'self-review' },
    ),
    false,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: CI_FIX_CHECKLIST }),
      {
        contextId: 'ci-fix',
      },
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      makeRun({ taskFile: TASK_PROGRESS_MARKDOWN, activeTaskFile: TASK_PROGRESS_MARKDOWN }),
      {
        contextId: 'worker',
      },
    ),
    true,
  );
});

test('interactive dev model exposes active state and stable action ordering', () => {
  assert.equal(
    isActiveInteractiveDevRun(
      makeRun({ flowType: 'dev', mode: 'interactive', status: 'monitoring' }),
    ),
    true,
  );
  assert.equal(
    isActiveInteractiveDevRun(makeRun({ flowType: 'dev', mode: 'interactive', status: 'done' })),
    false,
  );
  assert.deepEqual(
    INTERACTIVE_DEV_ACTIONS.map((entry) => entry.action),
    [
      'done-no-pr',
      'detect-pr-and-ci-watch',
      'link-pr-and-ci-watch',
      'link-pr-and-pr-complete',
      'run-self-review',
      'blocked',
      'failed',
      'abort',
    ],
  );
});
