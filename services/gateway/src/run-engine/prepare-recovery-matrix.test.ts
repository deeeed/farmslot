import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { recoveryBranchAction } from '../methods/slot/prepare-recovery.js';

import { prepareReusesRunBranch, recoveryMayInitializeBranch } from './prepare-branch-state.js';

// Full recovery state table. Unpushed means original run work, including a
// detached tip when its named branch is absent. A same-slot local branch retains
// that work. Cross-slot recovery must verify the original work before proceeding.
// Branch assignment timing and replay entry step must not change the outcome.
// Columns: worker started, same/cross slot, available branch, unpushed, outcome.
const table = [
  [false, 'same', 'local', false, 'preserve'],
  [false, 'same', 'local', true, 'preserve'],
  [false, 'same', 'published', false, 'preserve'],
  [false, 'same', 'published', true, 'fail-closed'],
  [false, 'same', 'missing', false, 'fresh'],
  [false, 'same', 'missing', true, 'fail-closed'],
  [false, 'cross', 'local', false, 'preserve'],
  [false, 'cross', 'local', true, 'fail-closed'],
  [false, 'cross', 'published', false, 'preserve'],
  [false, 'cross', 'published', true, 'fail-closed'],
  [false, 'cross', 'missing', false, 'fresh'],
  [false, 'cross', 'missing', true, 'fail-closed'],
  [true, 'same', 'local', false, 'preserve'],
  [true, 'same', 'local', true, 'preserve'],
  [true, 'same', 'published', false, 'preserve'],
  [true, 'same', 'published', true, 'fail-closed'],
  [true, 'same', 'missing', false, 'fail-closed'],
  [true, 'same', 'missing', true, 'fail-closed'],
  [true, 'cross', 'local', false, 'preserve'],
  [true, 'cross', 'local', true, 'fail-closed'],
  [true, 'cross', 'published', false, 'preserve'],
  [true, 'cross', 'published', true, 'fail-closed'],
  [true, 'cross', 'missing', false, 'fail-closed'],
  [true, 'cross', 'missing', true, 'fail-closed'],
] as const;

const cells = new Set<string>();
for (const assignment of ['before', 'during'] as const) {
  for (const step of ['find-slot', 'grade', 'write-task', 'prepare'] as const) {
    for (const [workerStarted, slot, presence, unpushed, expected] of table) {
      const label = `${assignment}/${step}/worker=${workerStarted}/${slot}/${presence}/unpushed=${unpushed}`;
      assert.equal(cells.has(label), false, `duplicate cell ${label}`);
      cells.add(label);
      test(`recovery ${label} => ${expected}`, () => {
        const run = {
          branch: 'feature/recovery',
          slotId: slot === 'same' ? 'original' : 'replacement',
          engineState: {
            workerLaunchStarted: workerStarted,
            // Both a prepare that got past Git and a name assigned during
            // replay carry durable no-worker history, independently of setup.
            prepareBranch: {
              slotId: assignment === 'before' ? 'original' : undefined,
              branch: 'feature/recovery',
              started: assignment === 'before',
            },
          },
          recoveryAttempts: [{ stepName: step, status: 'started' }],
        } as Run;
        assert.equal(prepareReusesRunBranch(run), true);
        const state = {
          branch: run.branch!,
          presence,
          workerNeverStarted: recoveryMayInitializeBranch(run),
          sourceWorkSafe: !unpushed || (slot === 'same' && presence === 'local'),
        };
        if (expected === 'fail-closed') {
          assert.throws(
            () => recoveryBranchAction(state),
            /Replay cannot .*Push or preserve|Replay cannot .*Restore or push/,
          );
        } else {
          assert.equal(recoveryBranchAction(state), expected);
        }
      });
    }
  }
}

test('the recovery matrix contains every one of the 192 cells', () => {
  assert.equal(table.length, 24);
  assert.equal(cells.size, 2 * 4 * 2 * 2 * 3 * 2);
});

test('unknown historical worker state and unreachable remotes fail closed', () => {
  const run = {
    branch: 'work',
    engineState: { prepareBranch: { branch: 'work', started: true } },
  } as Run;
  assert.equal(recoveryMayInitializeBranch(run), false);
  assert.equal(
    recoveryMayInitializeBranch({
      ...run,
      engineState: { prepareBranch: { branch: 'work', started: false } },
    }),
    false,
  );
  assert.throws(
    () =>
      recoveryBranchAction({
        branch: 'work',
        presence: 'missing',
        sourceWorkSafe: true,
        workerNeverStarted: false,
      }),
    /worker may have started.*Restore or push/,
  );
  assert.throws(
    () =>
      recoveryBranchAction({
        branch: 'work',
        presence: 'unknown',
        sourceWorkSafe: true,
        workerNeverStarted: true,
      }),
    /remote absence is unconfirmed.*Restore access/,
  );
});
