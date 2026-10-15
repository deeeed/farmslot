import assert from 'node:assert/strict';
import test from 'node:test';

import { capturePublicationSource } from './publication-source.js';
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
