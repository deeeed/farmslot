import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWorkspaceCensusReason,
  processInSlotRepoReason,
  UNREADABLE_CENSUS_REASON,
} from './cleanup-hold.js';

test('only the reasons the workspace census writes are census holds', () => {
  assert.equal(isWorkspaceCensusReason(processInSlotRepoReason('50176')), true);
  assert.equal(isWorkspaceCensusReason(UNREADABLE_CENSUS_REASON), true);
  for (const reason of [
    processInSlotRepoReason('x1'),
    processInSlotRepoReason(''),
    `${processInSlotRepoReason('7')}; Browser session still open`,
    'Another active run child-run uses this slot',
    'Worker ownership in pane %3 is not quiescent; slot teardown was skipped',
    null,
  ])
    assert.equal(isWorkspaceCensusReason(reason), false, String(reason));
});
