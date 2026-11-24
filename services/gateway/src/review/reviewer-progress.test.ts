import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPEN_TOOL_LIMIT_FACTOR, ReviewerProgressClock } from './reviewer-progress.js';

const at = (ms: number) => new Date(ms).toISOString();

test("a new command does not inherit the previous command's open tool call", () => {
  const limit = 600_000;
  const clock = new ReviewerProgressClock(1_000, limit);
  clock.observe({ type: 'tool.started', at: at(2_000), nativeId: 'toolu_previous' });
  assert.equal(clock.limitMs, limit * OPEN_TOOL_LIMIT_FACTOR);
  // A completion re-ask is a new command; its predecessor's tool never reports its end.
  clock.restart(3_000);
  assert.equal(clock.toolOpen, false);
  assert.equal(clock.expired(3_000 + limit), true);
});
