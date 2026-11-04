import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'f396-claim-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
const core = await import('../core/index.js');
const { commitSlotClaim } = await import('./find-slot-step.js');
const recovery = { id: 'recovery-1' };
const seed = async (fields: Record<string, unknown>) =>
  writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: 'example-slot',
          slot_epoch: 4,
          current_run_id: null,
          ...fields,
        },
      ],
    }),
  );
test('a refused repeat claim drops only its own ownership and keeps recovery held', async () => {
  await seed({ workspace_recovery: null, lifecycle: 'ready', phase: null });
  await commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
    runLookup: () => ({ status: 'slot-finding' }),
  });
  assert.equal((await core.readSlotRow('example-slot'))?.current_run_id, 'example-run');
  await core.updateSlotStatus('example-slot', {
    workspace_recovery: recovery,
    held_reason: 'Recovery interrupted',
  });
  await assert.rejects(
    commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
      runLookup: () => ({ status: 'slot-finding' }),
      listSlotRuns: async () => [],
    }),
    {
      message:
        'Slot example-slot cannot be claimed: slot remains occupied: Recovery interrupted; release it with `farmslot slot release example-slot` — pick a slot again',
    },
  );
  const row = await core.readSlotRow('example-slot');
  assert.equal(row?.current_run_id, null);
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.phase, 'occupied');
  assert.equal(row?.agent, 'idle');
  assert.deepEqual(row?.workspace_recovery, recovery);
});
for (const field of ['cleanup_run_id', 'handoff_run_id']) {
  test(`a refused recovery claim preserves a ${field} fence`, async () => {
    const initial = {
      workspace_recovery: recovery,
      current_run_id: 'example-run',
      lifecycle: 'busy',
      phase: 'working',
      agent: 'working',
      [field]: 'another-run',
    };
    await seed(initial);
    await assert.rejects(
      commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
        runLookup: () => ({ status: 'slot-finding' }),
        listSlotRuns: async () => [],
      }),
    );
    const row = await core.readSlotRow('example-slot');
    for (const [key, value] of Object.entries(initial)) assert.deepEqual(row?.[key], value);
  });
}
test('a rival claim after the rollback observation is preserved', async () => {
  await seed({
    workspace_recovery: recovery,
    current_run_id: 'example-run',
    lifecycle: 'busy',
    phase: 'working',
  });
  await assert.rejects(
    commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
      runLookup: () => ({ status: 'slot-finding' }),
      listSlotRuns: async () => [],
      readRow: async (slot) => {
        const observed = await core.readSlotRow(slot);
        await core.updateSlotStatus(slot, { slot_epoch: 5, current_run_id: 'rival-run' });
        return observed;
      },
    }),
  );
  const row = await core.readSlotRow('example-slot');
  assert.equal(row?.current_run_id, 'rival-run');
  assert.equal(row?.slot_epoch, 5);
});
test('a refused claim does not detach a live owned lease', async () => {
  await seed({
    workspace_recovery: recovery,
    current_run_id: 'example-run',
    lifecycle: 'busy',
    phase: 'working',
    agent: 'working',
  });
  await assert.rejects(
    commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
      runLookup: () => ({ status: 'monitoring' }),
      listSlotRuns: async () => [],
    }),
  );
  const row = await core.readSlotRow('example-slot');
  assert.equal(row?.current_run_id, 'example-run');
  assert.equal(row?.lifecycle, 'busy');
  assert.equal(row?.agent, 'working');
});
test('supersession after a successful claim releases ownership without clearing recovery', async () => {
  let superseded = false;
  await seed({ workspace_recovery: null, lifecycle: 'ready', phase: null });
  await assert.rejects(
    commitSlotClaim('example-slot', 'example-run', 0, 'working', 'working', undefined, {
      runLookup: () => ({ status: superseded ? 'failed' : 'slot-finding' }),
      claimSlotStatusIf: async (...args: Parameters<typeof core.claimSlotStatusIf>) => {
        const claim = await core.claimSlotStatusIf(...args);
        superseded = true;
        await core.updateSlotStatus('example-slot', { workspace_recovery: recovery });
        return claim;
      },
    }),
    { message: 'Run example- changed while waiting for slot example-slot' },
  );
  const row = await core.readSlotRow('example-slot');
  assert.equal(row?.current_run_id, null);
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.phase, 'occupied');
  assert.deepEqual(row?.workspace_recovery, recovery);
});
