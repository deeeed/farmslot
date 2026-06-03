import assert from 'node:assert/strict';
import test from 'node:test';

import { verticalSplitPercent } from './vertical-split-resizer.js';

test('verticalSplitPercent converts drag distance into bounded split percentage', () => {
  assert.equal(
    verticalSplitPercent({
      startPct: 50,
      startY: 100,
      currentY: 180,
      containerHeight: 400,
    }),
    70,
  );
  assert.equal(
    verticalSplitPercent({
      startPct: 50,
      startY: 100,
      currentY: -1000,
      containerHeight: 400,
    }),
    15,
  );
  assert.equal(
    verticalSplitPercent({
      startPct: 50,
      startY: 100,
      currentY: 1000,
      containerHeight: 400,
    }),
    85,
  );
});

test('verticalSplitPercent preserves the current split when container height is unavailable', () => {
  assert.equal(
    verticalSplitPercent({
      startPct: 42,
      startY: 100,
      currentY: 180,
      containerHeight: 0,
    }),
    42,
  );
});
