import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision, PRStatus, Run } from '@farmslot/protocol';

import { useDecisionStore } from './decisions';
import { useFilterStore } from './filters';
import { useFleetStore } from './fleet';
import { usePRStore } from './prs';
import { resetFarmState } from './reset-farm-state';
import { useRunFilterStore } from './run-filters';
import { useRunStore } from './runs';

test('account reset erases farm data, errors, history status and derived selections', () => {
  useFleetStore.setState({
    fleet: {
      checkedAt: '2026-09-14T00:00:00Z',
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    },
    loading: true,
  });
  useRunStore.setState({
    runs: [{ id: 'old-admin-run' } as Run],
    activeLoading: true,
    historyLoading: true,
    historyLoaded: true,
  });
  usePRStore.setState({
    prs: [{ title: 'old-admin-pr' } as PRStatus],
    updatedAt: 1,
    loading: true,
    lastError: 'old-admin-error',
  });
  useDecisionStore.setState({ decisions: [{ id: 'old-admin-decision' } as PendingDecision] });
  useFilterStore.setState({
    filters: { projects: ['private-project'], machines: ['private-machine'] },
    availableSources: [{ project: 'private-project' }],
    availableProjects: ['private-project'],
    availableMachines: ['private-machine'],
    initializing: true,
  });
  useRunFilterStore.getState().setSearch('old-admin-search');
  const oldVersion = useFilterStore.getState().mutationVersion;
  resetFarmState();
  assert.equal(useFleetStore.getState().fleet, null);
  assert.deepEqual(useRunStore.getState().runs, []);
  assert.equal(useRunStore.getState().historyLoading, false);
  assert.equal(useRunStore.getState().historyLoaded, false);
  assert.deepEqual(usePRStore.getState().prs, []);
  assert.equal(usePRStore.getState().lastError, null);
  assert.deepEqual(useDecisionStore.getState().decisions, []);
  assert.deepEqual(useFilterStore.getState().filters, { projects: [], machines: [] });
  assert.deepEqual(useFilterStore.getState().availableSources, []);
  assert(useFilterStore.getState().mutationVersion > oldVersion);
  assert.equal(useRunFilterStore.getState().filters.search, '');
});
