import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import {
  cancelledRunHoldReason,
  cancelledRunSlotHold,
  releaseCancelledRunSlot,
} from '@farmslot/protocol';

const runRoot = mkdtempSync(path.join(tmpdir(), 'release-owner-runs-'));
process.env.FARMSLOT_RUNS_DIR = runRoot;
process.env.FARMSLOT_HOME = path.join(runRoot, 'home');
mkdirSync(process.env.FARMSLOT_HOME);
after(() => rmSync(runRoot, { recursive: true, force: true }));

// slotRelease is driven through a faked slot exec layer and slot row: no tmux,
// shell or process is touched. Real namespaces are spread into each mock, and
// each one is loaded only after the mocks before it, so its graph sees them.
const SLOT_ID = 'macpro-mm-1';
const IDENTITY = '/slot/.agent/preflight.identity';

let slotRow: Record<string, unknown>;
let recycleStartsRuntime = false;
let recycledRuntime: ChildProcess | undefined;
let events: string[];
let reapFails: boolean;
let emitted: Array<{ event: string; payload: Record<string, unknown> }>;
let claimBeforeMark = false;
let markerWrites = 0;
let claimDuringPaneProbe = false;
let claimAfterTaskClean = false;
let hasMirrorArtifacts = false;
let copyOptions: Record<string, unknown> | undefined;
let scaffoldingExcludesArtifacts: boolean | undefined;
let copyFailure = false;
let copyTotals: { files: number; bytes: number } | undefined;
let teardownExtensions: number[] = [];
let claimAfterReap = false;
let cdpPort: string | undefined;
/** The browser session a cancelled run left on the slot's CDP port: pid -> survives SIGKILL. */
let browserSession: Map<number, boolean>;
/** Every slot command, to show what a release ran (and that it never asked who uses the checkout). */
let slotCommands: string[];

const STARTED = 'Sun Oct 18 08:48:13 2026';
const BROWSER_ARGS: Record<number, string> = {
  11425:
    'node /pins/console-tail.mjs --cdp-port 9542 --extension-log /slot/temp/runtime/console.log',
  20419:
    'Google Chrome for Testing --remote-debugging-port=9542 --user-data-dir=/slot/temp/profile',
};

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const applies = (
  predicate: (slot: Record<string, unknown>) => boolean,
  fields: Record<string, unknown>,
) => {
  if (!predicate(slotRow)) return false;
  slotRow = { ...slotRow, ...fields };
  return true;
};

const execForTest = async (_vars: unknown, cmd: string) => {
  slotCommands.push(cmd);
  if (cmd === '__proof_runtime__') {
    recycledRuntime = spawn(
      process.execPath,
      ['-e', 'require("node:fs").watch(process.argv[1], () => {})', runRoot],
      { stdio: 'ignore' },
    );
    await once(recycledRuntime, 'spawn');
    return ok();
  }
  // An editor with the checkout open (macwork-mmt-1, Cursor 44809, 10-19).
  if (cmd.startsWith('lsof -a -d cwd')) return ok('p44809\nn/slot\n');
  if (cmd.includes('git rev-parse HEAD 2>/dev/null')) return ok('5d0c1a7e\n2\n');
  if (cmd.startsWith(': farmslot-browser-session-census')) {
    const pids = [...browserSession.keys()];
    return ok(
      [
        ...pids.map((pid) => `${pid} 1 ${pid} ${STARTED} ${BROWSER_ARGS[pid]}`),
        '--repo-- /slot',
        `--cdp-- ${pids.join(',')}`,
        '',
      ].join('\n'),
    );
  }
  if (cmd.startsWith(': farmslot-browser-session-reap')) {
    events.push('browser-session-reap');
    for (const [pid, survives] of browserSession) if (!survives) browserSession.delete(pid);
    return ok([...browserSession.keys()].map((pid) => `survivor ${pid}\n`).join(''));
  }
  if (cmd.includes('FARMSLOT_RUNNER_PATTERN=')) {
    if (claimDuringPaneProbe) {
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
    }
    return ok('456');
  }
  if (cmd.startsWith(`identityfile='${IDENTITY}'`)) {
    events.push('reap');
    if (claimAfterReap)
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
    return reapFails
      ? { stdout: '', stderr: 'preflight group 4242 survived SIGKILL\n', exitCode: 1 }
      : ok();
  }
  if (cmd.includes('has-session'))
    return { stdout: '', stderr: '', exitCode: claimDuringPaneProbe ? 0 : 1 };
  if (cmd.includes('list-panes')) return ok(cmd.includes('pane_pid') ? '%1\t123\n' : '%1\n');
  if (cmd.includes('send-keys')) events.push('input-sent');
  if (cmd.startsWith('test -d') && hasMirrorArtifacts) return ok('yes');
  if (cmd.startsWith('rm -rf')) {
    events.push('task-clean');
    if (claimAfterTaskClean)
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
  }
  return ok();
};
const realTeardown = await import('../../run-engine/terminal-teardown-registry.js');
mock.module('../../run-engine/terminal-teardown-registry.js', {
  namedExports: {
    ...realTeardown,
    extendTerminalTeardown: (ms: number) => {
      teardownExtensions.push(ms);
      realTeardown.extendTerminalTeardown(ms);
    },
  },
});
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: execForTest } });

// Main added scaffolding collection after r6. Keep this runner-free release
// fixture at its existing mocked I/O boundary while retaining the claim callback.
const realScaffolding = await import('../../fleet/slot-scaffolding.js');
mock.module('../../fleet/slot-scaffolding.js', {
  namedExports: {
    ...realScaffolding,
    excludeSlotScaffolding: async () => undefined,
    archiveSlotScaffolding: async (
      _vars: unknown,
      _project: unknown,
      options: {
        destination: string;
        beforeRemove?: () => Promise<void>;
        artifactsCollected?: boolean;
      },
    ) => {
      scaffoldingExcludesArtifacts = options.artifactsCollected;
      await options.beforeRemove?.();
      return { roots: 0, directory: options.destination };
    },
  },
});

const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({
      slotId: SLOT_ID,
      remoteRepo: '/slot',
      host: 'macpro',
      machine: 'macpro',
      projectName: 'mm',
      resourceVars: cdpPort ? { cdp_port: cdpPort } : {},
    }),
    loadProjectVars: async () => ({
      runtimeDir: '.agent',
      projectJson: recycleStartsRuntime ? { hooks: { recycle: '__proof_runtime__' } } : {},
    }),
    readSlotField: async (_slotId: string, field: string) => slotRow[field] ?? null,
    readSlotRow: async () => slotRow,
    markSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (claimBeforeMark) {
        slotRow = {
          ...slotRow,
          current_run_id: 'incoming',
          lifecycle: 'busy',
          phase: 'working',
          slot_epoch: 2,
        };
      }
      const applied = applies(predicate, fields);
      if (applied) markerWrites += 1;
      return { applied, epoch: Number(slotRow.slot_epoch) };
    },
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => applies(predicate, fields),
    resetSlotIf: async (_id: string, predicate: (row: Record<string, unknown>) => boolean) => {
      if (!predicate(slotRow)) return false;
      events.push('reset');
      slotRow = {
        ...slotRow,
        current_run_id: null,
        cleanup_run_id: null,
        lifecycle: 'ready',
        phase: null,
      };
      return true;
    },
    execOnSlot: execForTest,
  },
});
const realCopy = await import('../../core/slot-io.js');
mock.module('../../core/slot-io.js', {
  namedExports: {
    ...realCopy,
    slotCopyDir: async (
      _vars: unknown,
      _from: string,
      _to: string,
      options: Record<string, unknown>,
    ) => {
      copyOptions = options;
      if (copyTotals) (options.onTotals as (totals: unknown) => void)(copyTotals);
      if (copyFailure)
        (options.onEntryFailure as (error: unknown) => void)({
          sourcePath: '/slot/.task/dev/proof/artifacts/new.png',
          message: 'transient read failure',
        });
      events.push('mirror-complete');
    },
  },
});
const realStorage = await import('../../fleet/slot-storage-cleanup.js');
mock.module('../../fleet/slot-storage-cleanup.js', {
  namedExports: {
    ...realStorage,
    cleanupSlotStorage: async () => {
      events.push('storage-clean');
      return { deleted: [], skipped: [] };
    },
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mm-1' },
});
const realTracking = await import('./slot-tracking.js');
mock.module('./slot-tracking.js', {
  namedExports: { ...realTracking, assertSlotNotOperatorRoot: async () => undefined },
});
const realCapabilities = await import('../runtime-capabilities.js');
mock.module('../runtime-capabilities.js', {
  namedExports: {
    ...realCapabilities,
    releaseRuntimeCapabilitiesForSlot: async () => ({ ok: true, released: [], failures: [] }),
    getRuntimeCapabilityRegistry: () => ({
      settledStatus: async () => ({ catalog: [], leases: [] }),
    }),
  },
});
const realAttachments = await import('../terminal-attachment.js');
mock.module('../terminal-attachment.js', {
  namedExports: { ...realAttachments, terminalAttachmentCleanup: async () => ({ removed: [] }) },
});
const realNativeWorker = await import('../../runners/native/worker.js');
mock.module('../../runners/native/worker.js', {
  namedExports: { ...realNativeWorker, retireNativeWorkersForSlot: async () => undefined },
});

const realRuns = await import('../../runs/store.js');

const { releaseArtifactCopyBudgetMs, slotRelease, slotReleasePreflight } =
  await import('./release.js');
const { runArchive, runCleanup, runDelete } = await import('../run/admin.js');
const { activePrepareAborts } = await import('./shared.js');
const { slotPrepare } = await import('./prepare.js');

const emit = (event: string, payload: unknown) =>
  emitted.push({ event, payload: payload as Record<string, unknown> });

beforeEach(async () => {
  recycleStartsRuntime = false;
  recycledRuntime = undefined;
  slotRow = { slot: SLOT_ID, lifecycle: 'ready', phase: null, slot_epoch: 1 };
  events = [];
  reapFails = false;
  emitted = [];
  claimBeforeMark = false;
  markerWrites = 0;
  claimDuringPaneProbe = false;
  claimAfterTaskClean = false;
  hasMirrorArtifacts = false;
  copyOptions = undefined;
  scaffoldingExcludesArtifacts = undefined;
  copyFailure = false;
  copyTotals = undefined;
  teardownExtensions = [];
  claimAfterReap = false;
  cdpPort = undefined;
  browserSession = new Map();
  slotCommands = [];

  for (const [id, status] of [
    ['incoming', 'monitoring'],
    ['blocked', 'blocked'],
    ['finished', 'done'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const run = realRuns.createRun(
      { flowType: 'dev', project: 'fixture', ticketOrPr: 'TEST-931-owner' },
      { deferBackgroundPersist: true },
    );
    run.id = id;
    run.status = status;
    writeFileSync(path.join(runRoot, id + '.json'), JSON.stringify(run));
  }
  await realRuns.loadAllRuns();
  activePrepareAborts.clear();
});

test('ordinary and unnamed force release refuse a non-terminal owner before teardown', async () => {
  slotRow.current_run_id = 'incoming';

  for (const forceReset of [false, true])
    await assert.rejects(
      slotRelease({ slotId: SLOT_ID, keepWork: true, forceReset }, emit),
      /non-terminal run incoming/,
    );
  assert.equal(markerWrites, 0);
  assert.equal(
    emitted.filter((e) => e.event === 'slot.release.step' && e.payload.name === 'agent').length,
    0,
  );
});

test('release CAS refuses a run claimed after preflight', async () => {
  claimBeforeMark = true;
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /non-terminal run incoming/,
  );
  assert.equal(markerWrites, 0);
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(slotRow.phase, 'working');
});

test('a late claim aborts teardown before agent exit and leaves its fields intact', async () => {
  const lateClaim = (event: string, payload: unknown) => {
    emit(event, payload);
    if (event === 'slot.release.step' && (payload as { name: string }).name === 'capabilities') {
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
    }
  };
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, lateClaim),
    /non-terminal run incoming/,
  );
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(slotRow.phase, 'working');
  assert.equal(slotRow.slot_epoch, 2);
  assert.equal(
    emitted.filter((e) => e.event === 'slot.release.step' && e.payload.name === 'agent').length,
    0,
  );
});

test('internal blocked-run restart retains its explicitly bound release authority', async () => {
  slotRow.current_run_id = 'blocked';

  const result = await slotRelease(
    { slotId: SLOT_ID, keepWork: true, expectedRunId: 'blocked' },
    emit,
    { restartRunId: 'blocked' },
  );
  assert.equal(result.released, true);
});

test('a claim during pane scanning refuses the graceful exit before typing', async () => {
  claimDuringPaneProbe = true;
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /non-terminal run incoming/,
  );
  assert.ok(!events.includes('input-sent'));
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(slotRow.slot_epoch, 2);
});

test('named force release can explicitly discard the named active workspace', async () => {
  slotRow.current_run_id = 'incoming';

  const result = await slotRelease(
    { slotId: SLOT_ID, keepWork: true, forceReset: true, expectedRunId: 'incoming' },
    emit,
  );
  assert.equal(result.released, true);
});

test('a release stops and joins an in-flight prepare before reaping its scope', async () => {
  // Dependency install is still running: no identity exists yet, so a reap
  // alone finds nothing and the prepare would launch its holder afterwards.
  activePrepareAborts.set(SLOT_ID, {
    abort: () => events.push('prepare-aborted'),
    settled: new Promise<void>((resolve) =>
      setTimeout(() => {
        events.push('prepare-settled');
        resolve();
      }, 20),
    ),
  });

  const result = await slotRelease({ slotId: SLOT_ID, keepWork: true }, emit);

  assert.deepEqual(result, { released: true });
  assert.deepEqual(events.slice(0, 3), ['prepare-aborted', 'prepare-settled', 'reap']);
});

test('a preflight group that survives the reap keeps the slot held and fails the release', async () => {
  reapFails = true;

  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /Slot macpro-mm-1 stays held: Prepare scope cleanup failed: preflight group 4242 survived/,
  );

  assert.equal(slotRow.lifecycle, 'held');
  assert.equal(slotRow.phase, 'occupied');
  assert.match(String(slotRow.held_reason), /Prepare scope cleanup failed/);
  assert.equal(slotRow.releasing_since, null);
  assert.ok(!events.includes('reset'), 'readiness is never published');
  const completed = emitted.find((entry) => entry.event === 'script.complete');
  assert.equal(completed?.payload.exitCode, 1);
});

test('a prepare that never stops keeps the slot held and fails the release', async () => {
  // A git command stalled on a dropped network never observes the abort.
  activePrepareAborts.set(SLOT_ID, {
    abort: () => events.push('prepare-aborted'),
    settled: new Promise<void>(() => {}),
  });

  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit, {
      prepareStopTimeoutMs: 60,
      prepareStopHeartbeatMs: 10,
    }),
    /Slot macpro-mm-1 stays held: In-flight prepare did not stop within/,
  );
  assert.ok(
    emitted.some(
      (entry) =>
        entry.event === 'slot.release.step' &&
        String(entry.payload.detail).startsWith('Waiting for in-flight prepare to stop'),
    ),
    'the wait reports progress so a CLI idle timeout does not end it first',
  );

  assert.equal(slotRow.lifecycle, 'held');
  assert.equal(slotRow.phase, 'occupied');
  assert.match(String(slotRow.held_reason), /In-flight prepare did not stop within/);
  assert.equal(slotRow.releasing_since, null);
  assert.ok(!events.includes('reap'), 'the unfinished prepare is not reaped underneath');
  assert.ok(!events.includes('reset'), 'readiness is never published');
  const completed = emitted.find((entry) => entry.event === 'script.complete');
  assert.equal(completed?.payload.exitCode, 1);
});

test('a prepare started while the slot is releasing is refused', async () => {
  // The release reads the in-flight registry once, so a later prepare must not start.
  slotRow = { ...slotRow, lifecycle: 'busy', phase: 'releasing' };

  await assert.rejects(slotPrepare({ slotId: SLOT_ID }, emit), /is being released/);

  assert.equal(activePrepareAborts.has(SLOT_ID), false, 'the refused prepare deregisters');
});

test('a bound release that loses its preflight owner returns not released', async () => {
  slotRow.current_run_id = 'finished';

  claimBeforeMark = true;
  assert.deepEqual(
    await slotRelease({ slotId: SLOT_ID, keepWork: true, expectedRunId: 'finished' }, emit),
    { released: false, reason: `Slot ${SLOT_ID} is held by run incoming, not run finished` },
  );
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(markerWrites, 0);
});

test('missing owner records refuse release with explicit named RPC guidance', async () => {
  slotRow.current_run_id = 'missing';
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /held by missing run missing.*slot.release RPC/,
  );
  assert.equal(markerWrites, 0);
});

test('a claim during artifact collection refuses task deletion and storage cleanup', async () => {
  slotRow.task_file = '.task/dev/proof/TASK.md';
  hasMirrorArtifacts = true;
  const lateClaim = (event: string, payload: unknown) => {
    emit(event, payload);
    if (
      event === 'slot.release.step' &&
      (payload as { name: string }).name === 'artifacts' &&
      (payload as { detail: string }).detail.startsWith('Artifacts collected')
    ) {
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
    }
  };
  await assert.rejects(slotRelease({ slotId: SLOT_ID }, lateClaim), /non-terminal run incoming/);
  assert.ok(events.includes('mirror-complete'));
  assert.ok(!events.includes('task-clean'));
  assert.ok(!events.includes('storage-clean'));
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(slotRow.slot_epoch, 2);
});

// F298: macpro-audiolab-6's release copied its 882 MB of artifacts again, though the completion
// mirror held all but the excluded recipe runs, and the teardown timed out after 300 s every time.
test('release copyback keeps artifacts the completion mirror already holds', async () => {
  slotRow.task_file = '.task/dev/proof/TASK.md';
  hasMirrorArtifacts = true;
  await slotRelease({ slotId: SLOT_ID }, emit);
  assert.ok(events.includes('mirror-complete'));
  assert.equal(copyOptions?.skipUnchanged, true);
  assert.equal(scaffoldingExcludesArtifacts, true, 'the scaffolding archive skips them too');
});

// F298 follow-up: after #1726, 9dd08510's release still copied 851 MB of APKs the mirror never
// indexed, inside the 300 s teardown budget. The copy now adds a budget for its own bytes.
test('a release copying 1.6 GB of unindexed artifacts adds their transfer time to the teardown', async () => {
  slotRow.task_file = '.task/dev/proof/TASK.md';
  hasMirrorArtifacts = true;
  const bytes = 1.6 * 1024 ** 3;
  copyTotals = { files: 2, bytes };
  await slotRelease({ slotId: SLOT_ID }, emit);
  assert.deepEqual(teardownExtensions, [releaseArtifactCopyBudgetMs(bytes)]);
  assert.ok(
    teardownExtensions[0]! > (bytes / (5 * 1024 * 1024)) * 1000,
    'longer than the copy takes at the measured 5 MB/s',
  );
  assert.equal(releaseArtifactCopyBudgetMs(1024), 60_000, 'a small copy gets the floor');
});

test('a copyback with a failed file keeps the artifacts in the scaffolding archive', async () => {
  slotRow.task_file = '.task/dev/proof/TASK.md';
  hasMirrorArtifacts = true;
  copyFailure = true;
  await slotRelease({ slotId: SLOT_ID }, emit);
  assert.equal(scaffoldingExcludesArtifacts, false);
});

test('a claim during task deletion refuses the following storage cleanup', async () => {
  slotRow.task_file = '.task/dev/proof/TASK.md';
  hasMirrorArtifacts = true;
  claimAfterTaskClean = true;
  await assert.rejects(slotRelease({ slotId: SLOT_ID }, emit), /non-terminal run incoming/);
  assert.ok(events.includes('mirror-complete'));
  assert.ok(events.includes('task-clean'));
  assert.ok(!events.includes('storage-clean'));
  assert.equal(slotRow.current_run_id, 'incoming');
});

test('a bound owner change during teardown returns not released and preserves the new claim', async () => {
  slotRow.current_run_id = 'finished';
  const lateClaim = (event: string, payload: unknown) => {
    emit(event, payload);
    if (event === 'slot.release.step' && (payload as { name: string }).name === 'capabilities')
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 2,
      };
  };
  assert.deepEqual(
    await slotRelease({ slotId: SLOT_ID, keepWork: true, expectedRunId: 'finished' }, lateClaim),
    { released: false, reason: `Slot ${SLOT_ID} moved to another owner` },
  );
  assert.equal(slotRow.current_run_id, 'incoming');
  assert.equal(slotRow.phase, 'working');
  assert.equal(slotRow.slot_epoch, 2);
});

test('an older replay cannot release a newer claim by the same run', async () => {
  slotRow.current_run_id = 'incoming';
  slotRow.slot_epoch = 2;
  assert.deepEqual(
    await slotRelease({ slotId: SLOT_ID, keepWork: true, expectedRunId: 'incoming' }, emit, {
      restartRunId: 'incoming',
      expectedSlotEpoch: 1,
    }),
    { released: false, reason: `Slot ${SLOT_ID} moved past epoch 1` },
  );
  assert.equal(markerWrites, 0);
  assert.equal(slotRow.slot_epoch, 2);
});

test('a claim after agent teardown stops release before aborting the new prepare', async () => {
  activePrepareAborts.set(SLOT_ID, {
    abort: () => events.push('new-prepare-aborted'),
    settled: Promise.resolve(),
  });
  const lateClaim = (event: string, payload: unknown) => {
    emit(event, payload);
    if (event === 'slot.release.step' && (payload as { detail: string }).detail === 'Agent killed')
      slotRow = {
        ...slotRow,
        current_run_id: 'incoming',
        lifecycle: 'busy',
        phase: 'preparing',
        slot_epoch: 2,
      };
  };
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, lateClaim),
    /non-terminal run incoming/,
  );
  assert.ok(!events.includes('new-prepare-aborted'));
  assert.equal(slotRow.current_run_id, 'incoming');
});

test('a claim during prepare reaping stops attachment cleanup and session archival', async () => {
  claimAfterReap = true;
  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /non-terminal run incoming/,
  );
  assert.ok(events.includes('reap'));
  assert.equal(
    emitted.filter(
      (entry) =>
        entry.event === 'slot.release.step' &&
        ['attachments', 'session-archive'].includes(String(entry.payload.name)),
    ).length,
    0,
  );
  assert.equal(slotRow.current_run_id, 'incoming');
});

test("a release stops the browser session a run left on the slot's CDP port", async () => {
  cdpPort = '9542';
  browserSession = new Map([
    [11425, false],
    [20419, false],
  ]);

  assert.deepEqual(await slotRelease({ slotId: SLOT_ID, keepWork: true }, emit), {
    released: true,
  });

  assert.equal(browserSession.size, 0);
  assert.ok(events.indexOf('browser-session-reap') < events.indexOf('reset'));
});

test('a browser session process that survives keeps the slot held and names it', async () => {
  cdpPort = '9542';
  browserSession = new Map([
    [11425, false],
    [20419, true],
  ]);

  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true }, emit),
    /Slot macpro-mm-1 stays held: Browser session process 20419 \(Google Chrome for Testing .*\) on CDP port 9542 did not stop/,
  );
  assert.equal(slotRow.lifecycle, 'held');
  assert.match(String(slotRow.held_reason), /Browser session process 20419/);
  assert.ok(!events.includes('reset'), 'readiness is never published');
});

// Delete and archive end a cancelled run, and the run view's Release frees its slot:
// delete and explicit Release keep their reset policy; archive preserves local work.
async function releaseFromRunView(): Promise<void> {
  const hold = cancelledRunSlotHold({
    slot: SLOT_ID,
    lifecycle: 'held',
    phase: 'occupied',
    currentRunId: 'cancelled',
    heldReason: cancelledRunHoldReason('cancelled'),
  });
  if (!hold) return assert.fail('the kept slot has no hold');
  assert.equal(
    await releaseCancelledRunSlot((_method, params) => slotRelease(params, emit), hold),
    null,
  );
}

const CANCELLED_SLOT_RELEASES: Array<[string, () => Promise<unknown>, boolean]> = [
  ['delete', () => runDelete({ runId: 'cancelled' }, emit), true],
  ['archive', () => runArchive({ runId: 'cancelled' }, emit), true],
  ['the run view Release', releaseFromRunView, false],
];

for (const [action, release, endsRun] of CANCELLED_SLOT_RELEASES) {
  test(`${action} of a cancelled run releases ownership under its checkout policy`, async (t) => {
    realRuns.updateRun('cancelled', { slotId: SLOT_ID });
    slotRow = {
      ...slotRow,
      current_run_id: 'cancelled',
      lifecycle: 'held',
      phase: 'occupied',
      held_reason: cancelledRunHoldReason('cancelled'),
    };
    const log = t.mock.method(console, 'log', () => {});

    await release();

    assert.ok(events.includes('reset'), 'the slot was released');
    assert.equal(realRuns.getRun('cancelled') === undefined, endsRun);
    assert.equal(
      log.mock.calls.filter((call) =>
        /reset discards HEAD 5d0c1a7e and 2 dirty file\(s\) of run cancelled/.test(
          String(call.arguments[0]),
        ),
      ).length,
      action === 'archive' ? 0 : 1,
      'archive preserves local work; explicit reset records its discard',
    );
    assert.ok(
      !slotCommands.some((cmd) => cmd.startsWith('lsof -a -d cwd')),
      'no process using the checkout is consulted',
    );
  });
}

test('cleanup archives a week-old cancelled run only after releasing its kept slot', async (t) => {
  // Cleanup archives failed and cancelled runs untouched for 7 days.
  const cancelled = { ...realRuns.getRun('cancelled'), slotId: SLOT_ID };
  cancelled.updatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(path.join(runRoot, 'cancelled.json'), JSON.stringify(cancelled));
  await realRuns.loadAllRuns();
  slotRow = {
    ...slotRow,
    current_run_id: 'cancelled',
    lifecycle: 'held',
    phase: 'occupied',
    held_reason: cancelledRunHoldReason('cancelled'),
  };
  t.mock.method(console, 'log', () => {});
  let presentAtRelease: boolean | undefined;
  const slot = {
    returnToIdle: async (): Promise<
      import('../../run-lifecycle/safe-idle-slot.js').SafeIdleSlotResult
    > => ({ kind: 'ready' }),
    preflight: slotReleasePreflight,
    release: (
      params: Parameters<typeof slotRelease>[0],
      releaseEmit: Parameters<typeof slotRelease>[1],
    ) => {
      presentAtRelease = realRuns.getRun('cancelled') !== undefined;
      return slotRelease(params, releaseEmit);
    },
  };

  const result = await runCleanup({ dryRun: false }, slot);

  assert.equal(presentAtRelease, true, 'the slot is released before the run leaves the store');

  assert.ok(result.runsArchived.includes('cancelled'));
  assert.ok(events.includes('reset'), 'the kept ownership was released, not orphaned');
  assert.equal(slotRow.current_run_id ?? null, null);
  assert.equal(realRuns.getRun('cancelled'), undefined, 'the run was archived after');
});

test('deleting a cancelled run leaves a slot another active run owns', async () => {
  realRuns.updateRun('cancelled', { slotId: SLOT_ID });
  slotRow = { ...slotRow, current_run_id: 'incoming', lifecycle: 'busy', phase: 'working' };

  assert.deepEqual(await runDelete({ runId: 'cancelled' }, emit), { ok: true });

  assert.equal(slotRow.current_run_id, 'incoming');
  assert.ok(!events.includes('reset'));
  assert.equal(realRuns.getRun('cancelled'), undefined);
});

for (const mode of ['automatic', 'manual', 'ordinary'])
  test(`${mode} recovery preserves its recycle policy`, async (t) => {
    const recovery = mode !== 'ordinary';
    recycleStartsRuntime = true;
    slotRow.current_run_id = 'finished';
    if (recovery) {
      slotRow.workspace_recovery = { id: 'cold-recovery' };
      slotRow.phase = 'releasing';
    }
    t.after(async () => {
      if (
        recycledRuntime &&
        recycledRuntime.exitCode === null &&
        recycledRuntime.signalCode === null
      ) {
        const exited = once(recycledRuntime, 'exit');
        recycledRuntime.kill('SIGTERM');
        await exited;
      }
    });
    const result = await slotRelease(
      { slotId: SLOT_ID, skipArtifacts: true, forceReset: !recovery },
      emit,
      recovery
        ? {
            workspaceRecovery: {
              id: 'cold-recovery',
              epoch: 1,
              verifyWork: async () => {},
              discardLocalWork: false,
              skipRecycle: mode === 'automatic',
            },
          }
        : undefined,
    );
    assert.equal(result.released, true);
    assert.equal(
      Boolean(recycledRuntime),
      mode !== 'automatic',
      'manual recovery and ordinary release retain recycle; automatic recovery stays cold',
    );
  });
