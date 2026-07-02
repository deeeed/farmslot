import assert from 'node:assert/strict';
import test from 'node:test';

import type { RecipeRunArtifactGroup } from '@farmslot/protocol';

import { gatewayResourceUrl } from '../../utils/gateway-origin.js';

import {
  selectedSlotViewRecipeArtifact,
  selectedSlotViewRecipeArtifactLabel,
  selectedSlotViewRecipeFlowArtifact,
  selectedSlotViewRecipeFlowLabel,
  slotViewDesiredRecipeRunId,
  slotViewRecipeArtifactUrl,
  slotViewRecipeFlowArtifacts,
  slotViewRecipeJsonFallbackWarning,
  slotViewRecipeNodeEvidenceState,
  slotViewRecipeRunHelpText,
  slotViewRecipeRunIdExists,
  slotViewRecipeRunKindLabel,
  slotViewRecipeRunSourceDetail,
  slotViewRecipeRunStatusLabel,
  slotViewSelectedRecipeArtifactPath,
  slotViewSelectedRecipeFlowPath,
} from './slot-view-recipe-view-model.js';

function recipeRun(
  overrides: Partial<RecipeRunArtifactGroup> & Pick<RecipeRunArtifactGroup, 'id' | 'groupKind'>,
): RecipeRunArtifactGroup {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    groupKind: overrides.groupKind,
    promoted: overrides.promoted ?? false,
    status: overrides.status ?? 'unknown',
    source: overrides.source ?? 'decision',
    recipeRunId: overrides.recipeRunId ?? null,
    artifactRoot: overrides.artifactRoot ?? null,
    artifactManifest: overrides.artifactManifest ?? null,
    usedTypedArtifactManifest: overrides.usedTypedArtifactManifest,
    recipeJson: overrides.recipeJson ?? null,
    recipeQualityArtifact: overrides.recipeQualityArtifact ?? null,
    qualityReport: overrides.qualityReport ?? null,
    workerLearnings: overrides.workerLearnings ?? null,
    isStale: overrides.isStale ?? false,
    selectionReason: overrides.selectionReason ?? 'decision-derived',
  };
}

const bundle = recipeRun({
  id: 'bundle',
  label: 'Bundle',
  groupKind: 'current-artifacts',
});
const promoted = recipeRun({
  id: 'valid-1',
  label: 'Latest valid',
  groupKind: 'latest-valid',
  promoted: true,
  status: 'pass',
});
const live = recipeRun({
  id: 'attempt-1',
  label: 'Attempt',
  groupKind: 'live-run',
  status: 'fail',
});

test('slot view recipe view model selects runs and labels status chips', () => {
  assert.equal(slotViewRecipeRunKindLabel(promoted), 'Promoted');
  assert.equal(slotViewRecipeRunKindLabel(live), 'Attempted');
  assert.equal(slotViewRecipeRunStatusLabel(promoted), 'Valid');
  assert.equal(slotViewRecipeRunStatusLabel(live), 'Failed');
  assert.equal(slotViewRecipeRunHelpText(live).startsWith('Attempted run'), true);
});

test('slot view recipe view model resolves recipe run id precedence once', () => {
  const recipeRuns = [bundle, promoted, live];
  assert.equal(slotViewRecipeRunIdExists(recipeRuns, 'valid-1'), true);
  assert.equal(slotViewRecipeRunIdExists(recipeRuns, 'missing'), false);
  assert.equal(
    slotViewDesiredRecipeRunId({
      recipeRuns,
      requestedRecipeRunId: 'valid-1',
      pendingRecipeRunId: 'attempt-1',
      currentRecipeRunId: 'bundle',
      gatewaySelectedRecipeRunId: null,
    }),
    'valid-1',
  );
  assert.equal(
    slotViewDesiredRecipeRunId({
      recipeRuns,
      requestedRecipeRunId: 'missing',
      pendingRecipeRunId: 'attempt-1',
      currentRecipeRunId: 'bundle',
      gatewaySelectedRecipeRunId: 'valid-1',
    }),
    'attempt-1',
  );
  assert.equal(
    slotViewDesiredRecipeRunId({
      recipeRuns: [],
      requestedRecipeRunId: 'missing',
      pendingRecipeRunId: '',
      currentRecipeRunId: '',
      gatewaySelectedRecipeRunId: null,
    }),
    '',
  );
});

test('slot view recipe view model derives flow and artifact selections', () => {
  const host = {
    artifactManifest: [
      { path: 'artifacts/recipe-flows/login.json', purpose: 'recipe-flow' },
      { path: 'artifacts/evidence/after.png', purpose: 'screenshot' },
    ],
  };
  assert.deepEqual(
    slotViewRecipeFlowArtifacts(host).map((artifact) => artifact.path),
    ['artifacts/recipe-flows/login.json'],
  );
  assert.equal(
    selectedSlotViewRecipeFlowArtifact(host, 'artifacts/recipe-flows/login.json')?.path,
    'artifacts/recipe-flows/login.json',
  );
  assert.equal(
    selectedSlotViewRecipeFlowLabel(host, 'artifacts/recipe-flows/login.json'),
    'login.json',
  );
  assert.equal(selectedSlotViewRecipeFlowLabel(host, ''), 'Main recipe');
  assert.equal(
    selectedSlotViewRecipeArtifactLabel('artifacts/evidence/after.png'),
    'evidence/after.png',
  );
  assert.equal(
    selectedSlotViewRecipeArtifact(
      [
        { path: 'artifacts/a.png', purpose: 'screenshot' },
        { path: 'artifacts/b.png', purpose: 'screenshot' },
      ],
      'artifacts/b.png',
    )?.path,
    'artifacts/b.png',
  );
  const selectedRun = recipeRun({
    id: 'with-flow',
    groupKind: 'live-run',
    artifactManifest: [{ path: 'artifacts/recipe-flows/login.json', purpose: 'recipe-flow' }],
  });
  assert.equal(
    slotViewSelectedRecipeFlowPath({
      selectedRun,
      requestedFlow: 'artifacts/recipe-flows/login.json',
    }),
    'artifacts/recipe-flows/login.json',
  );
  assert.equal(
    slotViewSelectedRecipeFlowPath({
      selectedRun,
      requestedFlow: 'artifacts/recipe-flows/missing.json',
    }),
    '',
  );
  assert.equal(
    slotViewSelectedRecipeArtifactPath({
      desiredRecipeArtifactPath: 'artifacts/evidence/after.png',
      selectedRun: null,
      recipeHost: host,
    }),
    'artifacts/evidence/after.png',
  );
  assert.equal(
    slotViewSelectedRecipeArtifactPath({
      desiredRecipeArtifactPath: 'artifacts/missing.png',
      selectedRun: null,
      recipeHost: host,
    }),
    null,
  );
});

test('slot view recipe view model distinguishes local and worker bundle roots', () => {
  assert.equal(
    slotViewRecipeRunSourceDetail(
      { ...bundle, artifactRoot: '/repo/task/artifacts' },
      '/repo/task/task.md',
    ),
    'Source: local cache',
  );
  assert.equal(
    slotViewRecipeRunSourceDetail(
      { ...bundle, artifactRoot: '/tmp/farmslot/artifacts' },
      '/repo/task/task.md',
    ),
    'Source: worker bundle',
  );
});

test('slot view recipe view model builds fallback warnings and artifact URLs', () => {
  assert.equal(
    slotViewRecipeJsonFallbackWarning({
      selectedRun: promoted,
      recipeHostRecipeJson: null,
      packageRunRecipeJson: '{}',
    })?.startsWith('Selected recipe run'),
    true,
  );
  assert.equal(
    slotViewRecipeJsonFallbackWarning({
      selectedRun: bundle,
      recipeHostRecipeJson: null,
      packageRunRecipeJson: '{}',
    }),
    null,
  );
  assert.equal(
    slotViewRecipeArtifactUrl({
      origin: 'http://localhost:5176',
      runId: 'run-1',
      artifactPath: 'artifacts/after.png',
      artifactManifest: [
        {
          path: 'artifacts/after.png',
          purpose: 'screenshot',
          sha256: 'abcdef1234567890',
          sizeBytes: 42,
        },
      ],
      selectedRun: promoted,
      artifactMirrorEpoch: 2,
    }),
    gatewayResourceUrl(
      '/api/run-artifact?runId=run-1&path=artifacts%2Fafter.png&recipeRunId=valid-1&v=abcdef123456&vsize=42&m=2',
    ),
  );
});

test('slot view recipe view model derives node evidence state', () => {
  assert.deepEqual(
    slotViewRecipeNodeEvidenceState({
      mode: 'all',
      selectedNodeId: '',
      recipeJson: null,
      evidenceArtifacts: [{ path: 'artifacts/after.png', purpose: 'screenshot' }],
    }),
    { mode: 'all', nodeExists: true, hasEvidence: true },
  );
  assert.deepEqual(
    slotViewRecipeNodeEvidenceState({
      mode: 'node',
      selectedNodeId: 'start',
      recipeJson: JSON.stringify({ entry: 'start', nodes: { start: {} } }),
      evidenceArtifacts: [],
    }),
    { mode: 'node', nodeExists: true, hasEvidence: false },
  );
});
