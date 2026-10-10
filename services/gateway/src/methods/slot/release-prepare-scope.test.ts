import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

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
let events: string[];
let reapFails: boolean;
let emitted: Array<{ event: string; payload: Record<string, unknown> }>;
let claimBeforeMark = false;
let markerWrites = 0;
let claimDuringPaneProbe = false;
let claimAfterTaskClean = false;
let hasMirrorArtifacts = false;
let claimAfterReap = false;

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
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: execForTest } });

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
      resourceVars: {},
    }),
    loadProjectVars: async () => ({ runtimeDir: '.agent', projectJson: {} }),
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
    resetSlotIf: async () => {
      events.push('reset');
      return true;
    },
    execOnSlot: execForTest,
  },
});
const realCopy = await import('../../core/slot-io.js');
mock.module('../../core/slot-io.js', {
  namedExports: {
    ...realCopy,
    slotCopyDir: async () => {
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

const { slotRelease } = await import('./release.js');
const { activePrepareAborts } = await import('./shared.js');
const { slotPrepare } = await import('./prepare.js');

const emit = (event: string, payload: unknown) =>
  emitted.push({ event, payload: payload as Record<string, unknown> });

beforeEach(async () => {
  slotRow = { slot: SLOT_ID, lifecycle: 'ready', phase: null, slot_epoch: 1 };
  events = [];
  reapFails = false;
  emitted = [];
  claimBeforeMark = false;
  markerWrites = 0;
  claimDuringPaneProbe = false;
  claimAfterTaskClean = false;
  hasMirrorArtifacts = false;
  claimAfterReap = false;

  for (const [id, status] of [
    ['incoming', 'monitoring'],
    ['blocked', 'blocked'],
    ['finished', 'done'],
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
    { released: false },
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
    { released: false },
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
    { released: false },
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
