import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

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
      if (cmd.includes('list-panes -a')) return { stdout: tmuxInventory, stderr: '', exitCode: 0 };
      if (cmd.startsWith('lsof -a -d cwd'))
        return {
          stdout: cwdProcessCensus ?? (workspaceHelperAlive ? 'p999\nn/slot\n' : ''),
          stderr: '',
          exitCode: 0,
        };
      if (cmd.startsWith('ps -axo'))
        return {
          stdout:
            rawProcessCensus ??
            (workspaceHelperAlive ? '999 1 999 Fri Oct 9 01:00:00 2026 node\n' : ''),
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
    updateRun: (_id: string, patch: Partial<Run>) => ({ ...run, ...patch }),
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
      settledStatus: async () => ({ catalog: [], leases: [] }),
      releaseRunTerminal: async () => {
        providerCleanups += 1;
        workspaceHelperAlive = false;
        return { ok: true, failures: [] };
      },
    }),
  },
});

const { slotTeardownBlocker, stopRunOwnedTmuxAndWatches, retryOccupiedRunSlot } =
  await import('./slot-teardown.js');
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

test('an identified terminal hold is freed after its worker disappears', async () => {
  workerBlocker = 'worker still alive';
  await releaseCompletedRunSlot(run);
  workerBlocker = null;
  assert.equal(await retryOccupiedRunSlot(SLOT_ID), true);
  assert.equal(slotRow?.lifecycle, 'ready');
  assert.equal(slotRow?.cleanup_run_id, null);
});

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
