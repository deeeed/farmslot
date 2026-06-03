import assert from 'node:assert/strict';
import test from 'node:test';

import type { RecipeRunArtifactGroup, Run } from '@farmslot/protocol';

import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from './artifact-url';
import {
  describeSlotWorkspaceRunFocus,
  hasRunWorkspaceDiff,
  isActionableWorkspaceDiffValue,
  orderSlotWorkspaceGatesForFocus,
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  selectSlotGatePreviewArtifacts,
  selectSlotRecipePreviewArtifacts,
  selectSlotRunEvidencePreviewArtifacts,
  selectSlotWorkspaceRunId,
  slotHistoryCompareWorkspaceParams,
  slotHistoryRecipeWorkspaceParams,
  summarizeSlotRecipeEvidence,
  summarizeSlotWorkspaceGate,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
  workspaceGateDiffMetricValue,
} from './slot-workspace';

function baseRun(overrides: Partial<Run>): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    ticketOrPr: 'PR #1',
    project: 'farm',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'monitoring',
    branch: 'feature/x',
    slotId: 'runner-mobile-1',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    steps: [],
    decisions: [],
    metrics: {},
    ...overrides,
  } as Run;
}

test('slot workspace summarizes ready gate with manifest evidence and diff', () => {
  const run = baseRun({
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready for review',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 1, additions: 2, deletions: 1 },
          workerReport: 'Worker report',
          branch: 'feature/x',
          artifactManifest: [{ path: 'after.png', purpose: 'screenshot' }],
          publicationStatus: 'published_draft',
        },
      },
    ],
  });

  const summary = summarizeSlotWorkspaceGate(run);
  assert.equal(summary?.label, 'Ready workspace');
  assert.deepEqual(
    summary?.metrics.map((item) => item.value),
    ['+2 -1', '1', 'published draft'],
  );
  assert.deepEqual(summary?.artifactPaths, ['after.png']);
  assert.equal(summary?.primaryArtifactPath, 'after.png');
});

test('slot workspace ready evidence includes run step artifacts', () => {
  const run = baseRun({
    steps: [
      {
        name: 'complete',
        status: 'done',
        startedAt: '2026-05-21T00:00:00.000Z',
        completedAt: '2026-05-21T00:01:00.000Z',
        outputs: {
          artifacts: ['artifacts/worker-report.md', { path: 'artifacts/after.png' }],
        },
      },
    ],
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready for review',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: 'Worker report',
          branch: 'feature/x',
          artifactManifest: [{ path: 'artifacts/ready.json', purpose: 'summary' }],
          publicationStatus: 'published_draft',
        },
      },
    ],
  });

  const summary = summarizeSlotWorkspaceGate(run);
  assert.equal(
    summary?.metrics.find((item) => item.label === 'Evidence')?.value,
    '3',
    'ready workspace should count decision and step-output evidence',
  );
  assert.deepEqual(
    summary?.artifactPaths,
    ['artifacts/ready.json', 'artifacts/worker-report.md', 'artifacts/after.png'],
    'ready workspace should expose the same run evidence it counts',
  );
});

test('slot workspace gate metrics call out before after evidence when present', () => {
  const run = baseRun({
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready for review',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 1, additions: 2, deletions: 1 },
          workerReport: 'Worker report',
          branch: 'feature/x',
          artifactManifest: [
            { path: 'artifacts/before-login.png', purpose: 'screenshot' },
            { path: 'artifacts/after-login.png', purpose: 'screenshot' },
          ],
          publicationStatus: 'published_draft',
        },
      },
    ],
  });

  const summary = summarizeSlotWorkspaceGate(run);
  assert.deepEqual(
    summary?.metrics.find((item) => item.label === 'Before→After'),
    { label: 'Before→After', value: '1 pair' },
    'slot gates should expose visual difference counts as first-class workspace context',
  );
});

test('slot workspace diff value uses ready gate diff and falls back to run step diff', () => {
  const readyRun = baseRun({
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready for review',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 2, additions: 10, deletions: 3 },
          workerReport: 'Worker report',
          branch: 'feature/x',
          artifactManifest: [],
          publicationStatus: 'published_draft',
        },
      },
    ],
  });
  assert.equal(runWorkspaceDiffValue(readyRun), '+10 -3');
  assert.equal(hasRunWorkspaceDiff(readyRun), true);

  const stepDiffRun = baseRun({
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: { diffStat: { files: 1, additions: 2, deletions: 0 } },
      },
    ],
  });
  assert.equal(runWorkspaceDiffValue(stepDiffRun), '+2 -0');
  assert.equal(hasRunWorkspaceDiff(stepDiffRun), true);

  assert.equal(runWorkspaceDiffValue(baseRun({})), '-');
  assert.equal(hasRunWorkspaceDiff(baseRun({})), false);
});

test('slot workspace diff metric helpers distinguish actionable diff values', () => {
  const gate = {
    metrics: [
      { label: 'Evidence', value: '2' },
      { label: 'Diff', value: '+3 -1' },
    ],
  };

  assert.equal(workspaceGateDiffMetricValue(gate), '+3 -1');
  assert.equal(isActionableWorkspaceDiffValue('+3 -1'), true);
  assert.equal(isActionableWorkspaceDiffValue('none'), false);
  assert.equal(isActionableWorkspaceDiffValue('-'), false);
  assert.equal(isActionableWorkspaceDiffValue(null), false);
});

test('slot workspace prioritizes review gate after ready gate and counts review inputs', () => {
  const run = baseRun({
    decisions: [
      {
        id: 'decision-review',
        type: 'review_posting',
        title: 'Needs review',
        description: 'Review code',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'review',
          prNumber: 1,
          repo: 'owner/repo',
          recommendation: 'REQUEST_CHANGES',
          reviewMd: 'Review body',
          lineComments: [{ path: 'a.ts', line: 3, body: 'fix', severity: 'major' }],
          artifactManifest: [{ path: 'review.md', purpose: 'review' }],
          reviewInputArtifactPaths: ['diff.txt'],
        },
      },
    ],
  });

  const summary = summarizeSlotWorkspaceGate(run);
  assert.equal(summary?.label, 'Review workspace');
  assert.deepEqual(
    summary?.metrics.map((item) => item.value),
    ['REQUEST CHANGES', '1', '2'],
  );
  assert.deepEqual(summary?.artifactPaths, ['review.md', 'diff.txt']);
  assert.equal(summary?.primaryArtifactPath, 'review.md');
});

test('slot workspace exposes ready and review gates together with pending first', () => {
  const run = baseRun({
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready gate',
        description: 'Ready package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        resolvedAt: '2026-05-21T00:02:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 2, additions: 5, deletions: 1 },
          workerReport: 'Ready body',
          branch: 'feature/x',
          artifactManifest: [{ path: 'ready.png', purpose: 'screenshot' }],
          publicationStatus: 'published_draft',
        },
      },
      {
        id: 'decision-review',
        type: 'review_posting',
        title: 'Review gate',
        description: 'Review package',
        actions: [],
        createdAt: '2026-05-21T00:03:00.000Z',
        payload: {
          kind: 'review',
          prNumber: 1,
          repo: 'owner/repo',
          recommendation: 'APPROVE',
          reviewMd: 'Review body',
          lineComments: [],
          artifactManifest: [{ path: 'review.md', purpose: 'review' }],
          reviewInputArtifactPaths: ['ready.png'],
        },
      },
    ],
  });

  const summaries = summarizeSlotWorkspaceGates(run);
  assert.deepEqual(
    summaries.map((summary) => ({
      id: summary.decision.id,
      label: summary.label,
      resolved: summary.resolved,
    })),
    [
      { id: 'decision-review', label: 'Review workspace', resolved: false },
      { id: 'decision-ready', label: 'Ready workspace', resolved: true },
    ],
  );
});

test('slot workspace gate ordering honors requested ready or review focus', () => {
  const run = baseRun({
    decisions: [
      {
        id: 'decision-ready',
        type: 'monitor_ready_gate',
        title: 'Ready gate',
        description: 'Ready package',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        resolvedAt: '2026-05-21T00:02:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'owner/repo',
          diffStat: { files: 1, additions: 3, deletions: 1 },
          workerReport: 'Ready body',
          branch: 'feature/x',
          artifactManifest: [],
          publicationStatus: 'published_draft',
        },
      },
      {
        id: 'decision-review',
        type: 'review_posting',
        title: 'Review gate',
        description: 'Review package',
        actions: [],
        createdAt: '2026-05-21T00:03:00.000Z',
        payload: {
          kind: 'review',
          prNumber: 1,
          repo: 'owner/repo',
          recommendation: 'APPROVE',
          reviewMd: 'Review body',
          lineComments: [],
          artifactManifest: [],
          reviewInputArtifactPaths: [],
        },
      },
    ],
  });
  const summaries = summarizeSlotWorkspaceGates(run);

  assert.deepEqual(
    orderSlotWorkspaceGatesForFocus(summaries, 'ready').map((summary) => summary.decision.id),
    ['decision-ready', 'decision-review'],
  );
  assert.deepEqual(
    orderSlotWorkspaceGatesForFocus(summaries, 'review').map((summary) => summary.decision.id),
    ['decision-review', 'decision-ready'],
  );
});

test('slot workspace retro summary exposes latest pending retrospective with metrics', () => {
  const run = baseRun({
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: {
          artifacts: [
            'artifacts/retro.md',
            'artifacts/workspace-before.png',
            'artifacts/workspace-after.png',
          ],
        },
      },
    ],
    decisions: [
      {
        id: 'retro-recorded',
        type: 'retrospective',
        title: 'Recorded retro',
        description: 'Old retro',
        actions: [],
        createdAt: '2026-05-21T00:10:00.000Z',
        resolvedAt: '2026-05-21T00:11:00.000Z',
        payload: {
          kind: 'retrospective',
          outcome: 'success',
          whatThisIs: 'retro',
          selfReviewSummary: 'Recorded summary',
          actionEffects: [],
        },
      },
      {
        id: 'retro-pending',
        type: 'retrospective',
        title: 'Pending retro',
        description: 'Needs review',
        actions: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        payload: {
          kind: 'retrospective',
          outcome: 'partial',
          whatThisIs: 'retro',
          deltaLearnings: 'Use a stronger ready workspace.',
          commentsTriageSummary: {
            total: 4,
            real: 3,
            fixed: 2,
            falsePositive: 1,
            outOfScope: 0,
          },
          ciWatch: { result: 'green', total: 12, passed: 12, failed: 0 },
          actionEffects: [],
        },
      },
    ],
  });

  const summary = summarizeSlotWorkspaceRetro(run);
  assert.equal(summary?.decision.id, 'retro-pending');
  assert.equal(summary?.statusLabel, 'pending');
  assert.equal(summary?.summary, 'Use a stronger ready workspace.');
  assert.deepEqual(summary?.artifactPaths, [
    'artifacts/retro.md',
    'artifacts/workspace-before.png',
    'artifacts/workspace-after.png',
  ]);
  assert.deepEqual(summary?.primaryVisualPair, {
    beforePath: 'artifacts/workspace-before.png',
    afterPath: 'artifacts/workspace-after.png',
    stem: 'workspace',
  });
  assert.equal(summary?.visualPairCount, 1);
  assert.deepEqual(
    summary?.metrics.map((item) => item.value),
    ['partial', '2/3 fixed', 'green'],
  );
});

function recipeGroup(overrides: Partial<RecipeRunArtifactGroup>): RecipeRunArtifactGroup {
  return {
    id: 'current-artifacts',
    label: 'Recipe package',
    groupKind: 'current-artifacts',
    promoted: false,
    status: 'unknown',
    source: 'recipe-run-artifacts',
    selectionReason: 'latest-run',
    recipeRunId: null,
    artifactRoot: '/tmp/task/artifacts',
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    artifactManifest: [],
    ...overrides,
  };
}

test('slot recipe evidence summary counts runs artifacts and status flags', () => {
  const summary = summarizeSlotRecipeEvidence([
    recipeGroup({
      id: 'current-artifacts',
      label: 'Current package',
      status: 'unknown',
      artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
    }),
    recipeGroup({
      id: 'live-run:abc',
      label: 'Passing rerun',
      groupKind: 'live-run',
      status: 'pass',
      isStale: true,
      artifactManifest: [
        { path: 'artifacts/before.png', purpose: 'screenshot' },
        { path: 'artifacts/after.png', purpose: 'screenshot' },
      ],
    }),
    recipeGroup({
      id: 'live-run:def',
      label: 'Failing rerun',
      groupKind: 'live-run',
      status: 'fail',
      artifactManifest: [{ path: 'artifacts/report.md', purpose: 'report' }],
    }),
  ]);

  assert.deepEqual(summary, {
    totalRuns: 3,
    totalArtifacts: 4,
    passingRuns: 1,
    failingRuns: 1,
    staleRuns: 1,
    groups: [
      {
        id: 'current-artifacts',
        label: 'Current package',
        status: 'unknown',
        artifactCount: 1,
        promoted: false,
        isStale: false,
      },
      {
        id: 'live-run:abc',
        label: 'Passing rerun',
        status: 'pass',
        artifactCount: 2,
        promoted: false,
        isStale: true,
      },
      {
        id: 'live-run:def',
        label: 'Failing rerun',
        status: 'fail',
        artifactCount: 1,
        promoted: false,
        isStale: false,
      },
    ],
  });
});

test('slot workspace run selection prefers explicit and active runs before history fallback', () => {
  assert.equal(
    selectSlotWorkspaceRunId({
      requestedRunId: ' route-run ',
      currentRunId: 'current-run',
      history: [{ runId: 'history-run' }],
    }),
    'route-run',
  );
  assert.equal(
    selectSlotWorkspaceRunId({
      requestedRunId: '',
      currentRunId: ' current-run ',
      history: [{ runId: 'history-run' }],
    }),
    'current-run',
  );
  assert.equal(
    selectSlotWorkspaceRunId({
      requestedRunId: null,
      currentRunId: null,
      history: [{ runId: ' history-run ' }],
    }),
    'history-run',
  );
  assert.equal(
    selectSlotWorkspaceRunId({
      requestedRunId: ' ',
      currentRunId: '',
      history: [],
    }),
    null,
  );
});

test('slot workspace run focus distinguishes current and historical contexts', () => {
  assert.deepEqual(
    describeSlotWorkspaceRunFocus({ runId: 'current-run', currentRunId: ' current-run ' }),
    { label: 'Current slot run', isHistorical: false },
  );
  assert.deepEqual(
    describeSlotWorkspaceRunFocus({ runId: 'history-run', currentRunId: 'current-run' }),
    { label: 'Selected run', isHistorical: true },
  );
  assert.deepEqual(describeSlotWorkspaceRunFocus({ runId: 'history-run', currentRunId: null }), {
    label: 'Historical run',
    isHistorical: true,
  });
});

test('slot recipe previews prefer selected visual artifacts then promoted fallback', () => {
  const current = recipeGroup({
    id: 'current-artifacts',
    label: 'Current package',
    groupKind: 'current-artifacts',
    artifactManifest: [
      { path: 'artifacts/report.md', purpose: 'report' },
      { path: 'artifacts/current.png', purpose: 'screenshot' },
    ],
  });
  const promoted = recipeGroup({
    id: 'live-run:promoted',
    label: 'Promoted run',
    groupKind: 'live-run',
    promoted: true,
    artifactManifest: [{ path: 'artifacts/promoted.png', purpose: 'screenshot' }],
  });
  const other = recipeGroup({
    id: 'live-run:other',
    label: 'Other run',
    groupKind: 'live-run',
    artifactManifest: [{ path: 'artifacts/other.png', purpose: 'screenshot' }],
  });

  assert.deepEqual(
    selectSlotRecipePreviewArtifacts([current, promoted, other], 'current-artifacts').map(
      (artifact) => artifact.path,
    ),
    [
      'artifacts/current.png',
      'artifacts/promoted.png',
      'artifacts/other.png',
      'artifacts/report.md',
    ],
  );
  assert.deepEqual(
    selectSlotRecipePreviewArtifacts([current, promoted, other], null, 2).map((artifact) => ({
      path: artifact.path,
      recipeRunId: artifact.recipeRunId,
    })),
    [
      { path: 'artifacts/promoted.png', recipeRunId: 'live-run:promoted' },
      { path: 'artifacts/current.png', recipeRunId: undefined },
    ],
  );
});

test('slot recipe previews fall back to document artifacts when no visuals exist', () => {
  assert.deepEqual(
    selectSlotRecipePreviewArtifacts(
      [
        recipeGroup({
          id: 'current-artifacts',
          label: 'Current package',
          groupKind: 'current-artifacts',
          artifactManifest: [
            { path: 'artifacts/recipe.json', purpose: 'recipe' },
            { path: 'artifacts/report.md', purpose: 'report' },
          ],
        }),
      ],
      null,
    ).map((artifact) => artifact.path),
    ['artifacts/recipe.json', 'artifacts/report.md'],
  );
});

test('slot compare target prefers selected recipe pairs over run evidence pairs', () => {
  const selectedRecipe = recipeGroup({
    id: 'live-run:selected',
    groupKind: 'live-run',
    artifactManifest: [
      { path: 'recipe/before-login.png', purpose: 'screenshot' },
      { path: 'recipe/after-login.png', purpose: 'screenshot' },
    ],
  });

  assert.deepEqual(
    selectSlotCompareTarget({
      runArtifacts: [
        { path: 'run/before-home.png', purpose: 'screenshot' },
        { path: 'run/after-home.png', purpose: 'screenshot' },
      ],
      recipeRuns: [selectedRecipe],
      selectedRecipeRunId: 'live-run:selected',
    }),
    {
      artifactPath: 'recipe/after-login.png',
      recipeRunId: 'live-run:selected',
      pairCount: 1,
      source: 'selected-recipe',
    },
  );
});

test('slot compare target uses run evidence before unselected recipe fallback', () => {
  assert.deepEqual(
    selectSlotCompareTarget({
      runArtifacts: [
        { path: 'run/before-home.png', purpose: 'screenshot' },
        { path: 'run/after-home.png', purpose: 'screenshot' },
      ],
      recipeRuns: [
        recipeGroup({
          id: 'live-run:promoted',
          groupKind: 'live-run',
          promoted: true,
          artifactManifest: [
            { path: 'recipe/before-login.png', purpose: 'screenshot' },
            { path: 'recipe/after-login.png', purpose: 'screenshot' },
          ],
        }),
      ],
      selectedRecipeRunId: null,
    }),
    {
      artifactPath: 'run/after-home.png',
      recipeRunId: null,
      pairCount: 1,
      source: 'run',
    },
  );
});

test('slot compare target falls back to recipe pairs when run evidence has no pair', () => {
  assert.deepEqual(
    selectSlotCompareTarget({
      runArtifacts: [{ path: 'run/report.md', purpose: 'report' }],
      recipeRuns: [
        recipeGroup({
          id: 'current-artifacts',
          groupKind: 'current-artifacts',
          artifactManifest: [
            { path: 'recipe/before-login.png', purpose: 'screenshot' },
            { path: 'recipe/after-login.png', purpose: 'screenshot' },
          ],
        }),
      ],
      selectedRecipeRunId: null,
    }),
    {
      artifactPath: 'recipe/after-login.png',
      recipeRunId: 'current-artifacts',
      pairCount: 1,
      source: 'recipe-fallback',
    },
  );
});

test('slot run evidence previews prefer visual artifacts but keep document fallback', () => {
  assert.deepEqual(
    selectSlotRunEvidencePreviewArtifacts([
      { path: 'artifacts/report.md', purpose: 'report' },
      { path: 'artifacts/after.png', purpose: 'screenshot' },
      { path: 'artifacts/diff.patch', purpose: 'diff' },
      { path: 'artifacts/screen-recording.mp4', purpose: 'video' },
      { path: 'artifacts/log.txt', purpose: 'log' },
    ]).map((artifact) => artifact.path),
    [
      'artifacts/after.png',
      'artifacts/screen-recording.mp4',
      'artifacts/report.md',
      'artifacts/diff.patch',
    ],
  );
});

test('slot gate previews preserve gate artifact focus and backfill missing manifest metadata', () => {
  assert.deepEqual(
    selectSlotGatePreviewArtifacts(
      {
        artifactPaths: [
          'artifacts/after.png',
          'artifacts/report.md',
          'artifacts/missing-review.md',
        ],
      },
      [
        { path: 'artifacts/report.md', purpose: 'report' },
        { path: 'artifacts/after.png', purpose: 'screenshot' },
      ],
    ),
    [
      { path: 'artifacts/after.png', purpose: 'screenshot' },
      { path: 'artifacts/report.md', purpose: 'report' },
      { path: 'artifacts/missing-review.md', purpose: 'review' },
    ],
  );
});

test('slot gate fallback metadata preserves filename before after pairing', () => {
  const artifacts = selectSlotGatePreviewArtifacts(
    {
      artifactPaths: ['artifacts/before-login.png', 'artifacts/after-login.png'],
    },
    [],
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.purpose),
    ['image', 'image'],
    'missing gate manifest metadata should stay neutral enough for before→after filename detection',
  );
  assert.equal(
    groupVisualArtifactPairs(artifacts, (artifact) => artifact.path).pairs.length,
    1,
    'slot gate fallback artifacts should still form a before→after pair',
  );
});

test('slot history recipe workspace params preserve concrete recipe evidence targets', () => {
  assert.deepEqual(
    slotHistoryRecipeWorkspaceParams({
      recipeRunId: 'live-run:recipe-1',
      artifactPath: 'recipe/after-login.png',
    }),
    { recipeRun: 'live-run:recipe-1', artifact: 'recipe/after-login.png' },
  );

  assert.deepEqual(slotHistoryRecipeWorkspaceParams({ recipeRunId: null, artifactPath: ' ' }), {
    recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  });
});

test('slot history compare workspace params prefer run evidence before recipe fallback', () => {
  assert.deepEqual(
    slotHistoryCompareWorkspaceParams({
      runPairCount: 2,
      runArtifactPath: 'artifacts/after-login.png',
      recipePairCount: 1,
      recipeRunId: 'live-run:recipe-1',
      recipeArtifactPath: 'recipe/after-login.png',
    }),
    {
      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      artifact: 'artifacts/after-login.png',
    },
  );

  assert.deepEqual(
    slotHistoryCompareWorkspaceParams({
      runPairCount: 0,
      recipePairCount: 1,
      recipeRunId: 'live-run:recipe-1',
      recipeArtifactPath: 'recipe/after-login.png',
    }),
    {
      recipeRun: 'live-run:recipe-1',
      artifact: 'recipe/after-login.png',
    },
  );

  assert.equal(slotHistoryCompareWorkspaceParams({ runPairCount: 0, recipePairCount: 0 }), null);
});
