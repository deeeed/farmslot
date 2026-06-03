import assert from 'node:assert/strict';
import test from 'node:test';

import { familyLearningTimeAgo } from './family-observability-run-detail-renderers.js';

const now = new Date('2026-06-01T12:00:00.000Z').getTime();

test('familyLearningTimeAgo preserves compact age labels', () => {
  assert.equal(familyLearningTimeAgo('2026-06-01T11:59:45.000Z', now), '15s ago');
  assert.equal(familyLearningTimeAgo('2026-06-01T11:45:00.000Z', now), '15m ago');
  assert.equal(familyLearningTimeAgo('2026-06-01T09:00:00.000Z', now), '3h ago');
  assert.equal(familyLearningTimeAgo('2026-05-29T12:00:00.000Z', now), '3d ago');
});

test('familyLearningTimeAgo handles invalid and future timestamps like the component did', () => {
  assert.equal(familyLearningTimeAgo('not-a-date', now), '');
  assert.equal(familyLearningTimeAgo('2026-06-01T12:01:00.000Z', now), '0s ago');
});
