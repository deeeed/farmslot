import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const execution = await import('./exec.js');
const background = await import('../host-services/background/client.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const result: ExecResult = { stdout: 'observed', stderr: '', exitCode: 0 };
let directCalls = 0;
let plainLocal = true;
let backgroundActive = true;
const childCalls: Array<{ operation: string; params: unknown }> = [];
mock.module('./exec.js', {
  namedExports: {
    ...execution,
    slotFilesReadInProcess: () => plainLocal,
    execOnSlot: async () => {
      directCalls++;
      return result;
    },
  },
});
mock.module('../host-services/background/client.js', {
  namedExports: {
    ...background,
    backgroundHost: {
      active: () => backgroundActive,
      request: async (operation: string, params: unknown): Promise<ExecResult> => {
        childCalls.push({ operation, params });
        return result;
      },
    },
  },
});
const modulePath: string = './read-probes.js?background-probe-test';
const { readSlotProbe }: typeof import('./read-probes.js') = await import(modulePath);

test('local read probes spawn in the existing background host', async () => {
  const vars = makeVars({
    host: 'localhost',
    machine: 'fixture',
    remoteRepo: '/fixture/background',
  });
  const observed = await readSlotProbe(vars, 'read workspace', 'workspace', 5000);
  assert.deepEqual(observed, result);
  assert.equal(directCalls, 0, 'the request-loop process must not start the command');
  assert.equal(childCalls.length, 1);
});

test('a disabled background host keeps the canonical execution path', async () => {
  backgroundActive = false;
  const before = directCalls;
  const children = childCalls.length;
  await readSlotProbe(makeVars({ remoteRepo: '/fixture/disabled' }), 'read', 'workspace', 5000);
  assert.equal(directCalls, before + 1);
  assert.equal(childCalls.length, children);
  backgroundActive = true;
});

test('owned or node-routed work keeps its authorized executor', async () => {
  plainLocal = false;
  const before = directCalls;
  const children = childCalls.length;
  await readSlotProbe(makeVars({ remoteRepo: '/fixture/owned' }), 'read', 'workspace', 5000);
  assert.equal(directCalls, before + 1);
  assert.equal(childCalls.length, children);
  plainLocal = true;
});
