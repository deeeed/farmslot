import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPlaybackContinuity } from './view-sharing-playback-evidence.mjs';

test('measured playback advances through a parent viewport change', () => {
  assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 12, at: 12000 });
});
test('a bounded native resize pause does not imply rewind', () => {
  assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 10, at: 12500 });
});
test('returning to the selected clip start is refused', () => {
  assert.throws(
    () => assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 1, at: 12000 }),
    /rewound/,
  );
});
test('waiting for a reset player to catch up cannot manufacture continuity', () => {
  assert.throws(
    () => assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 10, at: 20000 }),
    /catching up/,
  );
});
test('unbounded or backwards observations are refused', () => {
  assert.throws(
    () => assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 24, at: 24000 }),
    /bounded/,
  );
  assert.throws(
    () => assertPlaybackContinuity({ seconds: 10, at: 10000 }, { seconds: 10, at: 9000 }),
    /bounded/,
  );
});
