import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ExecResult } from '@farmslot/protocol';
import type { SlotVars } from '../../core/index.js';

let result: ExecResult;
let cwd: string | undefined;
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    execArgvOnSlot: async (_vars: unknown, _argv: string[], opts: { cwd?: string }) => {
      cwd = opts.cwd;
      return result;
    },
    execOnSlot: async (_vars: unknown, _cmd: string, opts: { cwd?: string }) => {
      cwd = opts.cwd;
      return result;
    },
  },
});
const { checkPrepareDevice } = await import('./prepare-device.js');
const vars: SlotVars = {
  slotId: 'test-slot',
  host: 'localhost',
  sshUser: 'test',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/missing',
  remoteRepo: '/missing',
  session: 'test-slot',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  projectName: 'test',
  platform: 'ios',
  machine: 'test-node',
  resourceVars: { simulator: 'mm-3' },
};

test('simulator enumeration failures retain their cause and use an independent cwd', async () => {
  result = { stdout: '', stderr: 'CoreSimulator service unavailable', exitCode: 1 };
  await assert.rejects(
    checkPrepareDevice(vars),
    /inventory failed.*CoreSimulator service unavailable/,
  );
  assert.equal(cwd, '/');
});
test('simulator lookup distinguishes unavailable, missing and malformed inventory', async () => {
  result = { stdout: '{', stderr: '', exitCode: 0 };
  await assert.rejects(checkPrepareDevice(vars), SyntaxError);
  result.stdout = JSON.stringify({ devices: [] });
  await assert.rejects(checkPrepareDevice(vars), /Invalid simulator inventory/);
  result.stdout = JSON.stringify({ devices: { ios: [] } });
  await assert.rejects(checkPrepareDevice(vars), /not found/);
  result.stdout = JSON.stringify({
    devices: { ios: [{ name: 'mm-3', isAvailable: false, availabilityError: 'runtime removed' }] },
  });
  await assert.rejects(checkPrepareDevice(vars), /unavailable.*runtime removed/);
  result.stdout = JSON.stringify({ devices: { ios: [{ name: 'mm-3', isAvailable: true }] } });
  assert.equal(await checkPrepareDevice(vars), 'Simulator mm-3 found');
});
test('AVD lookup reports command failures separately from an absent exact name', async () => {
  const android = { ...vars, platform: 'android', resourceVars: { avd: 'farm' } } as SlotVars;
  result = { stdout: '', stderr: 'Java missing', exitCode: 127 };
  await assert.rejects(checkPrepareDevice(android), /inventory failed.*Java missing/);
  assert.equal(cwd, '/');
  result = { stdout: 'farm-2\r\n', stderr: '', exitCode: 0 };
  await assert.rejects(checkPrepareDevice(android), /not found/);
  result.stdout = 'farm\r\n';
  assert.equal(await checkPrepareDevice(android), 'AVD farm found');
});
