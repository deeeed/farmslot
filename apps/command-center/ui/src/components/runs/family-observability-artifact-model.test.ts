import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyArtifactBucketSummary,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
} from '@farmslot/protocol';

import {
  familyArtifactCaption,
  familyArtifactFetchUrl,
  familyArtifactKey,
  familyArtifactKind,
  familyArtifactProvenance,
  familyArtifactUrl,
  familyBucketSummary,
  familyLightboxItem,
} from './family-observability-artifact-model.js';

function artifact(
  overrides: Partial<FamilyObservabilityArtifact> = {},
): FamilyObservabilityArtifact {
  return {
    runId: 'run-1234567890',
    path: 'artifacts/after.png',
    purpose: 'after',
    source: 'task-artifact',
    sizeBytes: 2048,
    ...overrides,
  } as FamilyObservabilityArtifact;
}

test('family artifact URL helpers preserve run artifact paths', () => {
  const item = artifact({ path: 'artifacts/screenshots/after.png' });

  assert.equal(familyArtifactKey(item), 'run-1234567890:artifacts/screenshots/after.png');
  assert.match(familyArtifactUrl(item), /run-1234567890/);
  assert.match(familyArtifactUrl(item), /artifacts%2Fscreenshots%2Fafter\.png/);
  assert.match(familyArtifactFetchUrl(item), /run-1234567890/);
  assert.match(familyArtifactFetchUrl(item), /artifacts%2Fscreenshots%2Fafter\.png/);
});

test('family artifact captions and bucket summaries match existing display format', () => {
  assert.equal(familyArtifactCaption(artifact()), 'Run run-1234 · task artifact · 2.0 KB');
  assert.equal(
    familyBucketSummary([
      { key: 'screenshot', count: 2, bytes: 3072 },
      { key: 'video', count: 1, bytes: 1024 },
      { key: 'json', count: 3, bytes: 512 },
      { key: 'ignored', count: 9, bytes: 9 },
    ] as FamilyArtifactBucketSummary[]),
    'screenshot 2/3.0 KB · video 1/1.0 KB · json 3/512 B',
  );
  assert.equal(familyBucketSummary([]), 'none');
});

test('family artifact kind and provenance match lightbox semantics', () => {
  assert.equal(familyArtifactKind(artifact({ path: 'before.png', purpose: 'before' })), 'before');
  assert.equal(familyArtifactKind(artifact({ path: 'setup.png', purpose: 'setup' })), 'setup');
  assert.equal(
    familyArtifactProvenance(artifact({ path: 'before.png', purpose: 'before' }), {
      branch: 'fix/demo',
    }),
    'baseline @ main',
  );
  assert.equal(
    familyArtifactProvenance(artifact({ purpose: 'after' }), { branch: 'fix/demo' }),
    'fix @ fix/demo',
  );
  assert.equal(familyArtifactProvenance(artifact({ purpose: 'after' }), null), 'fix');
  assert.equal(
    familyArtifactProvenance(artifact({ path: 'setup.png', purpose: 'debug-screenshot' }), null),
    undefined,
  );
});

test('familyLightboxItem derives URL, caption, and provenance together', () => {
  const item = familyLightboxItem(artifact(), {
    branch: 'fix/demo',
  } as Pick<FamilyObservabilityRunSummary, 'branch'>);

  assert.equal(item.path, 'artifacts/after.png');
  assert.equal(item.caption, 'Run run-1234 · task artifact · 2.0 KB');
  assert.equal(item.provenance, 'fix @ fix/demo');
  assert.match(item.url, /run-1234567890/);
});
