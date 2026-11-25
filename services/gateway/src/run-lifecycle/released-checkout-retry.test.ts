import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  RELEASED_CHECKOUT_RETRY_MAX_MS,
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

/** A later pinned run that failed before it claimed the slot. */
function unclaimedPin(overrides: Partial<Run> = {}): Run {
  return finished({
    id: 'failed-pin',
    status: 'failed',
    completionPolicy: 'default',
    branch: 'fix/tat-2-other',
    createdAt: '2026-11-25T11:00:00.000Z',
    releasedCheckout: undefined,
    steps: [{ name: 'find-slot', status: 'failed' }],
    ...overrides,
  });
}

let clock = 0;
let fleet: SlotStatus[];
let runs: Run[];
let live: Run[] | undefined;
let row: Record<string, unknown> | null;
let bundle: { confirmed: true; taskDir: string } | { confirmed: false; reason: string };
let busy: boolean;
let absent: string | null;
let connects: number;
let outcomes: Array<SafeIdleSlotResult | null>;
const returned: string[] = [];
const logs: string[] = [];
let bundleReads = 0;
let runScans = 0;

const deps: ReleasedCheckoutRetryDeps = {
  now: () => clock,
  fleetSlots: async () => fleet,
  defaultBranch: async () => 'main',
  readSlotRow: async () => row,
  allRuns: async () => {
    runScans++;
    return runs;
  },
  liveRuns: () => live ?? runs,
  freshRun: async (id) => (live ?? runs).find((run) => run.id === id),
  bundleCheck: async () => {
    bundleReads++;
    return bundle;
  },
  slotBusy: () => busy,
  absentNode: async () => absent,
  nodeConnects: () => connects,
  returnToIdle: async (run) => {
    returned.push(run.id);
    return outcomes.shift() ?? { kind: 'ready' };
  },
  log: (message) => void logs.push(message),
};

beforeEach(() => {
  resetReleasedCheckoutRetryState();
  clock = 1_000_000;
  fleet = [slot()];
  runs = [finished()];
  live = undefined;
  row = { lifecycle: 'ready', phase: null, branch: BRANCH };
  bundle = { confirmed: true, taskDir: '/bundle/task' };
  busy = false;
  absent = null;
  connects = 0;
  outcomes = [];
  returned.length = 0;
  logs.length = 0;
  bundleReads = 0;
  runScans = 0;
});

async function pass(advanceMs = 60_000): Promise<void> {
  clock += advanceMs;
  await retryReleasedCheckoutIdleReturns(deps);
}

/** Two passes: the slot must look eligible twice in a row before an attempt. */
async function twoPasses(): Promise<void> {
  await pass();
  await pass();
}

/** Run `body` with one dependency replaced, restoring it afterwards. */
async function withDep<K extends keyof ReleasedCheckoutRetryDeps>(
  key: K,
  value: ReleasedCheckoutRetryDeps[K],
  body: () => Promise<void>,
): Promise<void> {
  const original = deps[key];
  deps[key] = value;
  try {
    await body();
  } finally {
    deps[key] = original;
  }
}

test('a refused release return is retried on the second stable pass', async () => {
  await pass();
  assert.deepEqual(returned, []);
  await pass();
  assert.deepEqual(returned, ['artifact-run']);
  assert.match(logs.join('\n'), /returned run artifact's released checkout to idle/);
});

test('a slot idle on its default branch costs no run scan', async () => {
  fleet = [slot({ branch: 'main' })];
  await twoPasses();
  assert.equal(runScans, 0);
  assert.deepEqual(returned, []);
});

test('an absent pass or a node reconnect between passes starts the streak over', async () => {
  await pass();
  absent = 'node';
  await pass();
  absent = null;
  await pass();
  assert.deepEqual(returned, [], 'the absent pass reset the streak');
  connects++;
  await pass();
  assert.deepEqual(returned, [], 'a reconnect between passes reset it too');
  await pass();
  assert.deepEqual(returned, ['artifact-run']);
});

test('a busy or absent pass keeps the back-off', async () => {
  outcomes = [{ kind: 'unavailable', reason: 'Slot agent is working' }];
  await twoPasses();
  assert.deepEqual(returned, ['artifact-run']);
  absent = 'node';
  await pass();
  absent = null;
  await twoPasses();
  assert.deepEqual(returned, ['artifact-run'], 'still backing off');
  await pass(RELEASED_CHECKOUT_RETRY_MIN_MS);
  assert.deepEqual(returned, ['artifact-run', 'artifact-run']);
});

test('only a finished artifact-only run that owns the branch qualifies', () => {
  for (const changed of [
    finished({ status: 'failed' }),
    finished({ status: 'cancelled' }),
    finished({ completionPolicy: 'default' }),
    finished({ releasedCheckout: { ...RELEASED, branch: 'other' } }),
    finished({ releasedCheckout: undefined }),
    finished({ worktreeHeadAtDispatch: undefined }),
    finished({ project: 'other' }),
  ])
    assert.equal(
      releasedCheckoutOwner(slot(), [changed]),
      null,
      JSON.stringify({ status: changed.status, policy: changed.completionPolicy }),
    );
  assert.equal(releasedCheckoutOwner(slot(), [finished()])?.id, 'artifact-run');
});

test('an unfinished run naming the slot, or a newer run that claimed it, owns its next use', () => {
  const pin = finished({
    id: 'pin',
    status: 'slot-finding',
    createdAt: '2026-11-25T11:00:00.000Z',
  });
  assert.equal(releasedCheckoutOwner(slot(), [finished(), pin]), null);
  const newer = finished({
    id: 'newer',
    completionPolicy: 'default',
    createdAt: '2026-11-25T11:00:00.000Z',
  });
  assert.equal(releasedCheckoutOwner(slot(), [finished(), newer]), null);
});

test('a later pin that failed before claiming the slot does not strand it', () => {
  assert.equal(releasedCheckoutOwner(slot(), [finished(), unclaimedPin()])?.id, 'artifact-run');
  assert.equal(
    releasedCheckoutOwner(slot(), [
      finished(),
      unclaimedPin({ steps: [{ name: 'find-slot', status: 'done' }] }),
    ]),
    null,
    'a newer run that did claim it owns it',
  );
});

test('a refused completion on the same branch keeps the checkout', () => {
  const refused = finished({
    id: 'refused',
    status: 'failed',
    completionPolicy: 'default',
    createdAt: '2026-11-25T08:00:00.000Z',
    releasedCheckout: undefined,
    steps: [
      { name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: 'unpushed' } },
    ],
  });
  assert.equal(releasedCheckoutOwner(slot(), [finished(), refused]), null);
  assert.equal(
    releasedCheckoutOwner(slot(), [finished(), { ...refused, branch: 'fix/elsewhere' }])?.id,
    'artifact-run',
  );
});

test('an owned, busy, recovering, releasing or moved slot is left alone', async () => {
  for (const setup of [
    () => (fleet = [slot({ currentRunId: 'other' })]),
    () => (fleet = [slot({ lifecycle: 'held' })]),
    () => (busy = true),
    () => (row = { lifecycle: 'ready', branch: BRANCH, workspace_recovery: { id: 'r' } }),
    () => (row = { lifecycle: 'busy', phase: 'releasing', branch: BRANCH }),
    () => (row = { lifecycle: 'ready', phase: null, branch: 'main' }),
  ]) {
    resetReleasedCheckoutRetryState();
    fleet = [slot()];
    row = { lifecycle: 'ready', phase: null, branch: BRANCH };
    busy = false;
    setup();
    returned.length = 0;
    await twoPasses();
    assert.deepEqual(returned, [], setup.toString());
  }
});

test('a pin that arrives during the pass is seen before acting', async () => {
  await pass();
  live = [
    ...runs,
    finished({ id: 'late-pin', status: 'slot-finding', createdAt: '2026-11-25T12:00:00.000Z' }),
  ];
  await pass();
  assert.deepEqual(returned, []);
  assert.match(logs.join('\n'), /the run no longer qualifies/);
});

test('the attempt re-reads the run and stops when it no longer qualifies', async () => {
  await withDep('freshRun', async () => finished({ status: 'failed' }), twoPasses);
  assert.deepEqual(returned, []);
  assert.match(logs.join('\n'), /the run no longer qualifies/);
});

test('an unconfirmed bundle never resets the checkout', async () => {
  bundle = { confirmed: false, reason: 'capture incomplete' };
  await twoPasses();
  assert.deepEqual(returned, []);
  assert.match(logs.join('\n'), /bundle is not confirmed \(capture incomplete\)/);
});

test('refusals back off from 5 min to the 1 h cap, logging each reason once', async () => {
  outcomes = Array.from({ length: 12 }, () => ({
    kind: 'unavailable' as const,
    reason: 'Slot agent is working',
  }));
  await twoPasses();
  assert.equal(bundleReads, 1);
  await pass();
  assert.equal(bundleReads, 1, 'throttled before any bundle read');
  // Each wait runs from the attempt that set it.
  let attemptedAt = clock - 60_000;
  let wait = RELEASED_CHECKOUT_RETRY_MIN_MS;
  for (let attempt = 2; attempt <= 8; attempt++) {
    clock = attemptedAt + wait - 1_000;
    await pass(0);
    assert.equal(bundleReads, attempt - 1, `attempt ${attempt} still waits`);
    clock = attemptedAt + wait;
    await pass(0);
    assert.equal(bundleReads, attempt, `attempt ${attempt} after ${wait} ms`);
    attemptedAt = clock;
    wait = Math.min(RELEASED_CHECKOUT_RETRY_MAX_MS, wait * 2);
  }
  assert.equal(wait, RELEASED_CHECKOUT_RETRY_MAX_MS);
  assert.equal(logs.filter((line) => line.includes('Slot agent is working')).length, 1);
});

test('a throwing attempt waits one back-off, not two, and is logged', async () => {
  await withDep(
    'bundleCheck',
    async () => {
      bundleReads++;
      throw new Error('bundle unreadable');
    },
    async () => {
      await twoPasses();
      await pass(RELEASED_CHECKOUT_RETRY_MIN_MS);
    },
  );
  assert.equal(bundleReads, 2, 'retried after 5 min');
  assert.match(logs.join('\n'), /node-core-2: .*bundle unreadable/);
});

test('a throw before any state exists is still logged', async () => {
  await withDep(
    'absentNode',
    async () => {
      throw new Error('slot vars unreadable');
    },
    twoPasses,
  );
  assert.match(logs.join('\n'), /node-core-2: .*slot vars unreadable/);
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
  await withDep(
    'bundleCheck',
    async (run) => {
      if (run.id === 'artifact-run') throw new Error('bundle unreadable');
      return bundle;
    },
    twoPasses,
  );
  assert.deepEqual(returned, ['second']);
});

test('a pass that starts while another is running is dropped', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let fleetReads = 0;
  await withDep(
    'fleetSlots',
    async () => {
      fleetReads++;
      await gate;
      return fleet;
    },
    async () => {
      const first = retryReleasedCheckoutIdleReturns(deps);
      await retryReleasedCheckoutIdleReturns(deps);
      release();
      await first;
    },
  );
  assert.equal(fleetReads, 1);
});
