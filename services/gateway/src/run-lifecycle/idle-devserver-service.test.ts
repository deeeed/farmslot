import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, mock, test } from 'node:test';

import type { ActiveResourcePointer, Run, SlotResource } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { TMUX_FIELD_SEPARATOR } from '../core/tmux-fields.js';
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
let pidFileWatch = false;
let pidFileAge = 60;
let pidFilePort: string | undefined = '{{port}}';
let listenerGroup = '101';
let closedHistory = false;
let realStatus = false;
let promptDelivered = false;
let slotRunsGone = false;
let identityReads = 0;
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
      watch: pidFileWatch
        ? { type: 'pid-file', path: '{{runtime_dir}}/next-dev.pid', port: pidFilePort }
        : { type: 'port-listen', port: '{{port}}' },
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
  if (command.startsWith("f='/fixture/.agent/next-dev.pid'")) {
    // The PID file stays through a stop; the recorded process is 2 minutes old.
    if (!alive) return { stdout: '', stderr: '', exitCode: 3 };
    return {
      stdout: `101 ${pidFileAge} 02:00 Mon Jan 1 00:00:${foreign ? '02' : '00'} 2024\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (command.startsWith('for p in $(lsof -nP -iTCP:9001 -sTCP:LISTEN -t')) {
    return { stdout: alive ? `${listenerGroup}\n` : '', stderr: '', exitCode: 0 };
  }
  if (command.startsWith('lsof -a'))
    return { stdout: `p101\nn${foreign ? '/foreign' : '/fixture'}\n`, stderr: '', exitCode: 0 };
  if (command === "cat '/fixture/.agent/preflight.identity' 2>/dev/null; true") {
    identityReads++;
    return { stdout: '500\t501\tscope-a\n', stderr: '', exitCode: 0 };
  }
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
          ? `fixture-session${TMUX_FIELD_SEPARATOR}%7${TMUX_FIELD_SEPARATOR}201${TMUX_FIELD_SEPARATOR}${outsideRepo ? '/other-workspace' : '/fixture'}${TMUX_FIELD_SEPARATOR}/fixture\n`
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
function fixtureRuns() {
  if (slotRunsGone) return [];
  return [
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
  ];
}
const realRuns = await import('../runs/store.js');
const scopeReaps: string[] = [];
const scopeReapScopes: Array<string | undefined> = [];
const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    reapSlotPrepareScope: async (
      _vars: unknown,
      options: { identityPath?: string; expectedScope?: string },
    ) => {
      scopeReaps.push(options.identityPath ?? '');
      scopeReapScopes.push(options.expectedScope);
      return true;
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...realRuns,
    listRuns: (filter?: { limit?: number }) => ({
      runs: pagedOwner && (filter?.limit ?? 500) <= 500 ? [] : fixtureRuns(),
    }),
    getAllRuns: () => fixtureRuns(),
  },
});
const { withRunTransitionWhileMachineHeld } = await import('./transition-coordinator.js');
const { reapIdleDevServers, restoreIdleDevServers } = await import('./idle-devserver-service.js');
mock.method(Date, 'now', () => clock);
const { DEVSERVER_IDLE_LIMIT_MS, WARM_DEVSERVER_IDLE_LIMIT_MS } =
  await import('./idle-devserver.js');

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
  pidFileWatch = false;
  pidFileAge = 60;
  pidFilePort = '{{port}}';
  listenerGroup = '101';
  scopeReaps.length = 0;
  scopeReapScopes.length = 0;
  slotRunsGone = false;
  identityReads = 0;
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
  assert.deepEqual(scopeReaps, [], "a run's own preflight scope is its release's to stop");
  await restoreIdleDevServers('slot-a', run.id);
  assert.equal(boots, 1);
  assert.equal(alive, true);
});

// macpro-mmt-2/mmt-5: after a gateway restart a pid-file dev server has no cached pointer,
// so it was never reaped and outlived its runs by days.
test('a pid-file dev server with no cached pointer is still reaped after the idle limit', async () => {
  pidFileWatch = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
  assert.equal(alive, false);
});

test('a pid-file dev server on an ownerless ready slot is reaped', async () => {
  pidFileWatch = true;
  row = { current_run_id: null, slot_epoch: epoch, lifecycle: 'ready' };
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  // mini-mmt-3: no run owns the slot, so the preflight scope that kept the server goes too.
  assert.deepEqual(scopeReaps, ['/fixture/.agent/preflight.identity']);
  assert.equal(stops, 1);
});

// mini-mmt-3: a run-less prepare scope outlives its dev server, which the cap no longer sees.
test('a run-less prepare scope whose dev server already died stops after the idle window', async () => {
  alive = false;
  slotRunsGone = true;
  row = { current_run_id: null, slot_epoch: epoch, lifecycle: 'ready' };
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS - 1;
  await reapIdleDevServers('slot-a');
  assert.deepEqual(scopeReaps, [], 'kept inside the idle window');
  clock += 1;
  await reapIdleDevServers('slot-a');
  assert.deepEqual(scopeReaps, ['/fixture/.agent/preflight.identity']);
  assert.deepEqual(scopeReapScopes, ['scope-a'], 'fenced to the scope that was timed');
  assert.equal(stops, 0);
});

test('a keep-warm run-less prepare scope gets the warm window', async () => {
  alive = false;
  slotRunsGone = true;
  row = { current_run_id: null, slot_epoch: epoch, lifecycle: 'ready', warm: true };
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.deepEqual(scopeReaps, [], 'kept past the plain idle limit');
  clock += WARM_DEVSERVER_IDLE_LIMIT_MS - DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.deepEqual(scopeReaps, ['/fixture/.agent/preflight.identity']);
});

test("an owned slot's prepare scope is never read by the cap", async () => {
  alive = false;
  slotRunsGone = true; // the owner alone keeps it, not a listed run
  await reapIdleDevServers('slot-a');
  clock += WARM_DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(identityReads, 0);
  assert.deepEqual(scopeReaps, []);
});

test('a PID file older than the process it names grants no stop authority', async () => {
  // The recorded PID was reused by a process started after the stale file was written.
  pidFileWatch = true;
  pidFileAge = 3 * 24 * 60 * 60;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a watcher-cached PID with a stale PID file grants no stop authority', async () => {
  // After a restart the node watcher rebuilds the cache from the PID file and liveness alone.
  pidFileWatch = true;
  pidFileAge = 3 * 24 * 60 * 60;
  pointer = { pid: 101 } as ActiveResourcePointer;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a capped pid-file dev server resumes through boot', async () => {
  pidFileWatch = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
  await restoreIdleDevServers('slot-a', run.id);
  assert.equal(boots, 1);
  assert.equal(alive, true);
});

test('the PID-file probe runs on this host and rejects a file older than its process', async (t) => {
  const { pidFileProbeCommand, parsePidFileProbe } = await import('./idle-devserver-service.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'idle-devserver-pid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'next-dev.pid');
  await writeFile(file, `${process.pid}\n`);
  const probe = () => {
    const result = spawnSync('bash', ['-c', pidFileProbeCommand(file)], { encoding: 'utf8' });
    assert.ok(result.status === 0 || result.status === 3, result.stderr);
    return result.status === 0 ? result.stdout : '';
  };
  assert.equal(parsePidFileProbe(probe())?.pid, process.pid);
  await writeFile(file, `12\n34\n`);
  assert.equal(parsePidFileProbe(probe()), undefined, 'one decimal PID per file');
  await writeFile(file, '12 34\n');
  assert.equal(parsePidFileProbe(probe()), undefined, 'no whitespace inside the PID');
  await writeFile(file, `  ${process.pid}  \n`);
  assert.equal(parsePidFileProbe(probe())?.pid, process.pid, 'surrounding whitespace is fine');
  await writeFile(file, `${process.pid}\n`);
  const stale = new Date('2020-01-01T00:00:00Z'); // Date.now is mocked in this file.
  await utimes(file, stale, stale);
  assert.equal(parsePidFileProbe(probe()), undefined);
});

test('a pid-file watch that declares no port grants no stop authority after a restart', async () => {
  pidFileWatch = true;
  pidFilePort = undefined;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a watcher-cached PID for a pid-file watch without a port keeps its existing cleanup', async () => {
  // Extension's webpack watcher declares no port; its cached PID still qualifies by checkout cwd.
  pidFileWatch = true;
  pidFilePort = undefined;
  pointer = { pid: 101 } as ActiveResourcePointer;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 1);
});

test('a recorded PID whose group does not hold the declared listener is preserved', async () => {
  // A harness can rewrite the PID file with a reused PID; the listener stays elsewhere.
  pidFileWatch = true;
  listenerGroup = '555';
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('a pid-file dev server outside the checkout is preserved', async () => {
  pidFileWatch = true;
  foreign = true;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  assert.equal(stops, 0);
});

test('the cap logs one structured line per changed decision', async (t) => {
  const lines: string[] = [];
  const info = t.mock.method(console, 'info', (line: unknown) => {
    if (String(line).startsWith('[idle-devserver] slot=slot-a resource=server '))
      lines.push(String(line));
  });
  await reapIdleDevServers('slot-a');
  clock++;
  await reapIdleDevServers('slot-a');
  clock += DEVSERVER_IDLE_LIMIT_MS;
  await reapIdleDevServers('slot-a');
  info.mock.restore();
  assert.equal(stops, 1);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(
    lines[0]!,
    /^\[idle-devserver\] slot=slot-a resource=server decision=idle: pid 101 stops after /,
  );
  assert.equal(
    lines[1],
    '[idle-devserver] slot=slot-a resource=server decision=stopped pid 101 after the idle limit',
  );
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
  // Cursor takes the handoff by respawning with the prompt in argv, so the session is new.
  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    runnerReplaced: true,
  });
  assert.equal(promptDelivered, true);
  assert.equal(boots, 1);
  const restored = await realState.readSlotRow(vars.slotId);
  assert.equal(restored?.idle_devservers, null);
  assert.equal(restored?.handoff_run_id, 'follow-up');
});

test('ps etime parses into seconds', async () => {
  const { elapsedSeconds } = await import('./idle-devserver-service.js');
  assert.equal(elapsedSeconds('02:00'), 120);
  assert.equal(elapsedSeconds('01:02:03'), 3723);
  assert.equal(elapsedSeconds('2-14:35:18'), 2 * 86400 + 14 * 3600 + 35 * 60 + 18);
  assert.equal(elapsedSeconds('bogus'), undefined);
});
