import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_STICKY_NAV_FALLBACK_THRESHOLD,
  workspaceStickyNavThreshold,
} from './workspace-sticky-nav';

test('workspace sticky nav threshold starts when the inline nav reaches the top edge', () => {
  assert.equal(workspaceStickyNavThreshold({ y: 128, height: 52 }), 128);
});

// Keep the slot/run/family workspace rail pinned without a transient empty band while the
// inline rail is scrolling under the route header.
test('workspace sticky nav threshold does not add inline nav height', () => {
  assert.equal(workspaceStickyNavThreshold({ y: 128, height: 72 }), 128);
});

test('workspace sticky nav threshold ignores invalid layout and uses a safe fallback', () => {
  assert.equal(workspaceStickyNavThreshold(null), WORKSPACE_STICKY_NAV_FALLBACK_THRESHOLD);
  assert.equal(workspaceStickyNavThreshold({ y: Number.NaN, height: 52 }, 240), 240);
  assert.equal(workspaceStickyNavThreshold({ y: 128, height: Number.NaN }, 240), 240);
});
