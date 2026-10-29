import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catchUpHolds,
  offlineTotalsHold,
  PAGE_BYTES,
  pageReport,
} from './run-list-version-fill-checks.mjs';

const history = { rows: 120, totalCount: 120 };

test('offline totals need no request sent, even one that never got a reply', () => {
  const quiet = { framesSent: 0, frames: [], history };
  assert.equal(offlineTotalsHold(quiet, { expected: 120, minRuns: 81 }), true);
  // A request the stopped gateway never answered leaves no reply frame behind.
  const unanswered = { framesSent: 1, frames: [], history };
  assert.equal(offlineTotalsHold(unanswered, { expected: 120, minRuns: 81 }), false);
  assert.equal(offlineTotalsHold(quiet, { expected: 121, minRuns: 81 }), false);
  assert.equal(
    offlineTotalsHold({ ...quiet, history: { rows: 80, totalCount: 120 } }, { minRuns: 81 }),
    false,
  );
});

test('catch-up pages must cover exactly the changed ids, within bounds, without a full reread', () => {
  const page = (ids, extra = {}) => ({
    kind: 'ids',
    ok: true,
    requestMs: 100,
    responseBytes: 1000,
    rows: ids.length,
    requestedIds: ids,
    ...extra,
  });
  const versions = { kind: 'versions', ok: true, requestMs: 5, responseBytes: 200 };
  const report = pageReport([versions, page(['a', 'b']), page(['c'])]);
  assert.equal(catchUpHolds(report, ['a', 'b', 'c'], 3), true);
  assert.equal(catchUpHolds(report, ['a', 'b'], 2), false, 'an extra id was read');
  assert.equal(catchUpHolds(pageReport([page(['a'])]), ['a'], 1), false, 'no version read');
  const slow = pageReport([versions, page(['a'], { requestMs: 60_000 })]);
  assert.equal(catchUpHolds(slow, ['a'], 1), false);
  const oversized = page(['big'], { responseBytes: PAGE_BYTES * 1.25 });
  assert.equal(pageReport([versions, oversized]).oversizedPage, true, 'one large row alone');
  const crowded = page(['big', 'small'], { responseBytes: PAGE_BYTES * 1.25 });
  assert.equal(pageReport([versions, crowded]).pagesWithinBounds, false);
});
