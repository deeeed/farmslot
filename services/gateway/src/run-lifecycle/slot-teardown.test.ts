import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the slot row, project vars, exec layer, worker stop and transcript
// archive are faked. The fake exec models the prepare identity file and the
// process group the holder lives in. The task watcher stays real: its import
// graph reaches slot-teardown, which would then load before the mocks apply.
import * as realCore from '../core/index.js';
import * as realOwnedStop from '../runners/owned-stop.js';
import * as realSessionArchive from '../runners/session-archive.js';
import * as realRunStore from '../runs/store.js';

const RUN_ID = 'run-cancelled';
const SLOT_ID = 'macpro-mm-pixel6';
const IDENTITY = '/slot/.agent/preflight.identity';

let slotRow: Record<string, unknown> | null;
let commands: string[];
/** The recorded prepare scope: present until a reap removes it. */
let identityRecorded: boolean;
/** The preflight group (and its farmslot-prepare-scope holder) is running. */
let holderAlive: boolean;
let otherRuns: Run[];

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
    execOnSlot: async (_vars: unknown, cmd: string) => {
      commands.push(cmd);
      if (cmd.includes(`identityfile='${IDENTITY}'`)) {
        const killed = identityRecorded && holderAlive;
        identityRecorded = false;
        if (killed) holderAlive = false;
        return {
          stdout: killed ? 'killed verified preflight group (4242)\n' : '',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: { ...realRunStore, listRuns: () => ({ runs: otherRuns }) },
});
mock.module('../runners/owned-stop.js', {
  namedExports: { ...realOwnedStop, stopRunOwnedTmuxWorkers: async () => null },
});
mock.module('../runners/session-archive.js', {
  namedExports: {
    ...realSessionArchive,
    archiveRunnerSessionsForSlotRelease: async () => ({ summary: 'none' }),
  },
});

const { stopRunOwnedTmuxAndWatches } = await import('./slot-teardown.js');

const run = { id: RUN_ID, slotId: SLOT_ID, agentContexts: [] } as unknown as Run;
const reaps = () => commands.filter((cmd) => cmd.includes(`identityfile='${IDENTITY}'`));

beforeEach(() => {
  slotRow = { current_run_id: RUN_ID, slot_epoch: 1 };
  commands = [];
  identityRecorded = true;
  holderAlive = true;
  otherRuns = [];
});

test('cancel during or after prepare stops the run prepare-scope holder', async () => {
  // Both shapes leave the nohup'd holder behind: a kept-alive preflight window
  // outlives prepare, and an aborted window's descendant cleanup skips the holder.
  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);

  assert.equal(reaps().length, 1, 'release must reap the recorded prepare scope');
  assert.equal(holderAlive, false);
  assert.ok(
    commands.some((cmd) => cmd.includes('kill -0 -- -4242') && cmd.includes('kill -KILL -- -4242')),
    'release must wait out the reaped group before the occupancy census',
  );
});

test('releasing twice is a no-op the second time', async () => {
  await stopRunOwnedTmuxAndWatches(run);
  commands = [];

  assert.equal(await stopRunOwnedTmuxAndWatches(run), null);
  assert.equal(reaps().length, 1, 'the identity check still runs');
  assert.ok(
    !commands.some((cmd) => cmd.includes('kill -KILL')),
    'nothing is signalled once the scope is gone',
  );
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
