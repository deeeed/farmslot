import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'status-commit-race-')));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
for (const dir of ['pool', 'runs', 'home', 'projects']) await fs.mkdir(path.join(root, dir));
after(() => fs.rm(root, { recursive: true, force: true }));

// Runs once right after the next rename onto the status file, before the writer stats it.
let afterStatusRename: (() => Promise<void>) | undefined;
let statusReads = 0;
const rename = fs.rename;
const readFile = fs.readFile;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await rename(...args);
      if (args[1] === process.env.FARMSLOT_TEST_STATUS_FILE && afterStatusRename) {
        const edit = afterStatusRename;
        afterStatusRename = undefined;
        await edit();
      }
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === process.env.FARMSLOT_TEST_STATUS_FILE) statusReads++;
      return readFile(...args);
    },
  },
});
const state = await import('../core/state.js');
const { loadFleetStatus } = await import('./state.js');

const rows = (owner: string) => ({ slots: [{ slot: 'proof', current_run_id: owner }] });

test('an outside edit landing between the gateway rename and its stat is read, not cached over', async () => {
  await state.rewriteStatusFile(() => rows('before-race'));
  afterStatusRename = () =>
    fs.writeFile(state.statusFile, JSON.stringify(rows('outside-in-the-gap')));
  await state.updateSlotStatus('proof', { current_run_id: 'gateway-commit' });
  assert.equal(afterStatusRename, undefined, 'the edit ran inside the commit');
  statusReads = 0;
  const fleet = await loadFleetStatus(true, true);
  assert.equal(fleet.slots[0]?.currentRunId, 'outside-in-the-gap');
  assert.equal(statusReads, 1);
});
