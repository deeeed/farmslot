import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

let next = { exitCode: 0, stdout: '', stderr: '' };
mock.module('../core/exec.js', { namedExports: { execOnSlot: async () => next } });

const { probeResourceProcess } = await import('./resource-process.js');
const vars = { slotId: 'slot-1', machine: 'node-1', host: 'node-1' } as SlotVars;

test('only a silent ps exit reports the provider process gone', async () => {
  next = { exitCode: 0, stdout: '52393 52393 Sat Oct 31 05:32:14 2026\n', stderr: '' };
  assert.deepEqual(await probeResourceProcess(vars, 52393), {
    pid: 52393,
    group: 52393,
    identity: 'Sat Oct 31 05:32:14 2026',
  });
  next = { exitCode: 1, stdout: '', stderr: '' };
  assert.equal(await probeResourceProcess(vars, 52393), undefined);
  // A node at its process limit fails to spawn ps with exit 1 too; that proves nothing.
  next = { exitCode: 1, stdout: '', stderr: '\nspawn error: spawn EAGAIN' };
  await assert.rejects(probeResourceProcess(vars, 52393), /identity capture failed/);
});
