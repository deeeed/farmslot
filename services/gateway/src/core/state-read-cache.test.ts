import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'status-read-cache-'));
const statusFile = path.join(root, 'status.json');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_TEST_STATUS_FILE: statusFile,
});
after(() => rm(root, { recursive: true, force: true }));

const { readSlotField, readSlotRow, updateSlotStatus } = await import('./state.js');

/** Files written now look settled, so the cache trusts their stamps as it does in steady state. */
function settledClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
}

function status(owner: string): string {
  return JSON.stringify({
    slots: [
      { slot: 'a', current_run_id: owner, workspace_recovery: { id: 'r1' } },
      { slot: 'b', current_run_id: null },
    ],
  });
}

test('rows of one file version are parsed once, frozen and shared', async (t) => {
  settledClock(t);
  await writeFile(statusFile, status('run-1'));
  const row = await readSlotRow('a');
  assert.equal(await readSlotRow('a'), row);
  assert.ok(row && Object.isFrozen(row));
  assert.equal(Reflect.set(row, 'current_run_id', 'run-x'), false);
  assert.equal(Reflect.set(row.workspace_recovery as object, 'id', 'r2'), false);
  assert.deepEqual(await readSlotRow('a'), {
    slot: 'a',
    current_run_id: 'run-1',
    workspace_recovery: { id: 'r1' },
  });
  assert.equal(await readSlotField('a', 'current_run_id'), 'run-1');
  assert.equal(await readSlotRow('missing'), null);
});

test('an outside rewrite of the same size, or a replace, is read again', async (t) => {
  settledClock(t);
  await writeFile(statusFile, status('run-1'));
  assert.equal((await readSlotRow('a'))?.current_run_id, 'run-1');
  await writeFile(statusFile, status('run-2'));
  assert.equal((await readSlotRow('a'))?.current_run_id, 'run-2', 'same size, new mtime');
  await writeFile(`${statusFile}.tmp`, status('run-3'));
  await rename(`${statusFile}.tmp`, statusFile);
  assert.equal(await readSlotField('a', 'current_run_id'), 'run-3', 'new inode');
});

test('a gateway write is seen by the next read', async (t) => {
  settledClock(t);
  await writeFile(statusFile, status('run-1'));
  assert.equal((await readSlotRow('a'))?.current_run_id, 'run-1');
  await updateSlotStatus('a', { current_run_id: 'run-4' });
  assert.equal((await readSlotRow('a'))?.current_run_id, 'run-4');
  assert.equal((await readSlotRow('b'))?.current_run_id, null);
});

test('a corrupt status shape throws instead of reading as no row', async (t) => {
  settledClock(t);
  for (const corrupt of ['null', '{"slots":{}}', '{"slots":[null]}']) {
    await writeFile(statusFile, corrupt);
    await assert.rejects(() => readSlotRow('a'), TypeError, corrupt);
  }
});

test('a deleted status file reads as no row, as before', async (t) => {
  settledClock(t);
  await writeFile(statusFile, status('run-1'));
  await readSlotRow('a');
  await rm(statusFile);
  assert.equal(await readSlotRow('a'), null);
  assert.equal(await readSlotField('a', 'current_run_id'), undefined);
});
