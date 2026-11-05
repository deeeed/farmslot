import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxWorkerListResult, TmuxWorkerNodeResult } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { pinnedWorkerReadError, sidebarNavigationHash } from './app-shell-nav-model.js';

test('F414 shell expansion and width survive route navigation without carrying route selections', () => {
  assert.equal(
    sidebarNavigationHash(
      '#terminal?view=new',
      '#runs?run=private-selection&panels=sidebar,monitor-details&sidebarWidth=320',
    ),
    '#terminal?view=new&panels=sidebar&sidebarWidth=320',
  );
  assert.equal(sidebarNavigationHash('#fleet', '#runs'), '#fleet');
  assert.equal(
    sidebarNavigationHash('#runs?panels=monitor-details', '#fleet?panels=sidebar'),
    '#runs?panels=monitor-details%2Csidebar',
  );
  assert.equal(
    sidebarNavigationHash('#runs?panels=!sidebar', '#fleet?panels=sidebar'),
    '#runs?panels=%21sidebar',
  );
});

function state(
  nodes: TmuxWorkerNodeResult[],
  error?: ResourceQueryState<TmuxWorkerListResult>['error'],
): ResourceQueryState<TmuxWorkerListResult> {
  return { status: 'ready', error, data: { observedAt: 1, nodes, workers: [] } };
}

function node(connected: boolean): TmuxWorkerNodeResult {
  return {
    nodeId: 'fixture',
    connected,
    ok: false,
    observedAt: 1,
    workers: [],
    error: 'unavailable',
    summary: { panes: 0, active: 0, waiting: 0, idle: 0, stale: 0, unknown: 0 },
  };
}

test('F414 disconnected worker rows are quiet while genuine connected read failures remain visible', () => {
  assert.equal(pinnedWorkerReadError(state([node(false)])), '');
  assert.equal(pinnedWorkerReadError(state([node(true)])), 'fixture: unavailable');
  assert.equal(
    pinnedWorkerReadError(
      state([], { code: 'RESOURCE_SOURCE_UNAVAILABLE', message: 'Node offline is disconnected' }),
    ),
    '',
  );
  assert.equal(
    pinnedWorkerReadError(state([], { code: 'AUTH_FORBIDDEN', message: 'Denied' })),
    'Denied',
  );
});
