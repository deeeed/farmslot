import assert from 'node:assert/strict';
import test from 'node:test';

import { type ArtifactManifestEntry, deriveBaselineVisualArtifactPairs } from './artifact-url';
import {
  artifactWorkspaceFilterPresentation,
  artifactWorkspaceGroup,
  artifactWorkspaceHeaderPresentation,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
  isArtifactWorkspaceFilter,
} from './artifact-workspace';

const artifacts: ArtifactManifestEntry[] = [
  { path: 'screens/before-login.png', purpose: 'screenshot', type: 'image' },
  { path: 'screens/after-login.png', purpose: 'screenshot', type: 'image' },
  { path: 'reports/review.md', purpose: 'review-report', type: 'report' },
  { path: 'patch.diff', purpose: 'diff', type: 'diff' },
  { path: 'recipe/output.json', purpose: 'recipe-output', type: 'json', recipeRunId: 'run-1' },
  { path: 'artifacts/screenshots-captions.json', purpose: 'screenshot' },
  { path: 'logs/worker.txt', purpose: 'log', type: 'log' },
];

test('artifactWorkspaceGroup mirrors command-center before→after/review/support grouping', () => {
  assert.equal(artifactWorkspaceGroup(artifacts[0]), 'before');
  assert.equal(artifactWorkspaceGroup(artifacts[1]), 'after');
  assert.equal(artifactWorkspaceGroup(artifacts[2]), 'review');
  assert.equal(artifactWorkspaceGroup(artifacts[3]), 'review');
  assert.equal(artifactWorkspaceGroup(artifacts[6]), 'supporting');
});

test('buildArtifactWorkspaceCounts produces group and type counts for mobile filter chips', () => {
  assert.deepEqual(buildArtifactWorkspaceCounts(artifacts), {
    all: 7,
    before: 1,
    after: 1,
    review: 2,
    supporting: 3,
    visual: 2,
    docs: 5,
    diffs: 1,
    reports: 1,
    recipes: 1,
  });
});

test('filterArtifactWorkspace applies group/type filters plus path and source search', () => {
  assert.deepEqual(
    filterArtifactWorkspace(artifacts, 'review', '').map((artifact) => artifact.path),
    ['reports/review.md', 'patch.diff'],
  );
  assert.deepEqual(
    filterArtifactWorkspace(
      [
        ...artifacts,
        { path: 'other/result.json', purpose: 'artifact', sourceLabel: 'Qwen recipe' },
      ],
      'all',
      'qwen',
    ).map((artifact) => artifact.path),
    ['other/result.json'],
  );
  assert.deepEqual(
    filterArtifactWorkspace(artifacts, 'visual', '').map((artifact) => artifact.path),
    ['screens/before-login.png', 'screens/after-login.png'],
  );
});

test('isArtifactWorkspaceFilter accepts route-safe filters only', () => {
  assert.equal(isArtifactWorkspaceFilter('review'), true);
  assert.equal(isArtifactWorkspaceFilter('diffs'), true);
  assert.equal(isArtifactWorkspaceFilter('recipes'), true);
  assert.equal(isArtifactWorkspaceFilter('terminal'), false);
  assert.equal(isArtifactWorkspaceFilter(''), false);
});

test('artifact workspace presentation promotes before-after pairs over generic visuals', () => {
  const counts = buildArtifactWorkspaceCounts(artifacts);
  assert.deepEqual(
    artifactWorkspaceFilterPresentation({
      filter: 'visual',
      fallbackLabel: 'Visual files',
      counts,
      visualPairCount: 2,
    }),
    { label: 'Before→After', count: 2 },
  );
  assert.deepEqual(
    artifactWorkspaceHeaderPresentation({
      activeFilter: 'visual',
      visible: 0,
      total: counts.all,
      visualPairCount: 2,
    }),
    { title: 'Before-after differences', countLabel: '2 pairs' },
  );
  assert.deepEqual(
    artifactWorkspaceHeaderPresentation({
      activeFilter: 'review',
      visible: 2,
      total: counts.all,
      visualPairCount: 2,
    }),
    { title: 'Review evidence', countLabel: '2/7' },
  );
  assert.deepEqual(
    artifactWorkspaceHeaderPresentation({
      activeFilter: 'diffs',
      visible: 1,
      total: counts.all,
    }),
    { title: 'Diff files', countLabel: '1/7' },
  );
  assert.deepEqual(
    artifactWorkspaceHeaderPresentation({
      activeFilter: 'recipes',
      visible: 1,
      total: counts.all,
    }),
    { title: 'Recipe artifacts', countLabel: '1/7' },
  );
});

test('deriveBaselineVisualArtifactPairs matches ready-gate one-baseline evidence shape', () => {
  const readyGateEvidence: ArtifactManifestEntry[] = [
    {
      path: 'artifacts/after-ac1-volume-label-on-hover.png',
      purpose: 'screenshot',
      sizeBytes: 42766,
    },
    {
      path: 'artifacts/after-ac3-label-reverted.png',
      purpose: 'screenshot',
      sizeBytes: 38215,
    },
    { path: 'artifacts/after.mp4', purpose: 'video-after', sizeBytes: 328179 },
    {
      path: 'artifacts/before-baseline-chart.png',
      purpose: 'screenshot',
      sizeBytes: 34704,
    },
  ];

  assert.deepEqual(
    deriveBaselineVisualArtifactPairs(readyGateEvidence, (artifact) => artifact.path).map(
      (pair) => ({
        stem: pair.stem,
        before: pair.before.path,
        after: pair.after.path,
      }),
    ),
    [
      {
        stem: 'ac1',
        before: 'artifacts/before-baseline-chart.png',
        after: 'artifacts/after-ac1-volume-label-on-hover.png',
      },
      {
        stem: 'ac3',
        before: 'artifacts/before-baseline-chart.png',
        after: 'artifacts/after-ac3-label-reverted.png',
      },
      {
        stem: 'before-baseline-chart.png → after.mp4',
        before: 'artifacts/before-baseline-chart.png',
        after: 'artifacts/after.mp4',
      },
    ],
  );
});

test('debug screenshots use filename before-after markers from recipe packages', () => {
  const recipePackageScreenshots: ArtifactManifestEntry[] = [
    {
      path: 'artifacts/screenshots/after-ac1-perps-tab-hover.png',
      purpose: 'debug-screenshot',
      sizeBytes: 86510,
    },
    {
      path: 'artifacts/screenshots/after-ac2-market-detail-hover.png',
      purpose: 'debug-screenshot',
      sizeBytes: 67293,
    },
    {
      path: 'artifacts/screenshots/before-ac2-market-detail-hover.png',
      purpose: 'debug-screenshot',
      sizeBytes: 68704,
    },
  ];

  assert.deepEqual(buildArtifactWorkspaceCounts(recipePackageScreenshots), {
    all: 3,
    before: 1,
    after: 2,
    review: 0,
    supporting: 0,
    visual: 3,
    docs: 0,
    diffs: 0,
    reports: 0,
    recipes: 0,
  });
});
