import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import { dedupeWorkspaceEvidenceArtifacts } from './workspace-evidence-preview.js';

function artifact(path: string, overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return { path, purpose: 'screenshot', ...overrides };
}

test('dedupeWorkspaceEvidenceArtifacts collapses mirrored media by content hash', () => {
  const out = dedupeWorkspaceEvidenceArtifacts([
    artifact('artifacts/recipe-run/evidence-ac1.png', { sha256: 'same', sizeBytes: 10 }),
    artifact('artifacts/after-ac1.png', { sha256: 'same', sizeBytes: 10 }),
    artifact('artifacts/after.mp4', { sha256: 'video', purpose: 'video-after', sizeBytes: 20 }),
  ]);

  assert.deepEqual(
    out.map((entry) => entry.path),
    ['artifacts/recipe-run/evidence-ac1.png', 'artifacts/after.mp4'],
  );
});

test('dedupeWorkspaceEvidenceArtifacts keeps distinct same-name media without hashes', () => {
  const out = dedupeWorkspaceEvidenceArtifacts([
    artifact('artifacts/a/after.png', { sizeBytes: 10 }),
    artifact('artifacts/b/after.png', { sizeBytes: 10 }),
  ]);

  assert.deepEqual(
    out.map((entry) => entry.path),
    ['artifacts/a/after.png', 'artifacts/b/after.png'],
  );
});
