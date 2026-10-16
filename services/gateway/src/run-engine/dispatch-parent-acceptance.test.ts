import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const slotBinding = await import('../runs/slot-binding.js');
const capabilities = await import('./declared-capabilities.js');
const dispatch = await import('../methods/dispatch.js');
const inherited = await import('../run-completion/inherited-acceptance.js');
const { makeRun } = await import('./test-fixtures.js');

let current: Run;
let staged = 0;
let effects = 0;
const refusal = new Error('Parent proof qualification refused');
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
const unexpectedEffect = async () => {
  effects++;
  throw new Error('Worker delivery must wait for parent proof staging');
};
mock.module('./declared-capabilities.js', {
  namedExports: { ...capabilities, prepareConfiguredRunCapabilities: unexpectedEffect },
});
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...dispatch,
    dispatchExecute: unexpectedEffect,
    nudgeDispatch: unexpectedEffect,
    warmSessionHandoffDispatch: unexpectedEffect,
  },
});
mock.module('../run-completion/inherited-acceptance.js', {
  namedExports: {
    ...inherited,
    stageInheritedAcceptance: async (run: Run, slot: SlotVars) => {
      assert.equal(run, current);
      assert.equal(slot, vars);
      staged++;
      throw refusal;
    },
  },
});
const freshModule: string = './dispatch-lifecycle-steps.js?parent-acceptance-caller';
const { executeDispatchStep } = (await import(
  freshModule
)) as typeof import('./dispatch-lifecycle-steps.js');

for (const mode of ['fresh', 'native', 'warm', 'nudge'] as const) {
  test(`normal ${mode} engine dispatch stages parent proof before delivering the worker`, async () => {
    current = makeRun({
      id: `child-${mode}`,
      flowType: 'pr-complete',
      parentRunId: 'parent',
      slotId: vars.slotId,
      taskFile: '/tasks/followup/TASK.md',
      engineState: {
        flags: {
          skipPrepare: true,
          ...(mode === 'warm' ? { warmSessionReuse: true } : {}),
          ...(mode === 'nudge' ? { nudgeReuse: true } : {}),
        },
      },
    });
    if (mode === 'native') current.transport = 'native';
    staged = 0;
    effects = 0;
    await assert.rejects(
      executeDispatchStep(current.id, {
        stepPartialIO: new Map(),
        blockedRunError: (message) => new Error(message),
      }),
      (error) => error === refusal,
    );
    assert.equal(staged, 1);
    assert.equal(effects, 0);
  });
}
