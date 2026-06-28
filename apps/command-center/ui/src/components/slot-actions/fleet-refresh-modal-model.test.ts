import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import {
  appendFleetRefreshRowLog,
  buildFleetRefreshReviewRows,
  deselectFleetRefreshDangerousRows,
  findFleetRefreshRowByRequestId,
  fleetRefreshBlockedReason,
  fleetRefreshRunningProgress,
  groupFleetRefreshRows,
  isFleetRefreshDangerousRow,
  selectedFleetRefreshDangerousRowCount,
  selectedFleetRefreshRowCount,
  setFleetRefreshRowsSelected,
  toggleFleetRefreshRowExpanded,
  updateFleetRefreshRowSelection,
} from './fleet-refresh-modal-model.js';

function slot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  const { slot: slotId, ...rest } = overrides;
  return {
    slot: slotId,
    machine: 'runner-a',
    project: 'mobile',
    branch: 'main',
    enabled: true,
    lifecycle: 'ready',
    phase: 'idle',
    currentRunId: '',
    agent: 'idle',
    ...rest,
  } as SlotStatus;
}

const farmslotFarmProject = {
  'farmslot-farm': {
    defaultBranch: 'main',
    slotTrackingBranch: 'wt/{{session}}',
    worktreeBase: '/Users/deeeed/dev/farmslot-wt',
  },
};

test('buildFleetRefreshReviewRows treats configured tracking branches as safe', () => {
  const result = buildFleetRefreshReviewRows(
    [
      slot({
        slot: 'macwork-ff-2',
        branch: 'wt/ff-2',
        project: 'farmslot-farm',
        session: 'ff-2',
        repo: '/Users/deeeed/dev/farmslot-wt/farmslot-2',
      }),
    ],
    { projects: [], machines: [] },
    farmslotFarmProject,
  );

  const row = result.rows.get('macwork-ff-2');
  assert.equal(row?.isStale, false);
  assert.equal(row?.mode, 'safe');
  assert.equal(row?.selected, true);
  assert.deepEqual(result.staleSlotIds, []);
});

test('buildFleetRefreshReviewRows separates safe, stale, and blocked rows', () => {
  const result = buildFleetRefreshReviewRows(
    [
      slot({ slot: 'safe-1', branch: 'main' }),
      slot({ slot: 'stale-1', branch: 'feature/example' }),
      slot({ slot: 'busy-1', lifecycle: 'busy', phase: 'working' }),
    ],
    { projects: [], machines: [] },
  );

  assert.deepEqual(result.hidden, [{ slotId: 'busy-1', reason: 'busy (working)' }]);
  assert.deepEqual(result.staleSlotIds, ['stale-1']);
  assert.equal(result.filteredOutCount, 0);

  const safe = result.rows.get('safe-1');
  assert.equal(safe?.mode, 'safe');
  assert.equal(safe?.selected, true);
  assert.equal(safe?.isStale, false);

  const stale = result.rows.get('stale-1');
  assert.equal(stale?.mode, 'force');
  assert.equal(stale?.selected, false);
  assert.equal(stale?.isStale, true);
});

test('buildFleetRefreshReviewRows applies filters before hidden classification', () => {
  const result = buildFleetRefreshReviewRows(
    [
      slot({ slot: 'visible-disabled', enabled: false, project: 'mobile' }),
      slot({ slot: 'filtered-disabled', enabled: false, project: 'extension' }),
      slot({ slot: 'visible-safe', project: 'mobile' }),
    ],
    { projects: ['mobile'], machines: [] },
  );

  assert.equal(result.filteredOutCount, 1);
  assert.deepEqual(result.hidden, [{ slotId: 'visible-disabled', reason: 'disabled' }]);
  assert.deepEqual([...result.rows.keys()], ['visible-safe']);
});

test('fleetRefreshBlockedReason preserves modal blocking labels', () => {
  assert.equal(fleetRefreshBlockedReason(slot({ slot: 'disabled', enabled: false })), 'disabled');
  assert.equal(
    fleetRefreshBlockedReason(slot({ slot: 'held', lifecycle: 'held', phase: undefined })),
    'held (watch)',
  );
  assert.equal(
    fleetRefreshBlockedReason(slot({ slot: 'run', currentRunId: '1234567890abcdef' })),
    'has active run 12345678',
  );
  assert.equal(
    fleetRefreshBlockedReason(slot({ slot: 'agent', agent: 'working' })),
    'agent working',
  );
});

test('fleet refresh row grouping separates safe force rows from open or unknown PR rows', () => {
  const rows = buildFleetRefreshReviewRows(
    [
      slot({ slot: 'safe-main', branch: 'main' }),
      slot({ slot: 'force-unknown', branch: 'feature/unknown' }),
      slot({ slot: 'force-open', branch: 'feature/open' }),
      slot({ slot: 'force-merged', branch: 'feature/merged' }),
      slot({ slot: 'force-no-pr', branch: 'feature/no-pr' }),
    ],
    { projects: [], machines: [] },
  ).rows;

  rows.set('force-open', {
    ...rows.get('force-open')!,
    prAnnotation: { prNumber: 42, state: 'open', repo: 'org/repo' },
  });
  rows.set('force-merged', {
    ...rows.get('force-merged')!,
    prAnnotation: { prNumber: 43, state: 'merged', repo: 'org/repo' },
  });
  rows.set('force-no-pr', {
    ...rows.get('force-no-pr')!,
    prAnnotation: { prNumber: null, state: null, repo: null },
  });

  const groups = groupFleetRefreshRows(rows.values());
  assert.deepEqual(
    groups.safe.map((row) => row.slotId),
    ['safe-main'],
  );
  assert.deepEqual(
    groups.forceSafe.map((row) => row.slotId),
    ['force-merged', 'force-no-pr'],
  );
  assert.deepEqual(
    groups.forceDanger.map((row) => row.slotId),
    ['force-unknown', 'force-open'],
  );
  assert.equal(isFleetRefreshDangerousRow(rows.get('safe-main')!), false);
  assert.equal(isFleetRefreshDangerousRow(rows.get('force-unknown')!), true);
});

test('fleet refresh selection and progress helpers preserve footer counts', () => {
  const rows = buildFleetRefreshReviewRows(
    [
      slot({ slot: 'safe-main', branch: 'main' }),
      slot({ slot: 'force-open', branch: 'feature/open' }),
      slot({ slot: 'force-closed', branch: 'feature/closed' }),
      slot({ slot: 'force-idle', branch: 'feature/idle' }),
    ],
    { projects: [], machines: [] },
  ).rows;

  rows.set('force-open', {
    ...rows.get('force-open')!,
    selected: true,
    status: 'failed',
    prAnnotation: { prNumber: 42, state: 'open', repo: 'org/repo' },
  });
  rows.set('force-closed', {
    ...rows.get('force-closed')!,
    selected: true,
    status: 'refreshed',
    prAnnotation: { prNumber: 43, state: 'closed', repo: 'org/repo' },
  });
  rows.set('safe-main', { ...rows.get('safe-main')!, status: 'skipped' });
  rows.set('force-idle', { ...rows.get('force-idle')!, selected: false, status: 'idle' });

  assert.equal(selectedFleetRefreshRowCount(rows.values()), 3);
  assert.equal(selectedFleetRefreshRowCount(rows.values(), 'safe'), 1);
  assert.equal(selectedFleetRefreshRowCount(rows.values(), 'force'), 2);
  assert.equal(selectedFleetRefreshDangerousRowCount(rows.values()), 1);
  assert.deepEqual(fleetRefreshRunningProgress(rows.values()), {
    total: 3,
    done: 3,
    failed: 1,
  });
});

test('fleet refresh row selection helpers preserve danger guards', () => {
  const rows = buildFleetRefreshReviewRows(
    [
      slot({ slot: 'safe-main', branch: 'main' }),
      slot({ slot: 'force-open', branch: 'feature/open' }),
      slot({ slot: 'force-closed', branch: 'feature/closed' }),
    ],
    { projects: [], machines: [] },
  ).rows;

  rows.set('force-open', {
    ...rows.get('force-open')!,
    prAnnotation: { prNumber: 42, state: 'open', repo: 'org/repo' },
  });
  rows.set('force-closed', {
    ...rows.get('force-closed')!,
    prAnnotation: { prNumber: 43, state: 'closed', repo: 'org/repo' },
  });

  const blocked = updateFleetRefreshRowSelection(rows, 'force-open', true, false);
  assert.equal(blocked.get('force-open')?.selected, false);
  const allowed = updateFleetRefreshRowSelection(rows, 'force-open', true, true);
  assert.equal(allowed.get('force-open')?.selected, true);

  const forceSelected = setFleetRefreshRowsSelected(rows, true, 'force-safe');
  assert.equal(forceSelected.get('force-open')?.selected, false);
  assert.equal(forceSelected.get('force-closed')?.selected, true);

  const deselectedDanger = deselectFleetRefreshDangerousRows(allowed);
  assert.equal(deselectedDanger.get('force-open')?.selected, false);
});

test('fleet refresh row expansion and log helpers preserve row updates', () => {
  const rows = buildFleetRefreshReviewRows([slot({ slot: 'safe-main', branch: 'main' })], {
    projects: [],
    machines: [],
  }).rows;
  rows.set('safe-main', { ...rows.get('safe-main')!, requestId: 'req-1', log: ['old'] });

  const expanded = toggleFleetRefreshRowExpanded(rows, 'safe-main');
  assert.equal(expanded.get('safe-main')?.expanded, true);
  assert.equal(findFleetRefreshRowByRequestId(expanded.values(), 'req-1')?.slotId, 'safe-main');

  const updated = appendFleetRefreshRowLog(expanded.get('safe-main')!, 'first\nsecond\n', {
    maxLines: 2,
    tailTruncate: 3,
  });
  assert.deepEqual(updated?.log, ['first', 'second']);
  assert.equal(updated?.lastLogLine, 'sec');
  assert.equal(
    appendFleetRefreshRowLog(expanded.get('safe-main')!, '\n', {
      maxLines: 2,
      tailTruncate: 3,
    }),
    null,
  );
});
