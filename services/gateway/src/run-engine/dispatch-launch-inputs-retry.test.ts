import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const slotBinding = await import('../runs/slot-binding.js');
const dispatch = await import('../methods/dispatch.js');
const { WorkerLaunchInputsChangedError } = await import('./worker-launch-preflight.js');
const { makeRun } = await import('./test-fixtures.js');

let current: Run;
let attempts = 0;
let outcomes: Error[] = [];
const stop = new Error('Stop after the dispatch attempt');
const vars: SlotVars = {
  slotId: 'fixture',
  host: 'localhost',
  machine: 'local',
  platform: 'cli',
  sshUser: 'test',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/fixture',
  remoteRepo: '/fixture',
  session: 'fixture',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'localhost',
  projectName: 'example',
  resourceVars: {},
};
mock.module('../core/config.js', { namedExports: { ...config, loadSlotVars: async () => vars } });
mock.module('../runs/slot-binding.js', {
  namedExports: { ...slotBinding, ensureRunSlotBinding: () => current },
});
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...dispatch,
    dispatchExecute: async () => {
      attempts++;
      throw outcomes.shift() ?? stop;
    },
  },
});
const freshModule: string = './dispatch-lifecycle-steps.js?launch-inputs-retry';
const { executeDispatchStep } = (await import(
  freshModule
)) as typeof import('./dispatch-lifecycle-steps.js');

const dispatchOnce = () => {
  current = makeRun({
    id: `launch-inputs-${attempts}`,
    flowType: 'dev',
    slotId: vars.slotId,
    taskFile: '/tasks/dev/TASK.md',
    engineState: { flags: { skipPrepare: true } },
  });
  return executeDispatchStep(current.id, {
    stepPartialIO: new Map(),
    blockedRunError: (message) => new Error(message),
  });
};

test('a launch whose configured inputs changed during preflight is dispatched once more', async () => {
  // F296: the 0.94.9 pool rewrite landed during two live preflights, which refused (nothing
  // launched). The engine re-reads the inputs and checks again instead of failing the run.
  attempts = 0;
  outcomes = [new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight')];
  await assert.rejects(dispatchOnce(), (error) => error === stop);
  assert.equal(attempts, 2, 'the second attempt re-reads and dispatches');
});

test('a second change in a row still refuses', async () => {
  attempts = 0;
  outcomes = [
    new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight'),
    new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight'),
  ];
  await assert.rejects(dispatchOnce(), WorkerLaunchInputsChangedError);
  assert.equal(attempts, 2);
});
