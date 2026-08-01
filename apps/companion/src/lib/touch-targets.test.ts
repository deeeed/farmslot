import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { touchTargets } from './touch-targets';

describe('touchTargets', () => {
  it('keeps primary touch targets at least 44pt', () => {
    assert.ok(touchTargets.primaryMin >= 44);
    assert.ok(touchTargets.primaryMinHeight >= 44);
    assert.ok(touchTargets.primaryMinWidth >= 44);
    assert.equal(touchTargets.primaryMin, touchTargets.primaryMinHeight);
  });
});
