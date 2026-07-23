import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecipeActionRequestParams,
  canShowRecipeExecutionControls,
  computeRecipeEvidenceArtifacts,
  deriveEvidenceArtifactCandidates,
  deriveEvidenceNodeCandidates,
  effectiveRecipeJsonForSelection,
  isVisualRecipeArtifact,
  normalizeRecipeEvidenceArtifacts,
  parseEvidenceManifestEntries,
  parseEvidenceManifestEntriesWithDiagnostics,
  recipeNodeExists,
  selectedRecipeRunRequestId,
} from './slot-view-recipe-helpers.js';

const recipeJson = JSON.stringify({
  workflow: {
    entry: 'start',
    nodes: {
      start: { filename: 'start-shot', next: 'finish' },
      finish: { filename: 'finish-shot' },
    },
  },
});

test('deriveEvidenceArtifactCandidates only returns filenames for the selected node', () => {
  assert.deepEqual(deriveEvidenceArtifactCandidates(recipeJson, 'start'), ['start-shot']);
});

test('deriveEvidenceArtifactCandidates falls forward to nearest downstream screenshot node for action steps', () => {
  const recipe = JSON.stringify({
    workflow: {
      entry: 'ac1-nav-back',
      nodes: {
        'ac1-nav-back': { action: 'press', next: 'ac1-wait-home' },
        'ac1-wait-home': { action: 'wait_for', next: 'ac1-screenshot-after-return' },
        'ac1-screenshot-after-return': {
          action: 'screenshot',
          filename: 'draft-ac1-after-return.png',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });

  assert.deepEqual(deriveEvidenceArtifactCandidates(recipe, 'ac1-nav-back'), [
    'draft-ac1-after-return.png',
  ]);
  assert.deepEqual(deriveEvidenceNodeCandidates(recipe, 'ac1-nav-back'), [
    'ac1-nav-back',
    'ac1-screenshot-after-return',
  ]);
});

test('recipeNodeExists reports whether the selected node is present', () => {
  assert.equal(recipeNodeExists(recipeJson, 'finish'), true);
  assert.equal(recipeNodeExists(recipeJson, 'missing'), false);
});

test('computeRecipeEvidenceArtifacts preserves the full evidence set in all mode', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/unrelated.png', purpose: 'screenshot' },
      { path: 'artifacts/start-shot.png', purpose: 'screenshot' },
    ],
    recipeJson,
    selectedNodeId: 'start',
    evidenceManifest: [],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/start-shot.png', 'artifacts/unrelated.png'],
  );
  assert.equal(result.usedCuratedManifest, false);
});

test('computeRecipeEvidenceArtifacts prefers curated evidence-manifest entries in all mode', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/after-ac1.png', purpose: 'screenshot' },
      { path: 'artifacts/after.mp4', purpose: 'video-after' },
      { path: 'artifacts/review-loop-1/review.diff', purpose: 'other' },
      { path: 'artifacts/console-errors.json', purpose: 'other' },
      { path: 'artifacts/screenshots/after-ac1-123.png', purpose: 'debug-screenshot' },
    ],
    recipeJson,
    selectedNodeId: '',
    evidenceManifest: [
      { label: 'AC1 proof', file: 'after-ac1.png' },
      { label: 'After recording', file: 'after.mp4' },
    ],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/after-ac1.png', 'artifacts/after.mp4'],
  );
  assert.equal(result.usedCuratedManifest, true);
  assert.equal(result.hiddenDiagnosticCount, 2);
});

test('isVisualRecipeArtifact recognizes typed extensionless screenshots', () => {
  assert.equal(
    isVisualRecipeArtifact({
      path: 'artifacts/screenshots/live-proof',
      purpose: 'screenshot',
      type: 'screenshot',
      mimeType: 'image/png',
    }),
    true,
  );
});

test('computeRecipeEvidenceArtifacts prefers typed artifact manifest metadata over curated legacy evidence in all mode', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      {
        path: 'artifacts/custom-proof.png',
        purpose: 'screenshot',
        type: 'screenshot',
        label: 'Typed proof',
        nodeId: 'start',
      },
      { path: 'artifacts/summary.json', purpose: 'summary', type: 'summary' },
      { path: 'artifacts/console-errors.json', purpose: 'other' },
    ],
    recipeJson,
    selectedNodeId: '',
    evidenceManifest: [{ label: 'Legacy curated proof', file: 'custom-proof.png' }],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/custom-proof.png', 'artifacts/summary.json', 'artifacts/console-errors.json'],
  );
  assert.equal(result.usedTypedManifest, true);
  assert.equal(result.usedCuratedManifest, false);
  assert.equal(result.hiddenDiagnosticCount, 0);
});

test('computeRecipeEvidenceArtifacts matches namespaced runtime evidence for a selected dependency', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      {
        path: 'artifacts/child-proof.png',
        purpose: 'screenshot',
        type: 'screenshot',
        nodeId: 'call-child/capture',
      },
      {
        path: 'artifacts/root-proof.png',
        purpose: 'screenshot',
        type: 'screenshot',
        nodeId: 'capture',
      },
    ],
    recipeJson: JSON.stringify({
      workflow: {
        entry: 'capture',
        nodes: { capture: { action: 'ui.screenshot', filename: 'child-proof.png' } },
      },
    }),
    selectedNodeId: 'capture',
    evidenceManifest: [],
    mode: 'node',
    allowNamespacedNodeIds: true,
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/child-proof.png'],
  );
});

test('computeRecipeEvidenceArtifacts keeps generated runner screenshots visible', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/evidence/baseline.png', purpose: 'screenshot' },
      { path: 'artifacts/screenshots/start-1777432413815.png', purpose: 'debug-screenshot' },
      { path: 'artifacts/screenshots/start-1777389667610.png', purpose: 'debug-screenshot' },
    ],
    recipeJson,
    selectedNodeId: '',
    evidenceManifest: [],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    [
      'artifacts/evidence/baseline.png',
      'artifacts/screenshots/start-1777389667610.png',
      'artifacts/screenshots/start-1777432413815.png',
    ],
  );
});

test('parseEvidenceManifestEntries includes before/after pairs, standalone screenshots, and videos', () => {
  const entries = parseEvidenceManifestEntries({
    before_after_pairs: [
      {
        label: 'AC2 visual delta',
        before: 'screenshots/before-ac2.png',
        after: 'screenshots/after-ac2.png',
        note: 'Edge-to-edge hover background',
      },
    ],
    standalone: [{ label: 'AC1', file: 'after-ac1.png' }],
    videos: {
      after: 'after.mp4',
      note: 'End-to-end replay',
      preferred: false,
    },
  });

  assert.deepEqual(entries, [
    {
      label: 'AC2 visual delta — before',
      file: 'screenshots/before-ac2.png',
      note: 'Edge-to-edge hover background',
    },
    {
      label: 'AC2 visual delta — after',
      file: 'screenshots/after-ac2.png',
      note: 'Edge-to-edge hover background',
    },
    { label: 'AC1', file: 'after-ac1.png' },
    { label: 'After recording', file: 'after.mp4', note: 'End-to-end replay' },
  ]);
});

test('parseEvidenceManifestEntries dedupes repeated video files', () => {
  const entries = parseEvidenceManifestEntries({
    videos: {
      before: 'replay.mp4',
      video: 'replay.mp4',
    },
  });

  assert.deepEqual(entries, [{ label: 'Before recording', file: 'replay.mp4' }]);
});

test('parseEvidenceManifestEntries applies group video note to every video entry', () => {
  const entries = parseEvidenceManifestEntries({
    videos: {
      before: 'before.mp4',
      after: 'after.mp4',
      note: 'Shared replay note',
    },
  });

  assert.deepEqual(entries, [
    { label: 'Before recording', file: 'before.mp4', note: 'Shared replay note' },
    { label: 'After recording', file: 'after.mp4', note: 'Shared replay note' },
  ]);
});

test('parseEvidenceManifestEntries includes future video manifest keys', () => {
  const entries = parseEvidenceManifestEntries({
    videos: {
      before: 'before.mp4',
      during: 'during.webm',
      regression: 'regression.mov',
      caption: 'not a media file',
      note: 'Expanded replay set',
    },
  });

  assert.deepEqual(entries, [
    { label: 'Before recording', file: 'before.mp4', note: 'Expanded replay set' },
    { label: 'During recording', file: 'during.webm', note: 'Expanded replay set' },
    { label: 'Regression recording', file: 'regression.mov', note: 'Expanded replay set' },
  ]);
});

test('parseEvidenceManifestEntriesWithDiagnostics counts ignored video manifest entries', () => {
  const result = parseEvidenceManifestEntriesWithDiagnostics({
    videos: {
      before: 'before.mp4',
      caption: 'not a media file',
      missing: '',
      note: 'Replay note',
    },
  });

  assert.deepEqual(result.entries, [
    { label: 'Before recording', file: 'before.mp4', note: 'Replay note' },
  ]);
  assert.equal(result.droppedVideoEntryCount, 2);
});

test('parseEvidenceManifestEntriesWithDiagnostics ignores video metadata keys', () => {
  const result = parseEvidenceManifestEntriesWithDiagnostics({
    videos: {
      preferred: false,
      note: 'Static screenshots are sufficient.',
    },
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.droppedVideoEntryCount, 0);
});

test('normalizeRecipeEvidenceArtifacts hides duplicate publication markdown when package preview exists', () => {
  const result = normalizeRecipeEvidenceArtifacts([
    { path: 'artifacts/pr-description.md', purpose: 'pr-description' },
    { path: 'artifacts/pr-package.md', purpose: 'pr-package-md' },
    { path: 'artifacts/pr-package.json', purpose: 'pr-package-json' },
    { path: 'artifacts/after.png', purpose: 'screenshot' },
  ]);

  assert.deepEqual(
    result.map((artifact) => artifact.path),
    ['artifacts/after.png'],
  );
});

test('computeRecipeEvidenceArtifacts omits package markdown because ready workspace owns PR preview', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/after.png', purpose: 'screenshot' },
      { path: 'artifacts/pr-description.md', purpose: 'pr-description' },
      { path: 'artifacts/pr-package.json', purpose: 'pr-package-json' },
      { path: 'artifacts/pr-package.md', purpose: 'pr-package-md' },
    ],
    recipeJson,
    selectedNodeId: '',
    evidenceManifest: [],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/after.png'],
  );
});

test('computeRecipeEvidenceArtifacts keeps selected-run evidence separate from recipe source and PR feedback', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/recipe.json', purpose: 'recipe' },
      { path: 'artifacts/recipe-resolution.json', purpose: 'other' },
      { path: 'artifacts/resolved-recipes/abc.recipe.json', purpose: 'other' },
      { path: 'artifacts/recipe-library/recipes/demo/ac1.recipe.json', purpose: 'recipe-library' },
      { path: 'artifacts/recipe-quality.json', purpose: 'recipe-quality' },
      { path: 'artifacts/recipe-issues-review.md', purpose: 'other' },
      { path: 'artifacts/artifact-manifest.json', purpose: 'artifact-manifest' },
      { path: 'artifacts/evidence-manifest.json', purpose: 'evidence-manifest' },
      { path: 'artifacts/pr-description.md', purpose: 'pr-description' },
      { path: 'artifacts/pr-package.md', purpose: 'pr-package-md' },
      { path: 'artifacts/review-loop-1/review.md', purpose: 'review' },
      { path: 'artifacts/review-loop-1/line-comments.json', purpose: 'line-comments' },
      { path: 'artifacts/after.png', purpose: 'screenshot' },
      { path: 'artifacts/replay.webm', purpose: 'video-after' },
      { path: 'artifacts/summary.json', purpose: 'other' },
      { path: 'artifacts/trace.json', purpose: 'other' },
      { path: 'artifacts/logs/runner.jsonl', purpose: 'log' },
    ],
    recipeJson,
    selectedNodeId: '',
    evidenceManifest: [],
    mode: 'all',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    [
      'artifacts/after.png',
      'artifacts/replay.webm',
      'artifacts/logs/runner.jsonl',
      'artifacts/summary.json',
      'artifacts/trace.json',
    ],
  );
});

test('normalizeRecipeEvidenceArtifacts keeps pr-description without package preview', () => {
  const result = normalizeRecipeEvidenceArtifacts([
    { path: 'artifacts/pr-description.md', purpose: 'pr-description' },
    { path: 'artifacts/after.png', purpose: 'screenshot' },
  ]);

  assert.deepEqual(
    result.map((artifact) => artifact.path),
    ['artifacts/pr-description.md', 'artifacts/after.png'],
  );
});

test('computeRecipeEvidenceArtifacts keeps node mode empty when no direct evidence matches', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [{ path: 'artifacts/unrelated.png', purpose: 'screenshot' }],
    recipeJson,
    selectedNodeId: 'start',
    evidenceManifest: [],
    mode: 'node',
  });

  assert.equal(result.allArtifacts.length, 1);
  assert.equal(result.effectiveArtifacts.length, 0);
  assert.equal(result.hiddenDiagnosticCount, 0);
  assert.equal(result.usedCuratedManifest, false);
});

test('computeRecipeEvidenceArtifacts maps action nodes to trace-backed downstream screenshots', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      {
        path: 'artifacts/evidence/evidence-ac1-15m-after-navigate-back.png',
        purpose: 'screenshot',
      },
      { path: 'artifacts/evidence/evidence-ac2-eth-still-15m.png', purpose: 'screenshot' },
    ],
    recipeJson: JSON.stringify({
      workflow: {
        entry: 'ac1-nav-back',
        nodes: {
          'ac1-nav-back': { action: 'press', next: 'ac1-wait-home' },
          'ac1-wait-home': { action: 'wait_for', next: 'ac1-screenshot-after-return' },
          'ac1-screenshot-after-return': {
            action: 'screenshot',
            filename: 'draft-ac1-after-return.png',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
    selectedNodeId: 'ac1-nav-back',
    evidenceManifest: [
      { label: 'ac1-screenshot-after-return', file: 'evidence-ac1-15m-after-navigate-back.png' },
    ],
    mode: 'node',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/evidence/evidence-ac1-15m-after-navigate-back.png'],
  );
});

test('computeRecipeEvidenceArtifacts maps node mode by typed artifact nodeId before filename fallback', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      {
        path: 'artifacts/custom/typed-proof.png',
        purpose: 'screenshot',
        type: 'screenshot',
        nodeId: 'ac1-screenshot-after-return',
      },
      { path: 'artifacts/legacy-proof.png', purpose: 'screenshot' },
    ],
    recipeJson: JSON.stringify({
      workflow: {
        entry: 'ac1-nav-back',
        nodes: {
          'ac1-nav-back': { action: 'press', next: 'ac1-wait-home' },
          'ac1-wait-home': { action: 'wait_for', next: 'ac1-screenshot-after-return' },
          'ac1-screenshot-after-return': {
            action: 'screenshot',
            filename: 'legacy-proof.png',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
    selectedNodeId: 'ac1-nav-back',
    evidenceManifest: [],
    mode: 'node',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/custom/typed-proof.png'],
  );
  assert.equal(result.usedTypedManifest, true);
});

test('computeRecipeEvidenceArtifacts does not match suffix-only filenames from unrelated artifacts', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [{ path: 'artifacts/reports/before-summary.png', purpose: 'screenshot' }],
    recipeJson: JSON.stringify({
      entry: 'start',
      nodes: { start: { filename: 'before', next: null } },
    }),
    selectedNodeId: 'start',
    evidenceManifest: [],
    mode: 'node',
  });

  assert.equal(result.effectiveArtifacts.length, 0);
});

test('computeRecipeEvidenceArtifacts keeps gif/webm node evidence visible', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/start-shot.gif', purpose: 'screenshot' },
      { path: 'artifacts/finish-shot.webm', purpose: 'video-after' },
    ],
    recipeJson,
    selectedNodeId: 'start',
    evidenceManifest: [],
    mode: 'node',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/start-shot.gif'],
  );
});

test('computeRecipeEvidenceArtifacts does not pull ac10/ac11 manifest entries into ac1 node mode', () => {
  const result = computeRecipeEvidenceArtifacts({
    artifactManifest: [
      { path: 'artifacts/ac1-proof.png', purpose: 'screenshot' },
      { path: 'artifacts/ac10-proof.png', purpose: 'screenshot' },
      { path: 'artifacts/ac11-proof.webm', purpose: 'video-after' },
    ],
    recipeJson: JSON.stringify({
      entry: 'ac1',
      nodes: { ac1: { filename: 'ac1-proof', next: null } },
    }),
    selectedNodeId: 'ac1',
    evidenceManifest: [
      { label: 'ac10 proof', file: 'ac10-proof.png' },
      { label: 'ac11 proof', file: 'ac11-proof.webm' },
      { label: 'ac1 proof', file: 'ac1-proof.png' },
    ],
    mode: 'node',
  });

  assert.deepEqual(
    result.effectiveArtifacts.map((artifact) => artifact.path),
    ['artifacts/ac1-proof.png'],
  );
});

test('effectiveRecipeJsonForSelection falls back to the package recipe when promoted evidence lacks its own recipe', () => {
  const result = effectiveRecipeJsonForSelection({
    selectedRecipeDependencyJson: '',
    recipeHostRecipeJson: null,
    packageRunRecipeJson: '{"entry":"bundle"}',
  });

  assert.equal(result, '{"entry":"bundle"}');
});

test('buildRecipeActionRequestParams includes recipeRunId for promoted/live selections only', () => {
  assert.deepEqual(
    buildRecipeActionRequestParams({
      runId: 'run-1',
      slotId: 'slot-1',
      recipeArtifactPath: 'artifacts/recipe-library/recipes/demo/child.recipe.json',
      selectedRun: { id: 'promoted-run', groupKind: 'latest-valid' },
    }),
    {
      runId: 'run-1',
      slotId: 'slot-1',
      recipeArtifactPath: 'artifacts/recipe-library/recipes/demo/child.recipe.json',
      recipeRunId: 'promoted-run',
    },
  );
  assert.deepEqual(
    buildRecipeActionRequestParams({
      runId: 'run-1',
      slotId: 'slot-1',
      selectedRun: { id: 'current-artifacts', groupKind: 'current-artifacts' },
    }),
    {
      runId: 'run-1',
      slotId: 'slot-1',
    },
  );
});

test('selectedRecipeRunRequestId omits current-artifacts and preserves inspectable runs', () => {
  assert.equal(
    selectedRecipeRunRequestId({ id: 'current-artifacts', groupKind: 'current-artifacts' }),
    undefined,
  );
  assert.equal(
    selectedRecipeRunRequestId({ id: 'live-run:abc', groupKind: 'live-run' }),
    'live-run:abc',
  );
});

test('canShowRecipeExecutionControls follows the host rerun capability', () => {
  assert.equal(canShowRecipeExecutionControls(true), true);
  assert.equal(canShowRecipeExecutionControls(false), false);
});
