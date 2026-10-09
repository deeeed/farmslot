import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// slotRelease is driven through a faked slot exec layer and slot row: no tmux,
// shell or process is touched. Real namespaces are spread into each mock, and
// each one is loaded only after the mocks before it, so its graph sees them.
const SLOT_ID = 'macpro-mm-1';
const IDENTITY = '/slot/.agent/preflight.identity';

let slotRow: Record<string, unknown>;
let events: string[];
let reapFails: boolean;
let emitted: Array<{ event: string; payload: Record<string, unknown> }>;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const applies = (
  predicate: (slot: Record<string, unknown>) => boolean,
  fields: Record<string, unknown>,
) => {
  if (!predicate(slotRow)) return false;
  slotRow = { ...slotRow, ...fields };
  return true;
};

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
    ) => ({ applied: applies(predicate, fields), epoch: Number(slotRow.slot_epoch) }),
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => applies(predicate, fields),
    resetSlotIf: async () => {
      events.push('reset');
      return true;
    },
    execOnSlot: async (_vars: unknown, cmd: string) => {
      if (cmd.startsWith(`identityfile='${IDENTITY}'`)) {
        events.push('reap');
        return reapFails
          ? { stdout: '', stderr: 'preflight group 4242 survived SIGKILL\n', exitCode: 1 }
          : ok();
      }
      if (cmd.includes('has-session')) return { stdout: '', stderr: '', exitCode: 1 };
      return ok();
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

const { slotRelease } = await import('./release.js');
const { activePrepareAborts } = await import('./shared.js');
const { slotPrepare } = await import('./prepare.js');

const emit = (event: string, payload: unknown) =>
  emitted.push({ event, payload: payload as Record<string, unknown> });

beforeEach(() => {
  slotRow = { slot: SLOT_ID, lifecycle: 'ready', phase: null, slot_epoch: 1 };
  events = [];
  reapFails = false;
  emitted = [];
  activePrepareAborts.clear();
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
