import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';

import {
  isDebugScreenshotArtifact,
  isWorkspaceDiffArtifact,
  isWorkspaceEvidenceArtifact,
  recipeRunArtifactUrl,
  runArtifactApiPath,
  runArtifactUrl,
  workspaceArtifactBasename,
  workspaceArtifactGroup,
  workspaceArtifactGroupLabel,
  workspaceArtifactType,
  workspaceArtifactTypeBadge,
  workspaceArtifactTypeLabel,
} from './workspace-artifacts.js';

test('run artifact URL helpers preserve shared run artifact encoding', () => {
  const artifact = { path: 'artifacts/review notes/diff.txt' };
  assert.equal(
    runArtifactApiPath('run:1', artifact),
    '/api/run-artifact?runId=run%3A1&path=artifacts%2Freview%20notes%2Fdiff.txt',
  );
  assert.equal(
    runArtifactUrl('http://localhost:7777', 'run:1', artifact),
    'http://localhost:7777/api/run-artifact?runId=run%3A1&path=artifacts%2Freview%20notes%2Fdiff.txt',
  );
});

test('recipeRunArtifactUrl preserves recipe-run scope and cache busting hints', () => {
  const url = recipeRunArtifactUrl(
    'http://localhost:7777',
    'run-1',
    { id: 'live-run:abc', groupKind: 'live-run' },
    {
      path: 'artifacts/screenshots/after.png',
      sha256: 'abcdef1234567890',
      sizeBytes: 321,
    },
  );
  assert.equal(
    url,
    'http://localhost:7777/api/run-artifact?runId=run-1&path=artifacts%2Fscreenshots%2Fafter.png&recipeRunId=live-run%3Aabc&v=abcdef123456&vsize=321',
  );
});

test('recipeRunArtifactUrl changes when content hash changes for the same recipe-run path', () => {
  const base = {
    path: 'artifacts/screenshots/after.png',
    sizeBytes: 321,
  };
  const first = recipeRunArtifactUrl(
    'http://localhost:7777',
    'run-1',
    { id: 'live-run:abc', groupKind: 'live-run' },
    { ...base, sha256: '1111111111117890' },
  );
  const second = recipeRunArtifactUrl(
    'http://localhost:7777',
    'run-1',
    { id: 'live-run:abc', groupKind: 'live-run' },
    { ...base, sha256: '2222222222227890' },
  );
  assert.notEqual(first, second);
});

test('recipeRunArtifactUrl uses size cache busting for current artifacts without recipe scope', () => {
  const url = recipeRunArtifactUrl(
    'http://localhost:7777',
    'run-1',
    { id: 'current-artifacts', groupKind: 'current-artifacts' },
    {
      path: 'artifacts/after-ac1.png',
      sizeBytes: 99,
    },
  );
  assert.equal(
    url,
    'http://localhost:7777/api/run-artifact?runId=run-1&path=artifacts%2Fafter-ac1.png&v=s99&vsize=99',
  );
});

test('workspaceArtifactGroup classifies stage and review artifacts', () => {
  assert.equal(
    workspaceArtifactGroup({ path: 'shots/before-home.png', purpose: 'Screenshot' }),
    'before',
  );
  assert.equal(
    workspaceArtifactGroup({ path: 'shots/after-home.png', purpose: 'Screenshot' }),
    'after',
  );
  assert.equal(
    workspaceArtifactGroup({
      path: 'artifacts/screenshots/live-home-before.png',
      purpose: 'debug-screenshot',
    }),
    'before',
  );
  assert.equal(
    workspaceArtifactGroup({
      path: 'artifacts/screenshots/live-home-after.png',
      purpose: 'debug-screenshot',
    }),
    'after',
  );
  assert.equal(
    workspaceArtifactGroup({ path: 'reviews/notes.md', purpose: 'Review output' }),
    'review',
  );
  assert.equal(workspaceArtifactGroup({ path: 'logs/run.txt', purpose: 'Log' }), 'other');
  assert.equal(workspaceArtifactGroupLabel('review'), 'Review artifacts');
});

test('before/after pairing accepts trailing filename markers', () => {
  assert.deepEqual(
    buildBeforeAfterPairs([
      { path: 'artifacts/screenshots/live-home-before.png', purpose: 'debug-screenshot' },
      { path: 'artifacts/screenshots/live-home-after.png', purpose: 'debug-screenshot' },
    ]).map((pair) => pair.stem),
    ['live-home'],
  );
});

test('before/after pairing falls back to unique acceptance criteria ids', () => {
  assert.deepEqual(
    buildBeforeAfterPairs([
      { path: 'artifacts/before-ac1-market-detail-no-liq-distance.png', purpose: 'screenshot' },
      { path: 'artifacts/after-ac1-market-detail-liq-distance.png', purpose: 'screenshot' },
      { path: 'artifacts/before-ac2-positions-tab-no-liq-distance.png', purpose: 'screenshot' },
      { path: 'artifacts/after-ac2-positions-tab-liq-distance.png', purpose: 'screenshot' },
      { path: 'artifacts/before-ac3-no-position.png', purpose: 'screenshot' },
      { path: 'artifacts/after-ac3-no-position-no-liq-distance.png', purpose: 'screenshot' },
    ]).map((pair) => pair.stem),
    ['ac1', 'ac2', 'ac3'],
  );
});

test('before/after acceptance criteria fallback chooses the most specific duplicate capture', () => {
  const pairs = buildBeforeAfterPairs([
    { path: 'artifacts/before-evidence-ac2-market-list-leverage.png', purpose: 'screenshot' },
    { path: 'artifacts/after-ac2-market-list-origin.png', purpose: 'screenshot' },
    { path: 'artifacts/after-ac2-market-list-leverage.png', purpose: 'screenshot' },
  ]);
  assert.deepEqual(
    pairs.map((pair) => [pair.before.path, pair.after.path]),
    [
      [
        'artifacts/before-evidence-ac2-market-list-leverage.png',
        'artifacts/after-ac2-market-list-leverage.png',
      ],
    ],
  );
});

test('workspaceArtifactType classifies filters and labels', () => {
  assert.equal(workspaceArtifactType({ path: 'shots/home.png', purpose: 'Screenshot' }), 'image');
  assert.equal(workspaceArtifactType({ path: 'video/demo.webm', purpose: 'Recording' }), 'video');
  assert.equal(workspaceArtifactType({ path: 'report.md', purpose: 'Markdown' }), 'markdown');
  assert.equal(workspaceArtifactType({ path: 'data/result.json', purpose: 'Payload' }), 'json');
  assert.equal(workspaceArtifactType({ path: 'patch.diff', purpose: 'Patch' }), 'diff');
  assert.equal(workspaceArtifactType({ path: 'logs/stdout.txt', purpose: 'Output' }), 'other');
  assert.equal(workspaceArtifactTypeLabel('diff'), 'Diffs');
  assert.equal(workspaceArtifactTypeBadge('markdown'), 'MD');
});

test('workspace artifact filename helpers centralize basename and diff checks', () => {
  assert.equal(workspaceArtifactBasename('artifacts/review/patch.diff'), 'patch.diff');
  assert.equal(workspaceArtifactBasename('', 'Diff'), '');
  assert.equal(
    isWorkspaceDiffArtifact({ path: 'artifacts/review/diff.txt', purpose: 'review output' }),
    true,
  );
  assert.equal(
    isWorkspaceDiffArtifact({ path: 'artifacts/review/notes.md', purpose: 'review diff notes' }),
    true,
  );
  assert.equal(
    isWorkspaceDiffArtifact({ path: 'artifacts/review/notes.md', purpose: 'review output' }),
    false,
  );
});

test('workspace evidence helpers exclude raw recipe-runner screenshot spools', () => {
  assert.equal(
    isDebugScreenshotArtifact({
      path: 'artifacts/screenshots/evidence-ac1-1777432413815.png',
      purpose: 'screenshot',
    }),
    true,
  );
  assert.equal(
    isWorkspaceEvidenceArtifact({
      path: 'artifacts/screenshots/evidence-ac1-1777432413815.png',
      purpose: 'screenshot',
    }),
    false,
  );
  assert.equal(
    isWorkspaceEvidenceArtifact({
      path: 'artifacts/recipe-runs/run-1/screenshots/evidence-ac1-1777432413815.png',
      purpose: 'screenshot',
    }),
    false,
  );
  assert.equal(
    isWorkspaceEvidenceArtifact({
      path: 'artifacts/after-ac1.png',
      purpose: 'screenshot',
    }),
    true,
  );
  assert.equal(
    isWorkspaceEvidenceArtifact({
      path: 'artifacts/after.mp4',
      purpose: 'video-after',
    }),
    true,
  );
});
