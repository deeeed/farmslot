import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { cancelledRunHoldReason, type Run } from '@farmslot/protocol';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the slot row, project vars, exec layer, worker stop, run store,
// capability ownership release and transcript archive are faked. The fake exec models the prepare identity file
// and the process group the holder lives in. The task watcher stays real: its
// import graph reaches slot-teardown, which would then load before the mocks apply.
import * as realCore from '../core/index.js';
import * as realTmux from '../core/tmux.js';
import * as realOwnedStop from '../runners/owned-stop.js';
import * as realSessionArchive from '../runners/session-archive.js';
import type { RunnerDescendantPidProbe } from '../runners/session-process.js';
import * as realSessionProcess from '../runners/session-process.js';
import * as realRunStore from '../runs/store.js';

const RUN_ID = 'run-cancelled';
const SLOT_ID = 'macpro-mm-pixel6';
const IDENTITY = '/slot/.agent/preflight.identity';
const SCOPE = 'a'.repeat(32);

let slotRow: Record<string, unknown> | null;
let slotWrites: Record<string, unknown>[];
let commands: string[];
/** Scope in the identity file, null once a reap removed it. */
let recordedScope: string | null;
/** The preflight group (and its farmslot-prepare-scope holder) is running. */
let holderAlive: boolean;
/** The group ignores SIGKILL too, so the reap reports it and keeps the identity. */
let holderSurvives: boolean;
/** Runs when the canceller reads the recorded scope, before its ownership re-check. */
let onIdentityRead: (() => void) | null;
let otherRuns: Run[];
let archived: number;
let liveRun: boolean;
let workerBlocker: string | null;
let providerCleanups: number;
let workspaceHelperAlive = false;
let rawProcessCensus: string | null = null;
let cwdProcessCensus: string | null = null;
let tmuxInventory = '';
let runnerProbe: RunnerDescendantPidProbe = { state: 'absent' };
let runUpdates: Partial<Run>[] = [];
let slotAgentKills: string[] = [];
let slotAgentKillError: Error | null = null;

/** A process on the slot machine, for the browser session a run leaves behind. */
interface SlotProcess {
  pid: number;
  ppid: number;
  pgid: number;
  args: string;
  cwd: string;
  onCdpPort?: boolean;
  /** Ignores SIGKILL, so the reap must name it. */
  survives?: boolean;
  alive: boolean;
}
const STARTED = 'Sun Oct 18 08:48:13 2026';
let slotProcesses: SlotProcess[] = [];
let leases: Array<Record<string, unknown>> = [];
/** The gateway's watched resource processes on the slot (resourceId -> pid). */
let activeResources = new Map<string, { pid: number }>();

function browserSessionCensus() {
  const live = slotProcesses.filter((proc) => proc.alive);
  const onPort = live.filter((proc) => proc.onCdpPort).map((proc) => proc.pid);
  return [
    ...live.map((proc) => `${proc.pid} ${proc.ppid} ${proc.pgid} ${STARTED} ${proc.args}`),
    '--repo-- /slot',
    `--cdp-- ${onPort.join(',')}`,
    ...live.filter((proc) => onPort.includes(proc.pid)).flatMap((p) => [`p${p.pid}`, `n${p.cwd}`]),
    '',
  ].join('\n');
}

function reapBrowserSession(cmd: string) {
  const targets = /targets='([^']*)'/.exec(cmd)?.[1] ?? '';
  const survivors: number[] = [];
  for (const line of targets.split('\n')) {
    const [pid, , identity] = line.split('|');
    const proc = slotProcesses.find((candidate) => candidate.pid === Number(pid));
    if (!proc?.alive || identity !== STARTED) continue;
    if (proc.survives) survivors.push(proc.pid);
    else proc.alive = false;
  }
  return survivors.map((pid) => `survivor ${pid}\n`).join('');
}

function reapIdentity(cmd: string) {
  const expected = /if \[ "\$scope" != '([0-9a-f]+)' \]/.exec(cmd)?.[1];
  if (recordedScope && expected && expected !== recordedScope)
    return { stdout: '', stderr: '', exitCode: 0 }; // A foreign scope is left alone.
  if (recordedScope && holderAlive && holderSurvives)
    return { stdout: '', stderr: 'preflight group 4242 survived SIGKILL\n', exitCode: 1 };
  const killed = recordedScope !== null && holderAlive;
  if (killed) holderAlive = false;
  recordedScope = null;
  return {
    stdout: killed ? 'killed verified preflight group (4242)\n' : '',
    stderr: '',
    exitCode: 0,
  };
}

mock.module('../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({
      slotId: SLOT_ID,
      remoteRepo: '/slot',
      host: 'localhost',
      projectName: 'mm',
      session: 'mmt-1',
      resourceVars: { cdp_port: '9542' },
    }),
    loadProjectVars: async () => ({ runtimeDir: '.agent' }),
    readSlotRow: async () => slotRow,
    markSlotStatusIf: async (
      _id: string,
      predicate: (row: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (!slotRow || !predicate(slotRow)) return { applied: false };
      slotWrites.push(fields);
      slotRow = { ...slotRow, ...fields };
      return { applied: true };
    },
    resetSlotIf: async (_id: string, predicate: (row: Record<string, unknown>) => boolean) => {
      if (!slotRow || !predicate(slotRow)) return false;
      slotRow = {
        ...slotRow,
        lifecycle: 'ready',
        phase: null,
        current_run_id: null,
        cleanup_run_id: null,
        held_reason: null,
      };
      slotWrites.push(slotRow);
      return true;
    },
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (!slotRow || !predicate(slotRow)) return false;
      slotWrites.push(fields);
      slotRow = { ...slotRow, ...fields };
      return true;
    },
    execOnSlot: async (_vars: unknown, cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith(': farmslot-browser-session-census'))
        return { stdout: browserSessionCensus(), stderr: '', exitCode: 0 };
      if (cmd.startsWith(': farmslot-browser-session-reap'))
        return { stdout: reapBrowserSession(cmd), stderr: '', exitCode: 0 };
      if (cmd.includes('list-panes -a')) return { stdout: tmuxInventory, stderr: '', exitCode: 0 };
      if (cmd.startsWith('lsof -a -d cwd'))
        return {
          stdout:
            cwdProcessCensus ??
            (workspaceHelperAlive
              ? 'p999\nn/slot\n'
              : slotProcesses
                  .filter((proc) => proc.alive)
                  .map((proc) => `p${proc.pid}\nn${proc.cwd}\n`)
                  .join('')),
          stderr: '',
          exitCode: 0,
        };
      if (cmd.startsWith('ps -axo'))
        return {
          stdout:
            rawProcessCensus ??
            (workspaceHelperAlive
              ? '999 1 999 Fri Oct 9 01:00:00 2026 node\n'
              : slotProcesses
                  .filter((proc) => proc.alive)
                  .map((proc) => `${proc.pid} ${proc.ppid} ${proc.pgid} ${STARTED} node\n`)
                  .join('')),
          stderr: '',
          exitCode: 0,
        };
      if (cmd.startsWith(`cat '${IDENTITY}'`)) {
        onIdentityRead?.();
        return {
          stdout: recordedScope ? `4242\t4243\t${recordedScope}\n` : '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes(`identityfile='${IDENTITY}'`)) return reapIdentity(cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mmt-1' },
});
mock.module('../runners/session-process.js', {
  namedExports: { ...realSessionProcess, probeRunnerDescendantPid: async () => runnerProbe },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    listRuns: () => ({ runs: otherRuns }),
    getRun: (id: string) => (liveRun && id === RUN_ID ? run : undefined),
    getRunWithArchived: async (id: string) => (id === RUN_ID ? run : undefined),
    updateRun: (_id: string, patch: Partial<Run>) => {
      runUpdates.push(patch);
      return { ...run, ...patch };
    },
  },
});
mock.module('../runners/owned-stop.js', {
  namedExports: { ...realOwnedStop, stopRunOwnedTmuxWorkers: async () => workerBlocker },
});
mock.module('../runners/session-archive.js', {
  namedExports: {
    ...realSessionArchive,
    archiveRunnerSessionsForSlotRelease: async () => {
      archived += 1;
      return { summary: 'none' };
    },
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
const realSlotIO = await import('../core/slot-io.js');
mock.module('../core/slot-io.js', {
  namedExports: { ...realSlotIO, slotRealpath: async (_vars: unknown, file: string) => file },
});
const realPosture = await import('../methods/runtime-posture.js');
mock.module('../methods/runtime-posture.js', {
  namedExports: {
    ...realPosture,
    getRunResourcePostureReconciler: () => ({
      apply: async () => {
        providerCleanups += 1;
        workspaceHelperAlive = false;
        return { ok: true, transition: { failures: [] } };
      },
    }),
  },
});
// Loaded only after the mocks above, so its graph sees them; teardown imports
// it lazily, so the override below is what releaseRunOwnedCapabilities gets.
const realRuntimeCapabilities = await import('../methods/runtime-capabilities.js');
mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    ...realRuntimeCapabilities,
    getRuntimeCapabilityRegistry: () => ({
      settledStatus: async () => ({
        catalog: [],
        leases,
      }),
      releaseRunTerminal: async () => {
        providerCleanups += 1;
        workspaceHelperAlive = false;
        return { ok: true, failures: [] };
      },
    }),
  },
});

const realResourceManager = await import('../fleet/resource-manager.js');
mock.module('../fleet/resource-manager.js', {
  namedExports: { ...realResourceManager, getActiveResources: () => activeResources },
});

const realRelease = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: {
    ...realRelease,
    killSlotAgents: async (slotId: string) => {
      slotAgentKills.push(slotId);
      if (slotAgentKillError) throw slotAgentKillError;
    },
  },
});

const { slotTeardownBlocker, stopRunOwnedTmuxAndWatches, retryOccupiedRunSlot } =
  await import('./slot-teardown.js');
const { replaySlotReclaimCheck } = await import('../methods/run/replay-step.js');
const { defaultCancelCollaborators } = await import('./cancel-transition.js');
const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');

const run = {
  id: RUN_ID,
  slotId: SLOT_ID,
  status: 'cancelled',
  agentContexts: [],
} as unknown as Run;
const reaps = () => commands.filter((cmd) => cmd.includes(`identityfile='${IDENTITY}'`));

beforeEach(() => {
  run.status = 'cancelled';
  run.steps = [];
  slotRow = { current_run_id: RUN_ID, slot_epoch: 1 };
  slotWrites = [];
  commands = [];
  recordedScope = SCOPE;
  holderAlive = true;
  holderSurvives = false;
  onIdentityRead = null;
  otherRuns = [];
  archived = 0;
  liveRun = true;
  workerBlocker = null;
  providerCleanups = 0;
  workspaceHelperAlive = false;
  rawProcessCensus = null;
  cwdProcessCensus = null;
  tmuxInventory = '';
  runnerProbe = { state: 'absent' };
  slotProcesses = [];
  leases = [];
  activeResources = new Map();
  runUpdates = [];
  slotAgentKills = [];
  slotAgentKillError = null;
});

test('cancel during or after prepare stops the run prepare-scope holder', async () => {
  // Both shapes leave the nohup'd holder behind: a kept-alive preflight window
  // outlives prepare, and an aborted window's descendant cleanup skips the holder.
  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.equal(reaps().length, 1, 'release must reap the recorded prepare scope');
  assert.equal(holderAlive, false);
  assert.match(reaps()[0]!, new RegExp(`!= '${SCOPE}'`), 'the reap is fenced to the read scope');
  assert.match(reaps()[0]!, /kill -KILL -"\$pgid"/, 'the reap waits out and escalates');
  assert.equal(archived, 1);
});

test('releasing twice is a no-op the second time', async () => {
  await stopRunOwnedTmuxAndWatches(run);
  commands = [];

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);
  assert.equal(reaps().length, 0, 'nothing is recorded, so nothing is signalled');
});

test('a slot another run now owns keeps its prepare scope', async () => {
  slotRow = { current_run_id: 'successor', slot_epoch: 2 };

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(reaps().length, 0);
  assert.equal(holderAlive, true);
});

test('a slot reserved by another run handoff keeps its prepare scope', async () => {
  slotRow = { current_run_id: RUN_ID, slot_epoch: 1, handoff_run_id: 'successor' };

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(reaps().length, 0);
  assert.equal(holderAlive, true);
});

test('a slot another active run shares keeps its prepare scope', async () => {
  // Two active runs on one slot: the recorded preflight may be the other run's.
  otherRuns = [{ id: 'sibling', slotId: SLOT_ID, status: 'running' } as unknown as Run];

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(reaps().length, 0);
  assert.equal(holderAlive, true);
});

test('a successor that claims the slot while the scope is read keeps its prepare', async () => {
  // Release and redispatch race the cancel: the claim lands after the snapshot.
  onIdentityRead = () => {
    slotRow = { current_run_id: 'successor', slot_epoch: 2 };
  };

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(reaps().length, 0);
  assert.equal(holderAlive, true);
});

test('a scope replaced after the ownership check is not signalled', async () => {
  onIdentityRead = () => {
    queueMicrotask(() => {
      recordedScope = 'b'.repeat(32);
    });
  };

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(reaps().length, 1);
  assert.equal(holderAlive, true, 'the reap only matches the scope that was read');
  assert.equal(recordedScope, 'b'.repeat(32), 'the successor identity stays recorded');
});

test('a completed run whose holder survives keeps the slot held with the reason', async () => {
  holderSurvives = true;

  const result = await releaseCompletedRunSlot(run);

  assert.equal(result.released, false);
  assert.match(result.skipped ?? '', /Prepare scope cleanup failed: preflight group 4242 survived/);
  const held = slotWrites.at(-1);
  assert.equal(held?.lifecycle, 'held');
  assert.equal(held?.phase, 'occupied');
  assert.match(String(held?.held_reason), /Prepare scope cleanup failed/);
  assert.equal(archived, 1, 'the transcript archive still runs');
  assert.equal(recordedScope, SCOPE, 'the identity is kept for a retry');
});

test('terminal cleanup releases providers independently of a surviving worker hold', async () => {
  workerBlocker = 'Worker primary pane ownership changed; cleanup deferred';
  const result = await releaseCompletedRunSlot(run);
  assert.equal(result.released, false);
  assert.equal(providerCleanups, 1);
  assert.equal(slotRow?.current_run_id, null);
  assert.equal(slotRow?.cleanup_run_id, RUN_ID);
  assert.equal(slotRow?.phase, 'occupied');
});

// A cancelled run keeps only the slot it still owns for replay; a cleanup hold
// that names it only as cleanup owner is retried like any terminal run's.
for (const status of ['failed', 'cancelled'] as const) {
  test(`an identified ${status} cleanup hold is freed after its worker disappears`, async () => {
    run.status = status;
    workerBlocker = 'worker still alive';
    await releaseCompletedRunSlot(run);
    assert.equal(
      slotRow?.current_run_id ?? null,
      null,
      'the hold names the run only as cleanup owner',
    );
    assert.equal(slotRow?.cleanup_run_id, RUN_ID);
    workerBlocker = null;
    assert.equal(await retryOccupiedRunSlot(SLOT_ID), true);
    assert.equal(slotRow?.lifecycle, 'ready');
    assert.equal(slotRow?.cleanup_run_id, null);
  });
}

for (const name of ['complete', 'finalize']) {
  test(`an occupied ${name} prerequisite hold retains its workspace and providers`, async () => {
    run.status = 'failed';
    run.steps = [
      { name, status: 'failed', outputs: { gatePrerequisiteRefusal: { kind: 'evidence' } } },
    ];
    for (const owner of [
      { current_run_id: RUN_ID },
      { current_run_id: null, cleanup_run_id: RUN_ID },
    ]) {
      slotRow = {
        ...owner,
        slot_epoch: 4,
        lifecycle: 'held',
        phase: 'occupied',
        held_reason: 'recipe closeout unconfirmed',
      };
      const before = structuredClone(slotRow);
      assert.equal(await retryOccupiedRunSlot(SLOT_ID), false);
      assert.deepEqual(slotRow, before);
      assert.equal(providerCleanups, 0);
      assert.equal(archived, 0);
      assert.deepEqual(commands, []);
      assert.deepEqual(slotWrites, []);
      assert.equal(holderAlive, true);
      assert.equal(recordedScope, SCOPE);
    }
  });
}

test('an archived terminal owner can finish an identified hold without changing its record', async () => {
  run.status = 'failed';
  slotRow = {
    current_run_id: null,
    cleanup_run_id: RUN_ID,
    slot_epoch: 4,
    lifecycle: 'held',
    phase: 'occupied',
  };
  liveRun = false;
  assert.equal(await retryOccupiedRunSlot(SLOT_ID), true);
  assert.equal(providerCleanups, 1);
  assert.equal(slotRow?.lifecycle, 'ready');
});

test('a surviving worker keeps the identified hold across reconciliation', async () => {
  workerBlocker = 'worker still alive';
  await releaseCompletedRunSlot(run);
  assert.equal(await retryOccupiedRunSlot(SLOT_ID), false);
  assert.equal(slotRow?.phase, 'occupied');
  assert.equal(slotRow?.held_reason, workerBlocker);
});

test('an unidentified hold and a successor claim grant no terminal cleanup authority', async () => {
  for (const row of [
    { current_run_id: null },
    { current_run_id: 'successor', cleanup_run_id: RUN_ID },
  ]) {
    slotRow = { ...row, slot_epoch: 5, lifecycle: 'held', phase: 'occupied' };
    assert.equal(await retryOccupiedRunSlot(SLOT_ID), false);
  }
  assert.equal(providerCleanups, 0);
  assert.equal(slotWrites.length, 0);
});

test('a successor claiming during a retry preserves its owner and epoch', async () => {
  run.status = 'failed';
  slotRow = {
    current_run_id: null,
    cleanup_run_id: RUN_ID,
    slot_epoch: 4,
    lifecycle: 'held',
    phase: 'occupied',
  };
  onIdentityRead = () => {
    slotRow = { current_run_id: 'successor', slot_epoch: 5, lifecycle: 'busy', phase: 'working' };
  };
  const result = await retryOccupiedRunSlot(SLOT_ID);
  assert.equal(result, false);
  assert.equal(slotRow?.current_run_id, 'successor');
  assert.equal(slotRow?.slot_epoch, 5);
});

test('terminal provider shutdown precedes the workspace occupancy census', async () => {
  workspaceHelperAlive = true;
  const result = await releaseCompletedRunSlot(run);
  assert.equal(result.released, true);
  assert.equal(workspaceHelperAlive, false);
  assert.equal(providerCleanups, 1);
  assert.equal(slotRow?.lifecycle, 'ready');
});

test('an unreadable live process identity cannot masquerade as an exited occupant', async () => {
  cwdProcessCensus = 'p999\nn/slot\n';
  rawProcessCensus = '999 unreadable identity\n';
  assert.match((await slotTeardownBlocker(run)) ?? '', /Process 999 still uses/);
  rawProcessCensus = '';
  assert.match((await slotTeardownBlocker(run)) ?? '', /identity census is unreadable/);
  rawProcessCensus = '1000 1 1000 Fri Oct 9 01:00:00 2026 node\n';
  assert.equal(await slotTeardownBlocker(run), null, 'the original occupant is verifiably gone');
});

test('a reused configured slot session accepts its unrecorded idle shell', async () => {
  tmuxInventory = 'mmt-1\t%3\t111\t/slot\t/slot\t$2\t1791363049\n';
  rawProcessCensus = '111 1 111 Fri Oct 9 01:00:00 2026 /bin/zsh\n';
  cwdProcessCensus = 'p111\nn/slot\n';
  assert.equal(await slotTeardownBlocker(run), null);
});

test('a foreign controller and a different session origin remain protected', async () => {
  tmuxInventory = 'xreview-controller\t%3\t111\t/slot\t/slot\t$2\t1791363049\n';
  assert.match((await slotTeardownBlocker(run)) ?? '', /without verified slot ownership/);
  tmuxInventory = 'mmt-1\t%3\t111\t/slot\t/operator\t$2\t1791363049\n';
  assert.match((await slotTeardownBlocker(run)) ?? '', /started outside this slot checkout/);
  tmuxInventory = 'mmt-1\t%3\t111\t/slot\t/slot\t\t\n';
  assert.match((await slotTeardownBlocker(run)) ?? '', /without verified slot ownership/);
});

test('a live unrecorded runner in the reused slot session stays protected', async () => {
  tmuxInventory = 'mmt-1\t%3\t111\t/slot\t/slot\t$2\t1791363049\n';
  runnerProbe = { state: 'present', pid: '222' };
  assert.match((await slotTeardownBlocker(run)) ?? '', /is not quiescent/);
});

test('a non-runner child in an unrecorded slot pane still blocks cleanup', async () => {
  tmuxInventory = 'mmt-1\t%3\t111\t/slot\t/slot\t$2\t1791363049\n';
  rawProcessCensus =
    '111 1 111 Fri Oct 9 01:00:00 2026 /bin/zsh\n222 111 111 Fri Oct 9 01:00:00 2026 node\n';
  cwdProcessCensus = 'p111\nn/slot\np222\nn/slot\n';
  assert.match((await slotTeardownBlocker(run)) ?? '', /pane process 111 is still occupied/);
});

/** Run 22e62daa's macpro-mmt-2 after cancel: the browser session its worker's recipe calls started. */
function leftBrowserSession(): SlotProcess[] {
  const harness = '/home/.farmslot-dev/task-pins/855904b4/inputs/1/metamask-harness';
  const runtime = '/slot/temp/recipe/runtime/terminal';
  return [
    {
      pid: 11425,
      ppid: 1,
      pgid: 11425,
      cwd: '/slot',
      onCdpPort: true,
      args: `node ${harness}/adapters/extension/console-tail.mjs --cdp-port 9542 --extension-log ${runtime}/extension-console.log`,
      alive: true,
    },
    {
      pid: 22867,
      ppid: 1,
      pgid: 22867,
      cwd: '/',
      onCdpPort: true,
      args: `node ${harness}/node_modules/@farmslot/adapter-web/src/web-dapp/wallet-host.mjs --cdp-port 9542 --runtime-dir ${runtime} --target /slot`,
      alive: true,
    },
    {
      pid: 20419,
      ppid: 1,
      pgid: 20419,
      cwd: '/',
      onCdpPort: true,
      args: `/home/chrome/Google Chrome for Testing --remote-debugging-port=9542 --user-data-dir=${runtime}/browser-profile`,
      alive: true,
    },
    {
      pid: 20430,
      ppid: 20419,
      pgid: 20419,
      cwd: '/',
      args: '/home/chrome/Google Chrome for Testing Helper (Renderer) --type=renderer',
      alive: true,
    },
    // Not this run's: a person's Chrome attached to the port, a tool for another
    // checkout, and the slot's dev server, which is not on the CDP port.
    {
      pid: 30001,
      ppid: 1,
      pgid: 30001,
      cwd: '/',
      onCdpPort: true,
      args: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      alive: true,
    },
    {
      pid: 30002,
      ppid: 1,
      pgid: 30002,
      cwd: '/',
      onCdpPort: true,
      args: 'node /slot-2/tool.mjs --cdp-port 9542 --target /slot-2',
      alive: true,
    },
    // The slot's dev server, which dispatch needs, runs in the checkout.
    {
      pid: 40000,
      ppid: 1,
      pgid: 40000,
      cwd: '/slot',
      args: 'node /slot/node_modules/.bin/next dev -p 9342',
      alive: true,
    },
    {
      pid: 40001,
      ppid: 40000,
      pgid: 40000,
      cwd: '/slot',
      args: 'next-server (v15)',
      alive: true,
    },
    // Still attached to a live parent (a worker pane), and a tmux server.
    {
      pid: 50001,
      ppid: 5000,
      pgid: 5000,
      cwd: '/slot',
      onCdpPort: true,
      args: 'node /slot/scripts/probe.mjs --cdp-port 9542',
      alive: true,
    },
    {
      pid: 60001,
      ppid: 1,
      pgid: 60001,
      cwd: '/slot',
      args: 'tmux new-session -d -c /slot node probe.mjs --cdp-port 9542',
      alive: true,
    },
  ];
}
const untouched = [30001, 30002, 40000, 40001, 50001, 60001];
const alivePids = () => slotProcesses.filter((proc) => proc.alive).map((proc) => proc.pid);

test("cancel stops the browser session its run left on the slot's CDP port", async () => {
  slotProcesses = leftBrowserSession();
  activeResources = new Map([['dev-server', { pid: 40000 }]]);

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.deepEqual(alivePids(), untouched, 'only the run session was stopped');
  slotProcesses = slotProcesses.filter((proc) => proc.pid !== 50001 && proc.pid !== 60001);
  assert.equal(
    await slotTeardownBlocker(run),
    null,
    'the dev server is a resident, not an occupant',
  );
});

test('a dev server the gateway does not watch still holds the slot', async () => {
  slotProcesses = leftBrowserSession().filter((proc) => proc.pid !== 50001 && proc.pid !== 60001);

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.equal(
    await slotTeardownBlocker(run),
    'Process 40000 still uses the slot repository; slot teardown was skipped',
  );
});

test('a browser session process that survives SIGKILL is named and keeps the slot held', async () => {
  slotProcesses = leftBrowserSession();
  slotProcesses.find((proc) => proc.pid === 20419)!.survives = true;

  const blocker = await stopRunOwnedTmuxAndWatches(run);

  assert.match(
    blocker ?? '',
    /^Browser session process 20419 \(\/home\/chrome\/Google Chrome for Testing --remote-debugging-port=9542 .*\) on CDP port 9542 did not stop$/,
  );
  assert.deepEqual(alivePids(), [20419, ...untouched]);
});

test('while a capability lease holds the slot, its release effect decides', async () => {
  slotProcesses = leftBrowserSession();
  leases = [{ owner: { runId: RUN_ID }, state: 'acquired' }];

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.equal(alivePids().length, slotProcesses.length);
});

test('a process a released lease recorded is never reaped', async () => {
  slotProcesses = leftBrowserSession();
  leases = [
    {
      owner: { runId: RUN_ID },
      state: 'released',
      providerProcesses: [{ pid: 20419, group: 20419, identity: STARTED }],
    },
  ];

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.deepEqual(alivePids(), [20419, 20430, ...untouched]);
});

test('the browser session of a slot another active run uses is left alone', async () => {
  slotProcesses = leftBrowserSession();
  otherRuns = [{ ...run, id: 'run-active', status: 'monitoring' } as Run];

  await stopRunOwnedTmuxAndWatches(run);

  assert.equal(alivePids().length, slotProcesses.length);
});

/** The slot as replay needs it after cancel: still the run's, held, checkout untouched. */
function assertKeptForReplay() {
  assert.equal(slotRow?.lifecycle, 'held');
  assert.equal(slotRow?.phase, 'occupied');
  assert.equal(slotRow?.current_run_id, RUN_ID);
  assert.equal(slotRow?.held_reason, cancelledRunHoldReason(RUN_ID));
  assert.equal(replaySlotReclaimCheck(slotRow!, RUN_ID).ok, true, 'run.replayStep reclaims it');
  assert.deepEqual(
    commands.filter((cmd) => /git (reset|clean|checkout)/.test(cmd)),
    [],
    'cancel never touches the checkout',
  );
}

// TAT-4146 run db0b2ef5 on macpro-mmt-1, 10-19 06:47:20Z: the run's own detached harness helper
// was still exiting at cancel, and an editor had the checkout open on Arthur's cancels that day.
test('cancel keeps the slot for replay past its own exiting helper and an editor', async () => {
  slotProcesses = [
    {
      pid: 5054,
      ppid: 1,
      pgid: 5054,
      args: 'node metamask-harness/adapters/extension/console-collector.mjs',
      cwd: '/slot',
      alive: true,
    },
    {
      pid: 44809,
      ppid: 44700,
      pgid: 44700,
      args: 'Cursor Helper (Plugin)',
      cwd: '/slot',
      alive: true,
    },
  ];
  const cancel = defaultCancelCollaborators();

  await cancel.releaseCapabilities(run);
  assert.equal(await cancel.releaseSlot(run), undefined);

  assertKeptForReplay();
  assert.equal(runUpdates.at(-1)?.slotTeardownSkipped, undefined);
  // Automatic reconciliation leaves the kept slot alone.
  assert.equal(await retryOccupiedRunSlot(SLOT_ID), false);
  assertKeptForReplay();
});

// macwork-mmt-3 on Arthur's cancels: the run's own finished worker had no exact pane identity.
test('cancel stops its own worker without a pane identity the way slot.release does', async () => {
  workerBlocker = `Worker dev has no exact pane identity; cleanup deferred. Verify its window, then use farmslot slot release --keep-work ${SLOT_ID}`;
  const cancel = defaultCancelCollaborators();

  await cancel.releaseCapabilities(run);
  assert.equal(await cancel.releaseSlot(run), undefined);

  assert.deepEqual(slotAgentKills, [SLOT_ID]);
  assertKeptForReplay();
  assert.equal(runUpdates.at(-1)?.slotTeardownSkipped, undefined);
});

test('a worker the slot agent kill cannot stop is named, and the slot is kept for replay', async () => {
  workerBlocker = 'Worker dev has no exact pane identity; cleanup deferred';
  slotAgentKillError = new Error('Agent windows in mmt-1 did not close');
  const cancel = defaultCancelCollaborators();

  await cancel.releaseCapabilities(run);
  assert.equal(await cancel.releaseSlot(run), undefined);

  assertKeptForReplay();
  assert.equal(runUpdates.at(-1)?.slotTeardownSkipped, 'Agent windows in mmt-1 did not close');
});

test('a run-owned process that survives cancel is named, and the slot is kept for replay', async () => {
  slotProcesses = leftBrowserSession();
  slotProcesses.find((proc) => proc.pid === 20419)!.survives = true;
  const cancel = defaultCancelCollaborators();

  await cancel.releaseCapabilities(run);
  assert.equal(await cancel.releaseSlot(run), undefined);

  assertKeptForReplay();
  assert.match(
    runUpdates.at(-1)?.slotTeardownSkipped ?? '',
    /^Browser session process 20419 .* did not stop$/,
  );
});

test('another active run on the slot still keeps it on cancel', async () => {
  otherRuns = [{ ...run, id: 'run-active', status: 'monitoring' } as Run];
  workerBlocker = 'Worker dev has no exact pane identity; cleanup deferred';
  const cancel = defaultCancelCollaborators();

  await cancel.releaseCapabilities(run);
  assert.deepEqual(await cancel.releaseSlot(run), {
    skipped: 'Another active run run-active uses this slot',
  });

  assert.deepEqual(slotAgentKills, [], 'the other run keeps its workers');
  assert.equal(slotRow?.lifecycle, 'held');
  assert.equal(
    runUpdates.at(-1)?.slotTeardownSkipped,
    'Another active run run-active uses this slot',
  );
});
