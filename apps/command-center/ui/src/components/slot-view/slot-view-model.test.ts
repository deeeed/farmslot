import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

import {
  adjacentSlotId,
  branchDiffKey,
  isDirectoryReadErrorMessage,
  isSlotViewPinnedLinkedRun,
  parseBranchDiffKey,
  realPath,
  shouldHideTerminalSlotRecipePanel,
  slotBoundRunIdForSlot,
  slotSwitcherEntries,
  slotSwitcherSignature,
  slotViewLoadedRunDrawerKey,
  slotViewPendingReviewDecision,
  slotViewReadyGateDecision,
  slotViewReviewDrawerKey,
  slotViewTerminalRunId,
} from './slot-view-model.js';

test('branch diff keys round-trip frozen and legacy paths', () => {
  const frozen = branchDiffKey('base-sha', 'a'.repeat(40), 'src/path:with-colon.ts');
  assert.deepEqual(parseBranchDiffKey(frozen), {
    base: 'base-sha',
    head: 'a'.repeat(40),
    path: 'src/path:with-colon.ts',
  });
  assert.deepEqual(parseBranchDiffKey('branch:main:src/index.ts'), {
    base: 'main',
    path: 'src/index.ts',
  });
  assert.equal(realPath(frozen), 'src/path:with-colon.ts');
  assert.equal(realPath('src/index.ts'), 'src/index.ts');
});

function makeSlot(slot: string, overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot,
    machine: 'runner-local',
    platform: 'darwin',
    project: 'farmslot-farm',
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

test('slotSwitcherEntries keeps fleet order and includes operator context in labels', () => {
  const entries = slotSwitcherEntries(
    [
      makeSlot('runner-local-1', {
        lifecycle: 'busy',
        project: 'mobile',
        currentRunId: 'runabcdef123',
      }),
      makeSlot('runner-local-2', {
        lifecycle: 'manual',
        project: 'extension',
        branch: 'feature/x',
      }),
    ],
    'runner-local-1',
  );

  assert.deepEqual(
    entries.map((entry) => entry.slot),
    ['runner-local-1', 'runner-local-2'],
  );
  assert.equal(entries[0]?.label, 'runner-local-1 · busy · mobile · runabcde');
  assert.equal(entries[1]?.title, 'runner-local · darwin · feature/x');
});

test('slotSwitcherEntries includes phase when present', () => {
  const entries = slotSwitcherEntries(
    [makeSlot('runner-local-1', { lifecycle: 'busy', phase: 'preparing' })],
    'runner-local-1',
  );

  assert.equal(entries[0]?.label, 'runner-local-1 · busy (preparing) · farmslot-farm');
});

test('slotSwitcherSignature changes only for switcher-visible slot fields', () => {
  const base = [makeSlot('runner-local-1', { lifecycle: 'busy', phase: 'preparing' })];
  const changedBranch = [
    makeSlot('runner-local-1', { lifecycle: 'busy', phase: 'preparing', branch: 'x' }),
  ];
  const changedPhase = [makeSlot('runner-local-1', { lifecycle: 'busy', phase: 'working' })];
  const changedProject = [
    makeSlot('runner-local-1', { lifecycle: 'busy', phase: 'preparing', project: 'mobile' }),
  ];
  const changedRun = [
    makeSlot('runner-local-1', {
      lifecycle: 'busy',
      phase: 'preparing',
      currentRunId: 'runabcdef123',
    }),
  ];
  const ignoredHealthChange = [
    makeSlot('runner-local-1', {
      lifecycle: 'busy',
      phase: 'preparing',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OFF', cdp: '-', fixtures: 'OK' },
    }),
  ];

  assert.notEqual(slotSwitcherSignature(base), slotSwitcherSignature(changedBranch));
  assert.notEqual(slotSwitcherSignature(base), slotSwitcherSignature(changedPhase));
  assert.notEqual(slotSwitcherSignature(base), slotSwitcherSignature(changedProject));
  assert.notEqual(slotSwitcherSignature(base), slotSwitcherSignature(changedRun));
  assert.equal(slotSwitcherSignature(base), slotSwitcherSignature(ignoredHealthChange));
});

test('slotSwitcherEntries preserves direct navigation to a slot missing from cached fleet', () => {
  const entries = slotSwitcherEntries([makeSlot('known-slot')], 'new-slot');

  assert.deepEqual(
    entries.map((entry) => entry.slot),
    ['new-slot', 'known-slot'],
  );
  assert.equal(entries[0]?.label, 'new-slot · current');
});

test('adjacentSlotId wraps around and tolerates a missing current slot', () => {
  const entries = [{ slot: 'a' }, { slot: 'b' }, { slot: 'c' }];

  assert.equal(adjacentSlotId(entries, 'b', 1), 'c');
  assert.equal(adjacentSlotId(entries, 'b', -1), 'a');
  assert.equal(adjacentSlotId(entries, 'c', 1), 'a');
  assert.equal(adjacentSlotId(entries, 'missing', 1), 'a');
  assert.equal(adjacentSlotId(entries, 'missing', -1), 'c');
  assert.equal(adjacentSlotId([{ slot: 'a' }], 'a', 1), 'a');
  assert.equal(adjacentSlotId([], 'missing', 1), '');
});

test('isDirectoryReadErrorMessage recognizes directory read failures', () => {
  assert.equal(isDirectoryReadErrorMessage('EISDIR: illegal operation on a directory, read'), true);
  assert.equal(isDirectoryReadErrorMessage('Path is a directory'), true);
  assert.equal(isDirectoryReadErrorMessage('ENOENT: no such file or directory'), false);
});

test('slotViewReadyGateDecision prefers pending ready decisions then newest resolved ready decision', () => {
  const readyPayload: Run['decisions'][number]['payload'] = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 0, additions: 0, deletions: 0 },
    workerReport: '',
    branch: 'main',
  };
  const oldResolved: Run['decisions'][number] = {
    id: 'old-ready',
    type: 'engine_ready',
    title: 'Ready',
    description: 'Old ready gate',
    actions: [],
    createdAt: '2026-05-14T00:00:00.000Z',
    resolvedAt: '2026-05-14T00:01:00.000Z',
    payload: readyPayload,
  };
  const newestResolved: Run['decisions'][number] = {
    ...oldResolved,
    id: 'new-ready',
    resolvedAt: '2026-05-14T00:02:00.000Z',
  };
  const pending: Run['decisions'][number] = {
    ...oldResolved,
    id: 'pending-ready',
    resolvedAt: undefined,
  };

  assert.equal(
    slotViewReadyGateDecision({ decisions: [oldResolved, newestResolved] }),
    newestResolved,
  );
  assert.equal(
    slotViewReadyGateDecision({ decisions: [oldResolved, pending, newestResolved] }),
    pending,
  );
  assert.equal(
    slotViewReadyGateDecision({
      decisions: [{ ...oldResolved, id: 'other', payload: undefined }],
    }),
    null,
  );
  assert.equal(slotViewReadyGateDecision(null), null);
});

test('slotViewPendingReviewDecision chooses the newest unresolved review gate', () => {
  const decision = (id: string, createdAt: string): Run['decisions'][number] => ({
    id,
    type: 'engine_review_posting',
    title: 'Review',
    description: 'Review gate',
    actions: [],
    createdAt,
    payload: { kind: 'review' } as Run['decisions'][number]['payload'],
  });
  assert.equal(
    slotViewPendingReviewDecision({
      decisions: [
        decision('old', '2026-08-13T09:00:00.000Z'),
        decision('new', '2026-08-13T10:00:00.000Z'),
      ],
    })?.id,
    'new',
  );
});

test('slotViewReviewDrawerKey preserves ready/review precedence over recipe hosts', () => {
  const readyDecision = {
    id: 'ready-1',
    type: 'engine_ready',
    title: 'Ready',
    description: 'Ready gate',
    actions: [],
    createdAt: '2026-05-14T00:00:00.000Z',
    payload: { kind: 'ready' },
  } as unknown as Run['decisions'][number];
  const reviewDecision = {
    ...readyDecision,
    id: 'review-1',
    type: 'engine_review',
    payload: { kind: 'review' },
  } as unknown as Run['decisions'][number];

  assert.equal(
    slotViewReviewDrawerKey({
      run: { id: 'run-1' },
      readyDecision,
      reviewDecision,
      hasRecipeHost: true,
    }),
    'ready:ready-1',
  );
  assert.equal(
    slotViewReviewDrawerKey({
      run: { id: 'run-1' },
      readyDecision: null,
      reviewDecision,
      hasRecipeHost: true,
    }),
    'review:review-1',
  );
  assert.equal(
    slotViewReviewDrawerKey({
      run: { id: 'run-1' },
      readyDecision: null,
      reviewDecision: null,
      hasRecipeHost: true,
    }),
    'recipe:run-1',
  );
  assert.equal(
    slotViewReviewDrawerKey({
      run: { id: 'run-1' },
      readyDecision: null,
      reviewDecision: null,
      hasRecipeHost: false,
    }),
    '',
  );
});

test('shouldHideTerminalSlotRecipePanel hides bare terminal runs', () => {
  assert.equal(
    shouldHideTerminalSlotRecipePanel({
      recipeHost: null,
      reviewDecision: null,
      readyDecision: null,
      showRecipeLoading: false,
      recipeRunsCount: 0,
      recipeRunsError: '',
      pinnedLinkedRun: false,
    }),
    true,
  );
});

test('shouldHideTerminalSlotRecipePanel keeps drawer while recipe runs load', () => {
  assert.equal(
    shouldHideTerminalSlotRecipePanel({
      recipeHost: null,
      reviewDecision: null,
      readyDecision: null,
      showRecipeLoading: true,
      recipeRunsCount: 0,
      recipeRunsError: '',
      pinnedLinkedRun: false,
    }),
    false,
  );
});

test('shouldHideTerminalSlotRecipePanel keeps drawer when recipe runs exist', () => {
  assert.equal(
    shouldHideTerminalSlotRecipePanel({
      recipeHost: null,
      reviewDecision: null,
      readyDecision: null,
      showRecipeLoading: false,
      recipeRunsCount: 2,
      recipeRunsError: '',
      pinnedLinkedRun: false,
    }),
    false,
  );
});

test('shouldHideTerminalSlotRecipePanel keeps drawer on recipe runs fetch error', () => {
  assert.equal(
    shouldHideTerminalSlotRecipePanel({
      recipeHost: null,
      reviewDecision: null,
      readyDecision: null,
      showRecipeLoading: false,
      recipeRunsCount: 0,
      recipeRunsError: 'gateway timeout',
      pinnedLinkedRun: false,
    }),
    false,
  );
});

test('shouldHideTerminalSlotRecipePanel keeps drawer for URL-pinned loaded runs', () => {
  assert.equal(
    shouldHideTerminalSlotRecipePanel({
      recipeHost: null,
      reviewDecision: null,
      readyDecision: null,
      showRecipeLoading: false,
      recipeRunsCount: 0,
      recipeRunsError: '',
      pinnedLinkedRun: true,
    }),
    false,
  );
});

test('isSlotViewPinnedLinkedRun matches only when URL runId equals linked run', () => {
  assert.equal(isSlotViewPinnedLinkedRun('run-a', 'run-a'), true);
  assert.equal(isSlotViewPinnedLinkedRun('run-a', 'run-b'), false);
  assert.equal(isSlotViewPinnedLinkedRun(null, 'run-a'), false);
});

test('slotViewLoadedRunDrawerKey namespaces dismiss state for loaded runs', () => {
  assert.equal(slotViewLoadedRunDrawerKey('run-a'), 'loaded:run-a');
  assert.equal(slotViewLoadedRunDrawerKey(null), '');
});

test('slotViewTerminalRunId prefers URL pin over linked-run hydration', () => {
  const linkedRun = { id: 'linked-run', slotId: 'slot-a' } as Run;
  assert.equal(slotViewTerminalRunId('slot-a', linkedRun, 'url-run', null), 'url-run');
  assert.equal(slotViewTerminalRunId('slot-a', linkedRun, null, null), 'linked-run');
  assert.equal(slotViewTerminalRunId('slot-b', linkedRun, null, null), '');
});

test('slotBoundRunIdForSlot falls back to fleet snapshot when slot row is missing', () => {
  assert.equal(
    slotBoundRunIdForSlot('mm-5', null, [{ slot: 'mm-5', currentRunId: 'bound-run' }]),
    'bound-run',
  );
  assert.equal(
    slotBoundRunIdForSlot('mm-5', 'slot-run', [{ slot: 'mm-5', currentRunId: 'bound-run' }]),
    'slot-run',
  );
});

test('slotViewTerminalRunId prefers fleet-bound run over stale URL pin', () => {
  const bound = { id: 'bound-run', slotId: 'mm-5' } as Run;
  const stale = { id: 'stale-run', slotId: 'mm-5' } as Run;
  assert.equal(slotViewTerminalRunId('mm-5', bound, 'stale-run', 'bound-run'), 'bound-run');
  assert.equal(slotViewTerminalRunId('mm-5', stale, 'stale-run', 'bound-run'), 'bound-run');
  assert.equal(slotViewTerminalRunId('mm-5', null, 'stale-run', 'bound-run'), 'bound-run');
});
