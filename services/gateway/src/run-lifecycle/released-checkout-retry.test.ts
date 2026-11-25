import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  RELEASED_CHECKOUT_RETRY_MIN_MS,
  releasedCheckoutOwner,
  type ReleasedCheckoutRetryDeps,
  resetReleasedCheckoutRetryState,
  retryReleasedCheckoutIdleReturns,
} from './released-checkout-retry.js';
import type { SafeIdleSlotResult } from './safe-idle-slot.js';

const BRANCH = 'fix/tat-1-run-branch';

function slot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  const base: SlotStatus = {
    slot: 'node-core-2',
    machine: 'node',
    platform: 'cli',
    project: 'core',
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
    branch: BRANCH,
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
  return { ...base, ...overrides };
}

const RELEASED = {
  slotId: 'node-core-2',
  branch: BRANCH,
  headSha: 'a'.repeat(40),
  at: '2026-11-25T10:00:00.000Z',
};

function finished(overrides: Partial<Run> = {}): Run {
  const run = makeRun({
    id: 'artifact-run',
    project: 'core',
    status: 'done',
    completionPolicy: 'artifact-only',
    lane: 'comparison',
    slotId: 'node-core-2',
    branch: BRANCH,
    worktreeHeadAtDispatch: 'b'.repeat(40),
    createdAt: '2026-11-25T09:00:00.000Z',
    ...overrides,
  });
  // The shared fixture drops fields it does not list.
  return {
    ...run,
    releasedCheckout: 'releasedCheckout' in overrides ? overrides.releasedCheckout : RELEASED,
  };
}

let clock = 0;
let fleet: SlotStatus[];
let runs: Run[];
let row: Record<string, unknown> | null;
let bundle: { confirmed: true; taskDir: string } | { confirmed: false; reason: string };
let busy: boolean;
let absent: string | null;
let outcomes: Array<SafeIdleSlotResult | null>;
const returned: string[] = [];
const cleared: string[] = [];
const logs: string[] = [];
let bundleReads = 0;

const deps: ReleasedCheckoutRetryDeps = {
  now: () => clock,
  fleetSlots: async () => fleet,
  readSlotRow: async () => row,
  allRuns: async () => runs,
  freshRun: async (id) => runs.find((run) => run.id === id),
  bundleCheck: async () => {
    bundleReads++;
    return bundle;
  },
  slotBusy: () => busy,
  absentNode: async () => absent,
  returnToIdle: async (run) => {
    returned.push(run.id);
    return outcomes.shift() ?? { kind: 'ready' };
  },
  clearRetainedNote: async (run) => void cleared.push(run.id),
  log: (message) => void logs.push(message),
};

beforeEach(() => {
  resetReleasedCheckoutRetryState();
  clock = 1_000_000;
  fleet = [slot()];
  runs = [finished()];
  row = { lifecycle: 'ready', phase: null };
  bundle = { confirmed: true, taskDir: '/bundle/task' };
  busy = false;
  absent = null;
  outcomes = [];
  returned.length = 0;
  cleared.length = 0;
  logs.length = 0;
  bundleReads = 0;
});

/** Two passes: the slot must look eligible twice in a row before an attempt. */
async function twoPasses(): Promise<void> {
  await retryReleasedCheckoutIdleReturns(deps);
  clock += 60_000;
  await retryReleasedCheckoutIdleReturns(deps);
}

test('a refused release return is retried and clears the retained note', async () => {
  await twoPasses();
  assert.deepEqual(returned, ['artifact-run']);
  assert.deepEqual(cleared, ['artifact-run']);
  assert.match(logs.join('\n'), /returned run artifact's released checkout to idle/);
});

test('one eligible pass is not enough: a flapping node must stay present', async () => {
  await retryReleasedCheckoutIdleReturns(deps);
  assert.deepEqual(returned, []);
  absent = 'node';
  clock += 60_000;
  await retryReleasedCheckoutIdleReturns(deps);
  absent = null;
  clock += 60_000;
  await retryReleasedCheckoutIdleReturns(deps);
  assert.deepEqual(returned, [], 'the absent pass reset the streak');
});

test('only a finished artifact-only run that owns the branch qualifies', async () => {
  for (const changed of [
    finished({ status: 'failed' }),
    finished({ status: 'cancelled' }),
    finished({ completionPolicy: 'default' }),
    finished({ releasedCheckout: { ...RELEASED, branch: 'other' } }),
    finished({ releasedCheckout: undefined }),
    finished({ worktreeHeadAtDispatch: undefined }),
    finished({ project: 'other' }),
  ]) {
    assert.equal(
      releasedCheckoutOwner(slot(), [changed]),
      null,
      JSON.stringify({
        status: changed.status,
        policy: changed.completionPolicy,
        project: changed.project,
      }),
    );
  }
  assert.equal(releasedCheckoutOwner(slot(), [finished()])?.id, 'artifact-run');
});

test('an unfinished run naming the slot, or a newer run, owns its next use', async () => {
  const pin = finished({
    id: 'pin',
    status: 'slot-finding',
    createdAt: '2026-11-25T11:00:00.000Z',
  });
  assert.equal(releasedCheckoutOwner(slot(), [finished(), pin]), null);
  const newer = finished({
    id: 'newer',
    status: 'done',
    completionPolicy: 'default',
    createdAt: '2026-11-25T11:00:00.000Z',
  });
  assert.equal(releasedCheckoutOwner(slot(), [finished(), newer]), null);
});

test('an owned, busy, recovering or releasing slot is left alone', async () => {
  for (const setup of [
    () => (fleet = [slot({ currentRunId: 'other' })]),
    () => (fleet = [slot({ lifecycle: 'held' })]),
    () => (busy = true),
    () => (row = { lifecycle: 'ready', workspace_recovery: { id: 'r' } }),
    () => (row = { lifecycle: 'busy', phase: 'releasing' }),
  ]) {
    resetReleasedCheckoutRetryState();
    fleet = [slot()];
    row = { lifecycle: 'ready', phase: null };
    busy = false;
    setup();
    returned.length = 0;
    await twoPasses();
    assert.deepEqual(returned, [], setup.toString());
  }
});

test('an unconfirmed bundle never resets the checkout', async () => {
  bundle = { confirmed: false, reason: 'capture incomplete' };
  await twoPasses();
  assert.deepEqual(returned, []);
  assert.match(logs.join('\n'), /bundle is not confirmed \(capture incomplete\)/);
});

test('a refusal backs off, and the throttle comes before any bundle read', async () => {
  outcomes = [{ kind: 'unavailable', reason: 'Slot agent is working' }];
  await twoPasses();
  assert.deepEqual(returned, ['artifact-run']);
  assert.equal(bundleReads, 1);
  clock += 60_000;
  await retryReleasedCheckoutIdleReturns(deps);
  assert.equal(bundleReads, 1, 'still backing off: no bundle read');
  clock += RELEASED_CHECKOUT_RETRY_MIN_MS;
  await retryReleasedCheckoutIdleReturns(deps);
  assert.deepEqual(returned, ['artifact-run', 'artifact-run']);
  assert.equal(
    logs.filter((line) => line.includes('Slot agent is working')).length,
    1,
    'logged once',
  );
});

test('a throwing slot does not stop the others', async () => {
  fleet = [slot(), slot({ slot: 'node-core-3' })];
  runs = [
    finished(),
    finished({
      id: 'second',
      slotId: 'node-core-3',
      releasedCheckout: { ...RELEASED, slotId: 'node-core-3' },
    }),
  ];
  const original = deps.bundleCheck;
  deps.bundleCheck = async (run) => {
    bundleReads++;
    if (run.id === 'artifact-run') throw new Error('bundle unreadable');
    return bundle;
  };
  try {
    await twoPasses();
  } finally {
    deps.bundleCheck = original;
  }
  assert.deepEqual(returned, ['second']);
  assert.equal(bundleReads, 2);
  assert.match(logs.join('\n'), /node-core-2: .*bundle unreadable/);
});

test('a pass that starts while another is running is dropped', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let fleetReads = 0;
  const original = deps.fleetSlots;
  deps.fleetSlots = async () => {
    fleetReads++;
    await gate;
    return fleet;
  };
  try {
    const first = retryReleasedCheckoutIdleReturns(deps);
    await retryReleasedCheckoutIdleReturns(deps);
    release();
    await first;
  } finally {
    deps.fleetSlots = original;
  }
  assert.equal(fleetReads, 1);
});

test('the attempt re-reads the run and stops when it no longer qualifies', async () => {
  const original = deps.freshRun;
  deps.freshRun = async () => finished({ status: 'failed' });
  try {
    await twoPasses();
  } finally {
    deps.freshRun = original;
  }
  assert.deepEqual(returned, []);
});
