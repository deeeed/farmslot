import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import { reviewEvidenceArtifacts } from './review-evidence.js';

test('review evidence includes generated screenshots even when inferred as debug screenshots', () => {
  const artifacts: ArtifactRef[] = [
    { path: 'artifacts/review.md', purpose: 'review' },
    { path: 'artifacts/line-comments.json', purpose: 'line-comments' },
    {
      path: 'artifacts/screenshots/evidence-ac2-confirmation-modal-1779956050740.png',
      purpose: 'debug-screenshot',
    },
    { path: 'artifacts/trace.json', purpose: 'other' },
  ];

  assert.deepEqual(
    reviewEvidenceArtifacts(artifacts).map((artifact) => artifact.path),
    ['artifacts/screenshots/evidence-ac2-confirmation-modal-1779956050740.png'],
  );
});
