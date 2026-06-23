import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERNAL_ARTIFACT_COPY_EXCLUDES,
  isGatewayOwnedArtifactMirrorEntry,
  isGatewayOwnedArtifactPath,
  REVIEW_GATE_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_EXCLUDES,
} from '../core/artifact-copy-policy.js';

test('gateway-owned artifact predicates cover package and review artifacts consistently', () => {
  assert.equal(isGatewayOwnedArtifactMirrorEntry('pr-package.json'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('review-loop-1'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('independent-review-2'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('publication-gate-ready.md'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('session-metrics.json'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('worker-report.md'), false);
  assert.equal(isGatewayOwnedArtifactPath('artifacts/pr-package.json'), true);
  assert.equal(isGatewayOwnedArtifactPath('artifacts/session-metrics.json'), true);
  assert.equal(isGatewayOwnedArtifactPath('artifacts/review-loop-1/review.diff'), true);
  assert.equal(
    isGatewayOwnedArtifactPath('artifacts/independent-review-2/review-loop-1/review.diff'),
    true,
  );
  assert.equal(isGatewayOwnedArtifactPath('artifacts/screenshots/after.png'), false);
});
test('review artifact copy keeps generated screenshots while publication copy excludes raw spools', () => {
  assert.equal((WORKER_ARTIFACT_COPY_EXCLUDES as readonly string[]).includes('screenshots'), true);
  assert.equal(
    (REVIEW_GATE_ARTIFACT_COPY_EXCLUDES as readonly string[]).includes('screenshots'),
    false,
  );
});

test('artifact copy policies reject internal runtime directories', () => {
  for (const name of INTERNAL_ARTIFACT_COPY_EXCLUDES) {
    assert.equal((WORKER_ARTIFACT_COPY_EXCLUDES as readonly string[]).includes(name), true);
    assert.equal((REVIEW_GATE_ARTIFACT_COPY_EXCLUDES as readonly string[]).includes(name), true);
  }
});
