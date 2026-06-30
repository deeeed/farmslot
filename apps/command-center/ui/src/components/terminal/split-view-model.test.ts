import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  Run,
  RunStatus,
  SlotStatus,
  TmuxWorkerSummary,
  TmuxWorkerWatchEntry,
} from '@farmslot/protocol';

import {
  filterSlotsByGlobalFilters,
  isActiveRunTerminalSlot,
  isFarmslotWatchEntry,
  isFarmslotWorker,
  isWorkerPaneFilter,
  meaningfulPaneTitle,
  parseWatchItems,
  parseWorkerRefs,
  selectActiveRunSlotIds,
  selectPinnedSlotIds,
  slotHasActiveRunTerminal,
  tmuxRefTitle,
  watchEntryDescription,
  workerDescription,
} from './split-view-model.js';

function makeSlot(slot: string, overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot,
    machine: 'macwork',
    platform: 'ios',
    project: 'metamask-mobile-farm',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'claude',
    model: 'sonnet',
    deviceName: 'mm-1',
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

function makeRun(
  id: string,
  overrides: Partial<Run> & { status?: RunStatus; slotId?: string | null } = {},
): Run {
  return {
    id,
    project: 'metamask-mobile-farm',
    slotId: 'macwork-mm-3',
    status: 'monitoring',
    flowType: 'dev',
    mode: 'dispatch',
    lane: 'primary',
    ticketOrPr: 'TAT-1',
    branch: 'feature/x',
    createdAt: '2026-06-24T12:00:00.000Z',
    updatedAt: '2026-06-24T12:00:00.000Z',
    steps: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'sonnet' },
    ...overrides,
  } as Run;
}

const ref = { nodeId: 'node-a', session: 'work', target: '%3', window: '2', pane: '1' };

test('split view model parses persisted worker refs and watch items defensively', () => {
  assert.deepEqual(parseWorkerRefs(null), []);
  assert.deepEqual(parseWorkerRefs(JSON.stringify([{ ...ref }, { nodeId: 'bad' }])), [ref]);

  const item = { id: 'watch-1', nodeId: 'node-a', target: '%3', ref, title: 'api', cwd: '/repo' };
  assert.deepEqual(parseWatchItems(JSON.stringify([item, { id: 'bad' }])), [item]);
});

test('split view model labels panes without repeating low-signal titles', () => {
  assert.equal(tmuxRefTitle(ref), 'work · 2:1');
  assert.equal(
    meaningfulPaneTitle('repo', { cwd: '/Users/me/repo', nodeId: 'node-a', session: 'work' }),
    null,
  );
  assert.equal(
    meaningfulPaneTitle('API server', { cwd: '/repo', nodeId: 'node-a', session: 'work' }),
    'API server',
  );

  const worker = {
    ref,
    title: 'API server',
    cwd: '/repo',
    branch: 'feature/x',
    command: 'yarn dev',
    status: { label: 'running' },
  } as TmuxWorkerSummary;
  assert.equal(
    workerDescription(worker),
    'API server · running · feature/x · /repo · cmd:yarn dev · node-a %3',
  );
});

test('split view model classifies filters and Farmslot-linked workers', () => {
  assert.equal(isWorkerPaneFilter('adhoc'), true);
  assert.equal(isWorkerPaneFilter('all'), true);
  assert.equal(isWorkerPaneFilter('farmslot'), true);
  assert.equal(isWorkerPaneFilter('other'), false);

  const linked = { ref, linkedSlotId: 'slot-1', status: { label: 'running' } } as TmuxWorkerSummary;
  const adhoc = { ref, status: { label: 'running' } } as TmuxWorkerSummary;
  assert.equal(isFarmslotWorker(linked), true);
  assert.equal(isFarmslotWorker(adhoc), false);

  const entry = {
    id: 'watch-1',
    ref,
    live: false,
    item: {
      id: 'watch-1',
      ref,
      pinnedAt: 1,
      ...ref,
      title: 'api',
      statusLabel: 'stale',
      linkedRunId: 'run-1',
    },
  } as TmuxWorkerWatchEntry;
  assert.equal(isFarmslotWatchEntry(entry), true);
  assert.match(watchEntryDescription(entry), /stale · api/);
});

test('selectActiveRunSlotIds ignores stale manual task files without live workers', () => {
  const slots = [
    makeSlot('macwork-mm-1', {
      lifecycle: 'manual',
      agent: 'idle',
      taskFile: 'feat/tat-3215-0621-203724',
      project: 'metamask-mobile-farm',
    }),
    makeSlot('macwork-core-6', {
      lifecycle: 'manual',
      agent: 'no-tmux',
      taskFile: 'fix/9082-0611-100218',
      project: 'metamask-core-farm',
      platform: 'cli',
    }),
    makeSlot('macwork-mm-3', {
      lifecycle: 'busy',
      phase: 'working',
      agent: 'idle',
      taskFile: 'feat/tat-3393-0624-173830',
      currentRunId: 'run-mm-3',
      deviceName: 'mm-3',
    }),
    makeSlot('macwork-mme-1', {
      project: 'metamask-extension-farm',
      platform: 'chrome-extension',
      lifecycle: 'busy',
      phase: 'working',
      agent: 'idle',
      currentRunId: 'run-mme-1',
      deviceName: 'mme-1',
    }),
    makeSlot('macwork-mme-2', {
      project: 'metamask-extension-farm',
      platform: 'chrome-extension',
      lifecycle: 'busy',
      phase: 'working',
      agent: 'idle',
      currentRunId: 'run-mme-2',
      deviceName: 'mme-2',
    }),
  ];
  const runs = [
    makeRun('run-mm-3', {
      slotId: 'macwork-mm-3',
      status: 'self-reviewing',
      ticketOrPr: 'TAT-3393',
      updatedAt: '2026-06-24T18:00:00.000Z',
    }),
    makeRun('run-mme-1', {
      slotId: 'macwork-mme-1',
      project: 'metamask-extension-farm',
      status: 'self-reviewing',
      ticketOrPr: 'TAT-3394',
      updatedAt: '2026-06-24T17:00:00.000Z',
    }),
    makeRun('run-mme-2', {
      slotId: 'macwork-mme-2',
      project: 'metamask-extension-farm',
      status: 'self-reviewing',
      ticketOrPr: 'TAT-3407',
      updatedAt: '2026-06-24T19:00:00.000Z',
    }),
  ];
  const filters = {
    projects: ['metamask-mobile-farm', 'metamask-extension-farm', 'metamask-core-farm'],
    machines: ['macwork'],
  };

  assert.deepEqual(selectActiveRunSlotIds(slots, runs, filters), [
    'macwork-mme-2',
    'macwork-mm-3',
    'macwork-mme-1',
  ]);
});

test('selectActiveRunSlotIds keeps active manual slots only when the worker is live', () => {
  const manualWorking = makeSlot('macwork-mm-9', {
    lifecycle: 'manual',
    agent: 'working',
    taskFile: 'adhoc/task',
  });
  const manualIdle = makeSlot('macwork-mm-8', {
    lifecycle: 'manual',
    agent: 'idle',
    taskFile: 'adhoc/old',
  });

  assert.equal(isActiveRunTerminalSlot(manualWorking, []), true);
  assert.equal(isActiveRunTerminalSlot(manualIdle, []), false);
});

test('selectActiveRunSlotIds includes monitoring and completing runs and sorts monitoring first', () => {
  const slots = [
    makeSlot('macwork-mm-4', {
      lifecycle: 'busy',
      phase: 'working',
      currentRunId: 'run-mm-4',
    }),
    makeSlot('macwork-mm-5', {
      lifecycle: 'busy',
      phase: 'working',
      currentRunId: 'run-mm-5',
    }),
  ];
  const runs = [
    makeRun('run-mm-4', {
      slotId: 'macwork-mm-4',
      status: 'completing',
      updatedAt: '2026-06-24T20:00:00.000Z',
    }),
    makeRun('run-mm-5', {
      slotId: 'macwork-mm-5',
      status: 'monitoring',
      updatedAt: '2026-06-24T12:00:00.000Z',
    }),
  ];

  assert.deepEqual(selectActiveRunSlotIds(slots, runs, { projects: [], machines: [] }), [
    'macwork-mm-5',
    'macwork-mm-4',
  ]);
});

test('slotHasActiveRunTerminal falls back to fleet phase when run list lags', () => {
  const slot = makeSlot('macwork-mm-3', {
    lifecycle: 'busy',
    phase: 'working',
    currentRunId: 'run-mm-3',
  });

  assert.equal(slotHasActiveRunTerminal(slot, new Map()), true);
  assert.equal(isActiveRunTerminalSlot(slot, [], new Map()), true);
});

test('selectActiveRunSlotIds includes held blocked runs and respects global filters', () => {
  const slots = [
    makeSlot('macwork-mm-2', {
      lifecycle: 'held',
      phase: 'pr-watch',
      currentRunId: 'run-mm-2',
      taskFile: 'feat/tat-3398-0623-201431',
    }),
    makeSlot('mini-mm-1', {
      machine: 'mini',
      lifecycle: 'busy',
      phase: 'working',
      currentRunId: 'run-mini',
    }),
  ];
  const runs = [
    makeRun('run-mm-2', { slotId: 'macwork-mm-2', status: 'blocked', ticketOrPr: 'TAT-3398' }),
    makeRun('run-mini', {
      slotId: 'mini-mm-1',
      status: 'monitoring',
      project: 'metamask-mobile-farm',
    }),
  ];

  assert.deepEqual(selectActiveRunSlotIds(slots, runs, { projects: [], machines: ['macwork'] }), [
    'macwork-mm-2',
  ]);
  assert.deepEqual(
    filterSlotsByGlobalFilters(slots, {
      projects: ['metamask-mobile-farm'],
      machines: ['macwork'],
    }).map((slot) => slot.slot),
    ['macwork-mm-2'],
  );
});

test('selectActiveRunSlotIds resolves active runs from agentContexts when currentRunId is null', () => {
  const slots = [
    makeSlot('macwork-core-2', {
      lifecycle: 'ready',
      agent: 'idle',
      currentRunId: null,
      platform: 'cli',
      project: 'metamask-core-farm',
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          label: 'Primary',
          status: 'blocked',
          runId: 'run-core-2',
          taskFile: 'temp/tasks/fix/9311/TASK.md',
          signalFile: 'temp/tasks/fix/9311/SIGNAL.json',
          runner: 'claude',
          model: 'opus',
          target: { session: 'core-2', window: 'zsh', pane: '1', target: 'core-2:zsh' },
          nudgeCount: 0,
        },
      ],
    }),
  ];
  const runs = [
    makeRun('run-core-2', {
      slotId: 'macwork-core-2',
      project: 'metamask-core-farm',
      status: 'blocked',
      updatedAt: '2026-06-30T12:19:07.998Z',
    }),
  ];

  assert.deepEqual(selectActiveRunSlotIds(slots, runs, { projects: [], machines: ['macwork'] }), [
    'macwork-core-2',
  ]);
});

test('selectPinnedSlotIds preserves pin order and respects global filters', () => {
  const slots = [
    makeSlot('macwork-mm-1'),
    makeSlot('macwork-mm-2'),
    makeSlot('mini-mm-1', { machine: 'mini' }),
  ];

  assert.deepEqual(
    selectPinnedSlotIds(slots, ['macwork-mm-2', 'mini-mm-1', 'macwork-mm-1'], {
      projects: [],
      machines: ['macwork'],
    }),
    ['macwork-mm-2', 'macwork-mm-1'],
  );
});
