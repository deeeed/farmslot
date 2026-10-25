import assert from 'node:assert/strict';

/** A later read must not hide a rewind by waiting for playback to catch up. */
export function assertPlaybackContinuity(before, after) {
  assert([before.seconds, before.at, after.seconds, after.at].every(Number.isFinite));
  const elapsedSeconds = (after.at - before.at) / 1000;
  assert(elapsedSeconds >= 0 && elapsedSeconds <= 12, 'The viewport observation must be bounded');
  assert(
    after.seconds >= before.seconds - 1,
    'The selected recording rewound after its parent rerendered',
  );
  assert(
    after.seconds - before.seconds >= elapsedSeconds - 3,
    'A reset cannot pass by catching up during the observation',
  );
}
