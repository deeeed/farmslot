import assert from 'node:assert/strict';
import test from 'node:test';

import { GATEWAY_TOKEN_STORAGE_KEY } from '../../gateway-url.js';
import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';

import {
  isDebugScreenshotArtifact,
  isWorkspaceDiffArtifact,
  isWorkspaceEvidenceArtifact,
  recipeRunArtifactUrl,
  runArtifactApiPath,
  runArtifactFetchUrl,
  runArtifactUrl,
  workspaceArtifactBasename,
  workspaceArtifactGroup,
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
    runArtifactUrl('run:1', artifact),
    'http://localhost:7777/api/run-artifact?runId=run%3A1&path=artifacts%2Freview%20notes%2Fdiff.txt',
  );
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'dev-token');
    const fetchUrl = runArtifactFetchUrl('run:1', artifact);
    const parsed = new URL(fetchUrl, 'http://localhost:7777');
    assert.equal(parsed.searchParams.get('runId'), 'run:1');
    assert.equal(parsed.searchParams.get('path'), 'artifacts/review notes/diff.txt');
    assert.equal(parsed.searchParams.get('token'), 'dev-token');
  });
});

function withMockLocalStorage(fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  });
  try {
    fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
}

test('recipeRunArtifactUrl preserves recipe-run scope and cache busting hints', () => {
  const url = recipeRunArtifactUrl(
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
    'run-1',
    { id: 'live-run:abc', groupKind: 'live-run' },
    { ...base, sha256: '1111111111117890' },
  );
  const second = recipeRunArtifactUrl(
    'run-1',
    { id: 'live-run:abc', groupKind: 'live-run' },
    { ...base, sha256: '2222222222227890' },
  );
  assert.notEqual(first, second);
});

test('recipeRunArtifactUrl uses size cache busting for current artifacts without recipe scope', () => {
  const url = recipeRunArtifactUrl(
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

test('unbound legacy names and purposes never supply an AC role or comparison pair', () => {
  const artifacts = [
    { path: 'shots/before-home.png', purpose: 'Screenshot' },
    { path: 'shots/after-home.png', purpose: 'Screenshot' },
    { path: 'artifacts/before-ac1-proof.png', purpose: 'screenshot-before' },
    { path: 'artifacts/after-ac1-other-proof.png', purpose: 'screenshot' },
    { path: 'artifacts/before-shared-baseline.png', purpose: 'screenshot' },
  ];
  assert.deepEqual(
    artifacts.map((artifact) => workspaceArtifactGroup(artifact)),
    artifacts.map(() => 'other'),
  );
  assert.deepEqual(buildBeforeAfterPairs(artifacts), []);
  assert.equal(
    workspaceArtifactGroup({ path: 'reviews/notes.md', purpose: 'Review output' }),
    'review',
  );
  assert.equal(workspaceArtifactGroup({ path: 'logs/run.txt', purpose: 'Log' }), 'other');
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
