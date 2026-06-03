import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactStickyChromeThreshold,
  artifactStickyChromeVisible,
} from './artifact-sticky-chrome';

test('artifact sticky chrome pins when the workspace nav reaches the top edge', () => {
  assert.equal(artifactStickyChromeThreshold({ y: 96, height: 48 }, 180), 96);
  assert.equal(artifactStickyChromeVisible(95, 96), false);
  assert.equal(artifactStickyChromeVisible(97, 96), true);
});

// Regression guard for Android: waiting for the inline chrome to fully scroll away creates
// a visible blank band above the artifact filters while the nav is passing under the header.
test('artifact sticky chrome does not include inline nav height in the pin threshold', () => {
  assert.equal(artifactStickyChromeThreshold({ y: 96, height: 80 }, 180), 96);
});

test('artifact sticky chrome can pin before the inline nav leaves a blank Android band', () => {
  assert.equal(artifactStickyChromeThreshold({ y: 180, height: 64 }, 180, 96), 84);
  assert.equal(artifactStickyChromeVisible(83, 84), false);
  assert.equal(artifactStickyChromeVisible(85, 84), true);
});

test('artifact sticky chrome can cap activation for Android stack-header gaps', () => {
  assert.equal(artifactStickyChromeThreshold({ y: 180, height: 64 }, 180, 96, 32), 32);
  assert.equal(artifactStickyChromeThreshold(null, 180, 96, 32), 32);
  assert.equal(artifactStickyChromeVisible(31, 32), false);
  assert.equal(artifactStickyChromeVisible(33, 32), true);
});

test('artifact sticky chrome falls back safely before layout is measured', () => {
  assert.equal(artifactStickyChromeThreshold(null, 180), 180);
  assert.equal(artifactStickyChromeThreshold(null, 180, 96), 84);
  assert.equal(artifactStickyChromeThreshold({ y: Number.NaN, height: 48 }, 180), 180);
  assert.equal(artifactStickyChromeVisible(Number.NaN, 180), false);
});
