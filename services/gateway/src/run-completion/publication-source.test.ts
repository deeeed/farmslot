import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { capturePublicationSource, rebindUnownedPublicationSlot } from './publication-source.js';
import { makeRun } from './test-fixtures.js';

const run = makeRun({ branch: 'owned-branch', slotId: 'owned-slot' });
const headSha = 'a'.repeat(40);
const owned = { current_run_id: run.id, slot_epoch: 1 };
const git = async () => ({ headSha, branch: run.branch! });

test('publication authority rejects transferred slots, branch drift and epoch drift even at the same head', async () => {
  await assert.rejects(
    capturePublicationSource(run, {
      slot: async () => ({ ...owned, current_run_id: 'foreign-run' }),
      git,
    }),
    /no longer owned/,
  );
  await assert.rejects(
    capturePublicationSource(run, {
      slot: async () => owned,
      git: async () => ({ headSha, branch: 'foreign-branch' }),
    }),
    /ownership or branch changed/,
  );
  let reads = 0;
  await assert.rejects(
    capturePublicationSource(run, { slot: async () => ({ ...owned, slot_epoch: ++reads }), git }),
    /ownership or branch changed/,
  );
  assert.deepEqual(await capturePublicationSource(run, { slot: async () => owned, git }), {
    headSha,
    branch: run.branch,
    slotEpoch: 1,
  });
});

test('a gate re-binds its slot only when no run holds it and the checkout is on the run branch', async () => {
  // TAT-4145 bda11b1a: a reconcile reset macpro-mmt-1 during a human-gate replay. The slot kept
  // the run's checkout (feat/tat-4145-cross-margin at 25867794) but had no owner.
  const rebound: string[] = [];
  const rebind = async (target: Run) => {
    rebound.push(target.id);
    return null;
  };
  const unowned = { current_run_id: null, slot_epoch: 2, lifecycle: 'busy', phase: 'review-gate' };
  assert.equal(
    await rebindUnownedPublicationSlot(run, { slot: async () => unowned, git, rebind }),
    true,
  );
  assert.deepEqual(rebound, [run.id]);
  const refused: Array<[string, Parameters<typeof rebindUnownedPublicationSlot>[1]]> = [
    ['owned by this run', { slot: async () => owned, git }],
    [
      'owned by another run',
      { slot: async () => ({ ...owned, current_run_id: 'foreign-run' }), git },
    ],
    [
      'checkout on another branch',
      { slot: async () => unowned, git: async () => ({ headSha, branch: 'foreign-branch' }) },
    ],
    [
      'checkout unreadable',
      {
        slot: async () => unowned,
        git: async () => {
          throw new Error('Publication source checkout is unavailable');
        },
      },
    ],
  ];
  for (const [name, overrides] of refused)
    assert.equal(await rebindUnownedPublicationSlot(run, { ...overrides, rebind }), false, name);
  assert.deepEqual(rebound, [run.id]);
  assert.equal(
    await rebindUnownedPublicationSlot(run, {
      slot: async () => unowned,
      git,
      rebind: async () => 'run foreign-run',
    }),
    false,
    'a refused claim is not a re-bind',
  );
});
