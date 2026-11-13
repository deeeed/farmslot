import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

const realFiles = await import('node:fs/promises');
mock.module('node:fs/promises', { namedExports: { ...realFiles, writeFile: async () => {} } });
const realFleet = await import('../methods/fleet.js');
let cachedFleet: FleetStatus;
let refreshes = 0;
let workspaceRefreshes = 0;
/** The machine probe: records a new checked_at. A test can replace it with a slower one. */
const instantProbe = async () => {
  refreshes++;
  cachedFleet = { ...cachedFleet, checkedAt: new Date().toISOString(), stale: false };
  return { fleet: cachedFleet };
};
let probe = instantProbe;
mock.module('../methods/fleet.js', {
  namedExports: {
    ...realFleet,
    fleetMonitorStatus: () =>
      realFleet.fleetMonitorStatus({
        load: async () => cachedFleet,
        workspaces: {
          read: (value) => value,
          refresh: async (value) => {
            workspaceRefreshes++;
            return value;
          },
        },
        refresh: () => probe(),
      }),
  },
});
/** While set, the monitor's violation scan waits for it, as a slow scan would. */
let scanHeld: Promise<void> | undefined;
const realGateStall = await import('./publication-gate-stall.js');
mock.module('./publication-gate-stall.js', {
  namedExports: {
    ...realGateStall,
    publicationGateStallReason: async (
      ...args: Parameters<typeof realGateStall.publicationGateStallReason>
    ) => {
      await scanHeld;
      return realGateStall.publicationGateStallReason(...args);
    },
  },
});
const { detectFleetMonitorViolations, detectPublicationGateViolations, startMonitor, stopMonitor } =
  await import('./fleet-monitor.js');

function slot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'runner-browser-2',
    machine: 'runner-local',
    platform: 'chrome-extension',
    project: 'example-browser-farm',
    health: { ssh: 'LOCAL', device: 'ext:OK', devserver: 'OFF', cdp: 'OK', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'busy',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    currentMode: null,
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: '',
    taskPhase: null,
    taskStepProgress: null,
    resourceRollup: 'none',
    ...overrides,
  } as SlotStatus;
}

function fleet(slots: SlotStatus[]): FleetStatus {
  return {
    checkedAt: '2026-04-25T00:00:00Z',
    slots,
    summary: {
      total: slots.length,
      ready: 0,
      busy: slots.length,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    machines: [],
  };
}

test('detectFleetMonitorViolations emits idle once until the slot recovers', () => {
  const notified = new Set<string>();
  const busyIdle = fleet([slot({ lifecycle: 'busy', phase: 'working', agent: 'idle' })]);
  const readyIdle = fleet([slot({ lifecycle: 'ready', agent: 'idle' })]);

  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:01Z').map(
      (v) => v.type,
    ),
    ['idle'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:02Z').map(
      (v) => v.type,
    ),
    [],
  );

  assert.deepEqual(
    detectFleetMonitorViolations(readyIdle, notified).map((v) => v.type),
    [],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:03Z').map(
      (v) => v.type,
    ),
    ['idle'],
  );
});

test('detectFleetMonitorViolations does not flag expected idle lifecycle phases', () => {
  for (const phase of ['preparing', 'dispatching', 'review-gate', 'releasing'] as const) {
    assert.deepEqual(
      detectFleetMonitorViolations(
        fleet([slot({ lifecycle: 'busy', phase, agent: 'idle' })]),
        new Set<string>(),
      ),
      [],
      `${phase} should allow an idle runner`,
    );
    assert.deepEqual(
      detectFleetMonitorViolations(
        fleet([slot({ lifecycle: 'busy', phase, agent: 'no-tmux' })]),
        new Set<string>(),
      ),
      [],
      `${phase} should allow tmux to be absent`,
    );
  }
});

test('detectFleetMonitorViolations trusts an active structured agent context', () => {
  const busyIdle = slot({
    lifecycle: 'busy',
    phase: 'working',
    agent: 'idle',
    currentRunId: 'run-1',
    agentContexts: [
      {
        id: 'ci-fix',
        role: 'ci-fix',
        label: 'CI fix',
        status: 'working',
        runId: 'run-1',
        lastSignalAt: '2026-04-25T00:00:00Z',
      },
    ],
  });

  assert.deepEqual(
    detectFleetMonitorViolations(
      fleet([busyIdle]),
      new Set<string>(),
      () => '2026-04-25T00:01:00Z',
    ),
    [],
  );
});

test('detectFleetMonitorViolations rejects stale or foreign structured contexts', () => {
  const activeContext = {
    id: 'ci-fix',
    role: 'ci-fix' as const,
    label: 'CI fix',
    status: 'working' as const,
    runId: 'run-1',
    lastSignalAt: '2026-04-25T00:00:00Z',
  };
  const base = {
    lifecycle: 'busy' as const,
    phase: 'working' as const,
    agent: 'idle' as const,
    currentRunId: 'run-1',
  };

  for (const { candidate, observedAt } of [
    {
      candidate: slot({ ...base, currentRunId: 'run-2', agentContexts: [activeContext] }),
      observedAt: '2026-04-25T00:01:00Z',
    },
    {
      candidate: slot({ ...base, agentContexts: [activeContext] }),
      observedAt: '2026-04-25T00:06:00Z',
    },
  ]) {
    assert.deepEqual(
      detectFleetMonitorViolations(fleet([candidate]), new Set<string>(), () => observedAt).map(
        (violation) => violation.type,
      ),
      ['idle'],
    );
  }
});

test('detectFleetMonitorViolations dedupes stuck and idle independently', () => {
  const notified = new Set<string>();
  const noTmux = fleet([slot({ lifecycle: 'busy', phase: 'working', agent: 'no-tmux' })]);
  const idle = fleet([slot({ lifecycle: 'busy', phase: 'working', agent: 'idle' })]);

  assert.deepEqual(
    detectFleetMonitorViolations(noTmux, notified).map((v) => v.type),
    ['stuck'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(noTmux, notified).map((v) => v.type),
    [],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(idle, notified).map((v) => v.type),
    ['idle'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(idle, notified).map((v) => v.type),
    [],
  );
});

test('the periodic monitor refreshes stale machine probes and publishes the fresh snapshot', async (t) => {
  cachedFleet = fleet([slot({ lifecycle: 'ready', dispatchable: true })]);
  refreshes = 0;
  const published: FleetStatus[] = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  startMonitor({
    onPublicationGateStall() {},
    onFleetUpdated: (value) => published.push(value),
    onDecisionNew() {},
    onViolation() {},
  });
  t.after(stopMonitor);
  t.mock.timers.tick(30000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(published[0].stale, true);
  t.mock.timers.tick(30000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1, 'fresh snapshots do not repeat expensive probes');
  assert.equal(published.at(-1)?.stale, false);
  assert.equal(published.at(-1)?.slots[0].dispatchable, true);
});

test('the periodic monitor does not inspect workspaces when nobody requests them', async (t) => {
  cachedFleet = { ...fleet([slot({ lifecycle: 'ready' })]), checkedAt: new Date().toISOString() };
  workspaceRefreshes = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  startMonitor({
    onPublicationGateStall() {},
    onFleetUpdated() {},
    onDecisionNew() {},
    onViolation() {},
  });
  t.after(stopMonitor);
  for (let interval = 0; interval < 3; interval++) {
    t.mock.timers.tick(30000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(
    workspaceRefreshes,
    0,
    'Background health monitoring launched viewer-only Git inspection',
  );
});

test('stuck publication gates use the fleet violation feed, dedupe, and clear on operator wait', async () => {
  const { makeRun } = await import('../run-engine/test-fixtures.js');
  const now = Date.parse('2026-01-01T00:11:00Z');
  const run = makeRun({
    id: 'example-gate',
    status: 'human-gating',
    slotId: 'runner-browser-2',
    decisions: [],
    steps: [{ name: 'human-gate', status: 'running', startedAt: '2026-01-01T00:00:00Z' }],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'example-review',
            source: 'dispatch',
            mode: 'warm',
            runner: 'codex',
            model: null,
            reviewerSessionId: 'example-session',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  const current = fleet([slot({ currentRunId: run.id, phase: 'review-gate' })]);
  const notified = new Set<string>();
  const before = structuredClone(run);
  const detect = () => detectPublicationGateViolations(current, notified, now, () => run);
  const [violation] = await detect();
  assert.equal(violation.type, 'waiting');
  assert.equal(violation.target, run.id);
  assert.equal(violation.slotId, run.slotId);
  assert.match(violation.message, /human-gate.*more than 10 minutes.*verdict is recorded/);
  assert.equal(violation.nudgeSent, null);
  assert.deepEqual(await detect(), []);
  assert.deepEqual(run, before);
  run.decisions.push({
    id: 'operator',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    actions: [],
    createdAt: new Date(now).toISOString(),
  });
  assert.deepEqual(await detect(), []);
  assert.equal(notified.size, 0);
  run.decisions = [];
  assert.equal((await detect()).length, 1);
});

test('a decision presented during the reviewer probe suppresses obsolete stall evidence', async () => {
  const { makeRun } = await import('../run-engine/test-fixtures.js');
  const now = Date.parse('2026-01-01T00:11:00Z');
  const run = makeRun({
    id: 'example-gate-race',
    status: 'human-gating',
    decisions: [],
    steps: [{ name: 'human-gate', status: 'running', startedAt: '2026-01-01T00:00:00Z' }],
    agentContexts: [
      {
        id: 'reviewer',
        role: 'review',
        label: 'Review',
        status: 'working',
        runId: 'example-gate-race',
        slotId: 'runner-browser-2',
      },
    ],
  });
  const current = fleet([slot({ currentRunId: run.id })]);
  const violations = await detectPublicationGateViolations(
    current,
    new Set(),
    now,
    () => run,
    async () => {
      run.decisions.push({
        id: 'operator',
        type: 'engine_human_gate',
        title: 'Gate',
        description: '',
        actions: [],
        createdAt: new Date(now).toISOString(),
      });
      return 'absent';
    },
  );
  assert.deepEqual(violations, []);
});

test('the production monitor routes gate stalls only to its notification callback', async (t) => {
  const { createRun, updateRun, deleteRun } = await import('../runs/store.js');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'synthetic-stall',
  });
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'runner-browser-2',
    steps: [
      {
        name: 'human-gate',
        status: 'running',
        startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      },
    ],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'synthetic-review',
            source: 'dispatch',
            mode: 'cold',
            runner: 'codex',
            model: null,
            reviewerSessionId: 'synthetic-session',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  t.after(async () => {
    stopMonitor();
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  cachedFleet = {
    ...fleet([slot({ currentRunId: run.id, lifecycle: 'ready', agent: 'working' })]),
    checkedAt: new Date().toISOString(),
  };
  let flags = 0;
  const recoverable: unknown[] = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  startMonitor({
    onFleetUpdated() {},
    onDecisionNew() {},
    onViolation: (violation) => recoverable.push(violation),
    onPublicationGateStall: (violation) => {
      assert.equal(violation.target, run.id);
      flags++;
    },
  });
  t.mock.timers.tick(30_000);
  for (let tick = 0; tick < 20 && !flags; tick++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flags, 1);
  assert.deepEqual(recoverable, [], 'stuck-gate flags never reach the recovery callback');
});

/** The production monitor loop on a fake clock, its probe taking `probeMs`. Returns what it published. */
async function runMonitorLoop(
  t: import('node:test').TestContext,
  probeMs: number,
  turns: number,
): Promise<FleetStatus[]> {
  t.mock.timers.enable({
    apis: ['setInterval', 'setTimeout', 'Date'],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  cachedFleet = {
    ...fleet([slot({ lifecycle: 'ready', dispatchable: true })]),
    checkedAt: new Date().toISOString(),
  };
  refreshes = 0;
  // One refresh at a time, joined by every kick meanwhile, as the gateway's coordinator does.
  probe = realFleet.withFollowUpRefresh(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, probeMs));
    return instantProbe();
  }).join;
  t.after(() => {
    probe = instantProbe;
  });
  const published: FleetStatus[] = [];
  startMonitor({
    onPublicationGateStall() {},
    onFleetUpdated: (value) => published.push(value),
    onDecisionNew() {},
    onViolation() {},
  });
  t.after(stopMonitor);
  for (let turn = 0; turn < turns; turn++) {
    // A second at a time, so a probe ending mid-turn lands when it would.
    for (let second = 0; second < 30; second++) {
      t.mock.timers.tick(1_000);
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return published;
}

test('the monitor loop keeps a fleet fresh when its refresh fits the lead', async (t) => {
  const { fleetRefreshDueAgeMs, fleetStaleThresholdMs } = await import('../fleet/freshness.js');
  // A refresh that fits: started a 30 s turn after the due age, it ends 30 s early.
  const fits = fleetStaleThresholdMs() - fleetRefreshDueAgeMs() - 60_000;
  // 40 minutes of turns.
  const published = await runMonitorLoop(t, fits, 80);
  assert.equal(published.length, 80);
  assert.deepEqual(
    published.flatMap((value, turn) => (value.stale ? [turn] : [])),
    [],
    'no turn published a stale fleet',
  );
  assert.ok(refreshes >= 3, `the loop refreshed, saw ${refreshes}`);
});

test('the monitor loop turns stale when the refresh cannot fit before the threshold', async (t) => {
  const { fleetRefreshDueAgeMs, fleetStaleThresholdMs } = await import('../fleet/freshness.js');
  // Started at the due age at the earliest, it ends past the threshold.
  const tooSlow = fleetStaleThresholdMs() - fleetRefreshDueAgeMs() + 1_000;
  const published = await runMonitorLoop(t, tooSlow, 80);
  assert.ok(
    published.some((value) => value.stale),
    'a refresh longer than the lead leaves stale turns',
  );
});

test('a slow violation scan does not stop the reads that keep the fleet fresh', async (t) => {
  const { createRun, updateRun, deleteRun } = await import('../runs/store.js');
  // A run on the slot, so each scan reaches the held gate check.
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'slow-scan' });
  let release!: () => void;
  scanHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    scanHeld = undefined;
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'human-gating', slotId: 'runner-browser-2' });
  t.mock.timers.enable({
    apis: ['setInterval', 'setTimeout', 'Date'],
    now: Date.parse('2026-06-01T00:00:00Z'),
  });
  cachedFleet = {
    ...fleet([slot({ lifecycle: 'ready', dispatchable: true, currentRunId: run.id })]),
    checkedAt: new Date().toISOString(),
  };
  refreshes = 0;
  const published: FleetStatus[] = [];
  startMonitor({
    onPublicationGateStall() {},
    onFleetUpdated: (value) => published.push(value),
    onDecisionNew() {},
    onViolation() {},
  });
  t.after(stopMonitor);
  // The first scan never finishes; 40 minutes of turns follow.
  for (let turn = 0; turn < 80; turn++) {
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(published.length, 80, 'every turn read the fleet');
  assert.deepEqual(
    published.flatMap((value, turn) => (value.stale ? [turn] : [])),
    [],
    'no turn published a stale fleet',
  );
  assert.ok(refreshes >= 3, `the loop kept refreshing, saw ${refreshes}`);
});
