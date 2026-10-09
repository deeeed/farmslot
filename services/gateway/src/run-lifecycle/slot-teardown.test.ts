import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the slot row, project vars, exec layer, worker stop, run store,
// capability ownership release and transcript archive are faked. The fake exec models the prepare identity file
// and the process group the holder lives in. The task watcher stays real: its
// import graph reaches slot-teardown, which would then load before the mocks apply.
import * as realCore from '../core/index.js';
import * as realOwnedStop from '../runners/owned-stop.js';
import * as realSessionArchive from '../runners/session-archive.js';
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
    }),
    loadProjectVars: async () => ({ runtimeDir: '.agent' }),
    readSlotRow: async () => slotRow,
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
mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    listRuns: () => ({ runs: otherRuns }),
    updateRun: (_id: string, patch: Partial<Run>) => ({ ...run, ...patch }),
  },
});
mock.module('../runners/owned-stop.js', {
  namedExports: { ...realOwnedStop, stopRunOwnedTmuxWorkers: async () => null },
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
// Loaded only after the mocks above, so its graph sees them; teardown imports
// it lazily, so the override below is what releaseRunOwnedCapabilities gets.
const realRuntimeCapabilities = await import('../methods/runtime-capabilities.js');
mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    ...realRuntimeCapabilities,
    releaseRuntimeCapabilityOwnershipForRun: async () => ({ ok: true, failures: [] }),
  },
});

const { stopRunOwnedTmuxAndWatches } = await import('./slot-teardown.js');
const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');

const run = { id: RUN_ID, slotId: SLOT_ID, agentContexts: [] } as unknown as Run;
const reaps = () => commands.filter((cmd) => cmd.includes(`identityfile='${IDENTITY}'`));

beforeEach(() => {
  slotRow = { current_run_id: RUN_ID, slot_epoch: 1 };
  slotWrites = [];
  commands = [];
  recordedScope = SCOPE;
  holderAlive = true;
  holderSurvives = false;
  onIdentityRead = null;
  otherRuns = [];
  archived = 0;
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
