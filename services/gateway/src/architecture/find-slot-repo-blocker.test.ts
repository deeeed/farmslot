import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Structural ratchet: a Fresh dispatch onto a busy slot kills its worker
// (prepareSlotForFreshReuse) and then prepares the repo. A slot repo that
// cannot check out the default branch must be refused BEFORE that teardown,
// or the operator loses a live worker to a prepare that is known to fail.
// The active-worker branch is gated by nudge eligibility, which never
// prepares, so it must check slotRepoBlocker itself.

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../run-engine/find-slot-step.ts'),
  'utf-8',
);

test('every Fresh teardown in FIND_SLOT refuses a blocked slot repo first', () => {
  const teardown = 'await prepareSlotForFreshReuse(';
  const teardowns: number[] = [];
  for (let at = SOURCE.indexOf(teardown); at >= 0; at = SOURCE.indexOf(teardown, at + 1)) {
    teardowns.push(at);
  }
  assert.equal(teardowns.length, 2, 'wizard fresh-reuse and decision-card fresh teardowns');
  let previous = 0;
  for (const at of teardowns) {
    const check = SOURCE.lastIndexOf('slotRepoBlocker(', at);
    assert.ok(check > previous, `teardown at offset ${at} has no slotRepoBlocker check before it`);
    const between = SOURCE.slice(check, at);
    const refusal = between.indexOf('throw new Error(');
    const fence = between.indexOf('claimSelectedSlot(');
    assert.ok(
      refusal > 0 && fence > refusal,
      'the repo check must refuse before the slot is fenced and its worker killed',
    );
    previous = at;
  }
});
