import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { beforeEach, mock, test } from 'node:test';

import type { ActiveResourcePointer, Run, SlotResource } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

let clock = 1000;

let row: Record<string, unknown>;
let pointer: ActiveResourcePointer | undefined;
let alive = true;
let stops = 0;
let boots = 0;
let lookups = 0;
let activeWorker = false;
let unrecordedWorker = false;
let warmLease = false;
let unrelatedLease = false;
let epoch = 0;
let tmuxState = 'present';
let outsideRepo = false;
let pagedOwner = false;
let foreign = false;
let unhealthyBoot = false;
let closedHistory = false;
let realStatus = false;
let promptDelivered = false;
const run: Run = {
  id: 'run-a',
  familyId: 'family-a',
  lane: 'validation',
  flowType: 'dev',
  project: 'fixture-project',
  ticketOrPr: 'fixture-task',
  slotId: 'slot-a',
  status: 'paused',
  branch: null,
  taskFile: null,
  steps: [],
  decisions: [],
  agentContexts: [],
  metrics: { nudgeCount: 0, model: null, runner: null },
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};
const resources = (): SlotResource[] => [
  {
    id: 'server',
    status: alive ? 'running' : 'stopped',
    definition: {
      type: 'dev-server',
      label: 'Fixture server',
      controllable: true,
      streamable: false,
      watch: { type: 'port-listen', port: '{{port}}' },
      hooks: { boot: 'fixture-prepare', health: 'fixture-health' },
    },
  },
];
const vars = makeVars({
  slotId: 'slot-a',
  machine: 'fixture-node',
  host: 'fixture-node',
  projectName: 'fixture-project',
  remoteRepo: '/fixture',
  repo: '/fixture',
  resourceVars: { port: '9001' },
});
const realState = await import('../core/state.js');
mock.module('../core/state.js', {
  namedExports: {
    ...realState,
    readSlotRow: async () => (realStatus ? realState.readSlotRow(vars.slotId) : row),
    markSlotStatusIf: async (
      _slot: string,
      predicate: (row: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (realStatus) return realState.markSlotStatusIf(_slot, predicate, fields);
      const applied = predicate(row);
      if (applied) row = { ...row, ...fields };
      return { applied, epoch: row.slot_epoch };
    },
  },
});
const realConfig = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson: { timeouts: { prepare_preflight_s: 0.001 } } }),
  },
});
const realIo = await import('../core/slot-io.js');
mock.module('../core/slot-io.js', {
  namedExports: { ...realIo, slotRealpath: async () => '/fixture' },
});
const fixtureExec = async (_vars: unknown, command: string) => {
  if (realStatus && command.includes('.observability'))
    return { exitCode: 0, stdout: '', stderr: '' };
  if (realStatus && command.includes('FARMSLOT_RUNNER_PATTERN='))
    return {
      exitCode: promptDelivered ? 0 : 1,
      stdout: promptDelivered ? '301\n' : '',
      stderr: '',
    };
  if (realStatus && command.includes('SIGNAL.json'))
    return {
      exitCode: 0,
      stdout: `${promptDelivered ? 3000000000 : 2000000000}\n${JSON.stringify({ status: promptDelivered ? 'running' : 'complete' })}\n`,
      stderr: '',
    };
  if (realStatus && command.includes('list-panes'))
    return { exitCode: 0, stdout: '%7\n', stderr: '' };
  if (command.startsWith('lsof -a'))
    return { stdout: `p101\nn${foreign ? '/foreign' : '/fixture'}\n`, stderr: '', exitCode: 0 };
  if (command.startsWith('ps -p'))
    return {
      stdout: `101 101 Mon Jan 1 00:00:${foreign ? '02' : '00'} 2024`,
      stderr: '',
      exitCode: 0,
    };
  if (command.startsWith('lsof ')) {
    lookups++;
    assert.match(command, /-iTCP:9001 -sTCP:LISTEN -t$/);
    return { stdout: alive ? '101\n' : '', stderr: '', exitCode: alive ? 0 : 1 };
  }
  if (command.startsWith('ps -axo'))
    return {
      stdout:
        `101 1 101 Mon Jan 1 00:00:${foreign ? '02' : '00'} 2024 fixture-server\n102 101 101 Mon Jan 1 00:00:01 2024 fixture-helper` +
        (tmuxState === 'foreign' ? '\n200 1 200 Mon Jan 1 00:00:02 2024 tmux' : ''),
      stderr: '',
      exitCode: 0,
    };
  if (command.includes('list-panes'))
    return {
      stdout:
        tmuxState === 'present'
          ? `fixture-session\t%7\t201\t${outsideRepo ? '/other-workspace' : '/fixture'}\t/fixture\n`
          : '',
      stderr: '',
      exitCode: tmuxState === 'present' ? 0 : tmuxState === 'timeout' ? 124 : 1,
    };
  if (command.includes('farmslot-owned-process-reap')) {
    assert.ok(command.includes(`101|1|Mon Jan 1 00:00:${foreign ? '02' : '00'} 2024`));
    assert.match(command, /102\|0\|Mon Jan 1 00:00:01 2024/);
    assert.ok(!command.includes('pkill') && !command.includes('killall'));
    alive = false;
    stops++;
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  throw new Error(`Unexpected fixture command: ${command}`);
};
const realExec = await import('../core/exec.js');
mock.module('../core/exec.js', { namedExports: { ...realExec, execOnSlot: fixtureExec } });
const realTmux = await import('../core/tmux.js');
mock.module('../core/tmux.js', {
  namedExports: {
    ...realTmux,
    resolveTmuxSession: async () => 'fixture-session',
    resolveExactTmuxWindowPane: async () => ({ paneId: '%7', panePid: '201' }),
    resolveTmuxWindowId: async () => '@7',
    respawnTmuxWindowWithCommand: async (
      _vars: unknown,
      _target: string,
      _command: string,
      options?: { beforeRespawn?: () => void | Promise<void> },
    ) => {
      await options?.beforeRespawn?.();
      assert.equal(alive, true, 'runtime must be restored before the warm prompt is delivered');
      assert.equal((await realState.readSlotRow(vars.slotId))?.idle_devservers, null);
      promptDelivered = true;
    },
  },
});
const realSupport = await import('../node-support/ensure.js');
mock.module('../node-support/ensure.js', {
  namedExports: { ...realSupport, ensureNodeSupportBundle: async () => {} },
});
const realCore = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...realCore, execOnSlot: fixtureExec } });
const realResources = await import('../fleet/resource-manager.js');
mock.module('../fleet/resource-manager.js', {
  namedExports: {
    ...realResources,
    resolveSlotResources: async () => resources(),
    getActiveResource: () => pointer,
    setActiveResource: (_slot: string, _resource: string, value: ActiveResourcePointer) =>
      (pointer = value),
    deleteActiveResource: () => (pointer = undefined),
    setCachedResourceStatus: () => {},
    probeResourceStatus: async () => ({ status: alive ? 'running' : 'stopped' }),
    executeResourceControl: async (_slot: string, resource: string, action: string) => {
      assert.equal(resource, 'server');
      assert.equal(action, 'boot');
      boots++;
      alive = !unhealthyBoot;
      return { ok: true };
    },
  },
});
const realCapabilities = await import('../methods/runtime-capabilities.js');
mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    ...realCapabilities,
    getRuntimeCapabilityRegistry: () => ({
      withSlotResourceShutdown: async (
        _slot: string,
        _run: string,
        _resource: string,
        _device: boolean,
        body: () => Promise<void>,
      ) => {
        await body();
        return { ok: true };
      },
      settledStatus: async () => ({
        leases: warmLease
          ? [{ state: 'released', keepWarmUntil: '2024-01-02' }]
          : unrelatedLease
            ? [{ state: 'acquired', capabilityId: 'other' }]
            : [],
        catalog: [
          { id: 'other', actions: {}, affectedResources: [{ resourceId: 'other-resource' }] },
        ],
      }),
    }),
  },
});
const realProgress = await import('../runners/run-progress.js');
mock.module('../runners/run-progress.js', {
  namedExports: {
    ...realProgress,
    readRunProgress: async (observed: Run) => ({
      kind: observed.id === 'old-run' ? 'unproven' : activeWorker ? 'making-progress' : 'idle',
    }),
  },
});
const realProcess = await import('../runners/session-process.js');
mock.module('../runners/session-process.js', {
  namedExports: {
    ...realProcess,
    probeRunnerDescendantPid: async () => ({ state: unrecordedWorker ? 'present' : 'absent' }),
  },
});
const realRuns = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...realRuns,
    listRuns: (filter?: { limit?: number }) => ({
      runs:
        pagedOwner && (filter?.limit ?? 500) <= 500
          ? []
          : [
              run,
              ...(closedHistory
                ? [
                    {
                      ...run,
                      id: 'old-run',
                      status: 'done',
                      agentContexts: [
                        {
                          id: 'primary',
                          role: 'primary',
                          target: {
                            target: '%7',
                            paneId: '%7',
                            session: 'fixture-session',
                            window: 'worker',
                          },
                        },
                      ],
                    },
                  ]
                : []),
            ],
    }),
  },
});
const { withRunTransitionWhileMachineHeld } = await import('./transition-coordinator.js');
const { reapIdleDevServers, restoreIdleDevServers } = await import('./idle-devserver-service.js');
mock.method(Date, 'now', () => clock);
const { DEVSERVER_IDLE_LIMIT_MS } = await import('./idle-devserver.js');

beforeEach(() => {
  clock += DEVSERVER_IDLE_LIMIT_MS;
  epoch++;
  row = { current_run_id: run.id, slot_epoch: epoch };
  pointer = undefined;
  alive = true;
  stops = 0;
  boots = 0;
  lookups = 0;
  activeWorker = false;
  unrecordedWorker = false;
  warmLease = false;
  unrelatedLease = false;
  tmuxState = 'present';
  outsideRepo = false;
  pagedOwner = false;
  foreign = false;
  unhealthyBoot = false;
  closedHistory = false;
  realStatus = false;
  promptDelivered = false;
});

test('port watch resolves once, expires through the real identity reaper and resumes through boot', async () => {
  await reapIdleDevServers('slot-a');
  assert.equal(lookups, 1);
  clock++;
  await reapIdleDevServers('slot-a');
  assert.equal(lookups, 1, 'ordinary polling does not repeat lsof');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
  assert.equal(alive, false);
  await restoreIdleDevServers('slot-a', run.id);
  assert.equal(boots, 1);
  assert.equal(alive, true);
});

test('a worker active at expiry keeps its server', async () => {
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  activeWorker = true;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('an unrecorded live worker keeps its server even when run state says paused', async () => {
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  unrecordedWorker = true;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a retained warm capability keeps its server', async () => {
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  warmLease = true;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('an unrelated retained resource does not exempt the idle dev server', async () => {
  unrelatedLease = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
});

test('a proven absent tmux server does not block idle cleanup', async () => {
  tmuxState = 'absent';
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
});

test('failed tmux inspection with a live server fails closed', async () => {
  tmuxState = 'foreign';
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await assert.rejects(reapIdleDevServers('slot-a'), /worker census unavailable/);
  assert.equal(stops, 0);
});

test('an unrecorded worker in the slot session stays protected after changing cwd', async () => {
  unrecordedWorker = true;
  outsideRepo = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a parked owner older than the default run-list page still has an idle cap', async () => {
  pagedOwner = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
});

for (const afterAdmission of [false, true]) {
  test(`a foreign listener after the managed server exited is never stopped, admitted=${afterAdmission}`, async () => {
    if (afterAdmission) await reapIdleDevServers('slot-a');
    foreign = true;
    clock += DEVSERVER_IDLE_LIMIT_MS;
    await reapIdleDevServers('slot-a');
    clock += DEVSERVER_IDLE_LIMIT_MS;
    await reapIdleDevServers('slot-a');
    assert.equal(stops, 0);
  });
}

test('stale launch metadata cannot authorize a replacement listener with the same PID', async () => {
  pointer = {
    pid: 101,
    startedAt: '2024-01-01',
    runId: run.id,
    meta: {
      runId: run.id,
      slotId: 'slot-a',
      startedAt: '2024-01-01',
      process: { pid: 101, group: 101, identity: 'Mon Jan 1 00:00:00 2024' },
    },
  };
  foreign = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a boot that exits zero without healthy runtime retains the restart marker', async () => {
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  unhealthyBoot = true;
  // Clock is controlled; use a health failure to end polling deterministically.
  const prior = clock;
  mock.method(Date, 'now', () => ++clock);
  await assert.rejects(restoreIdleDevServers('slot-a', run.id), /stopped after boot/);
  assert.ok(clock > prior);
  assert.deepEqual(row.idle_devservers, ['server']);
  assert.equal(boots, 1);
  mock.method(Date, 'now', () => clock);
});

test('busy transitions skip cleanup so successive poll ticks complete before the transition', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transition = withRunTransitionWhileMachineHeld(run.id, async () => {
    enter();
    await held;
  });
  await entered;
  try {
    await reapIdleDevServers('slot-a');
    clock += DEVSERVER_IDLE_LIMIT_MS;
    await reapIdleDevServers('slot-a');
    assert.equal(lookups, 0);
    assert.equal(stops, 0);
  } finally {
    release();
    await transition;
  }
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
});

for (const live of [false, true]) {
  test(`closed history only protects a genuinely surviving worker, live=${live}`, async () => {
    closedHistory = true;
    unrecordedWorker = live;
    await reapIdleDevServers('slot-a');
    clock += DEVSERVER_IDLE_LIMIT_MS;
    await reapIdleDevServers('slot-a');
    assert.equal(stops, live ? 0 : 1);
  });
}

test('WARM reservation carries the capped server through the actual claim and retained delivery', async () => {
  await reapIdleDevServers(vars.slotId);
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers(vars.slotId);
  assert.equal(alive, false);
  await writeFile(realState.statusFile, JSON.stringify({ slots: [{ ...row, slot: vars.slotId }] }));
  realStatus = true;
  const { commitSlotClaim } = await import('../run-engine/find-slot-step.js');
  await commitSlotClaim(
    vars.slotId,
    'follow-up',
    0,
    'working',
    'working',
    {
      takeoverLiveOwner: true,
    },
    {
      runLookup: (id) => ({ status: id === 'follow-up' ? 'slot-finding' : 'paused' }),
    },
  );
  const reserved = await realState.readSlotRow(vars.slotId);
  assert.equal(reserved?.current_run_id, run.id);
  assert.equal(reserved?.handoff_run_id, 'follow-up');
  assert.equal(reserved?.slot_epoch, epoch + 1);
  assert.equal(reserved?.idle_devserver_epoch, epoch + 1);
  const { deliverPromptWithRetainedFallback } = await import('../runners/session-reactivation.js');
  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: '%7',
    runnerId: 'cursor',
    prompt: 'Read the follow-up task',
    launchAckSignalPath: '/fixture/follow-up/SIGNAL.json',
    onPromptMutationStart: () => {
      assert.equal(boots, 1);
      assert.equal(alive, true);
    },
  });
  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  assert.equal(promptDelivered, true);
  assert.equal(boots, 1);
  const restored = await realState.readSlotRow(vars.slotId);
  assert.equal(restored?.idle_devservers, null);
  assert.equal(restored?.handoff_run_id, 'follow-up');
});
