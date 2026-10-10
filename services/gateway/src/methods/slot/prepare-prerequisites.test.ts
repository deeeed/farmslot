import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { ProjectVars, SlotVars } from '../../core/config.js';

// All execution and lifecycle mutations are stubbed. No filesystem or tmux writes.
const vars: SlotVars = {
  slotId: 'fixture-slot',
  machine: 'fixture-node',
  host: 'remote',
  repo: '/slot',
  remoteRepo: '/slot',
  platform: 'web',
  sshUser: 'fixture',
  osType: 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'fixture-session',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'fixture@remote',
  projectName: 'fixture-project',
  resourceVars: {},
};
const project: ProjectVars = {
  projectName: vars.projectName,
  projectConfig: '/project/project.json',
  projectFixturesDir: '/project/fixtures',
  projectTemplatesDir: '/project/templates',
  runtimeDir: '.agent',
  artifactDir: '.agent/artifacts',
  projectJson: { hooks: { prerequisites: 'check-configured-paths' } },
};
let refused = false;
let calls: string[] = [];
// Mock before loading the native worker graph, which imports prepare during recovery.
mock.module('../../runners/native/worker.js', {
  namedExports: {
    assertNativeSlotReplacementOwner: () => {
      calls.push('ownership');
      if (refused) throw new Error('slot belongs to another native run');
    },
    retireNativeWorkersForSlot: async () => {
      calls.push('retire');
      throw new Error('unexpected retirement');
    },
    cancelNativeWorkerContext: async () => {
      throw new Error('unexpected cancel');
    },
    cancelNativeRunWorkers: async () => {
      throw new Error('unexpected cancel');
    },
    dispatchNativeWorker: async () => {
      throw new Error('unexpected dispatch');
    },
  },
});
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => ({ ...vars, resourceVars: {} }),
    loadProjectVars: async () => project,
    readSlotField: async () => null,
    execOnSlot: async (
      _vars: SlotVars,
      command: string,
      options: { selectNodeSupport?: boolean },
    ) => {
      calls.push('prerequisites');
      assert.match(command, /check-configured-paths/);
      assert.equal(options.selectNodeSupport, false);
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'missing extension checkout on fixture-node, set TERMINAL_EXTENSION_CHECKOUT',
      };
    },
    slotWriteFiles: async () => {
      throw new Error('unexpected slot write');
    },
  },
});
const tracking = await import('./slot-tracking.js');
mock.module('./slot-tracking.js', {
  namedExports: { ...tracking, assertSlotNotOperatorRoot: async () => undefined },
});
const sentinel = await import('./prepare-sentinel.js');
mock.module('./prepare-sentinel.js', {
  namedExports: {
    ...sentinel,
    acquirePrepareSentinel: async () => {
      calls.push('sentinel');
      throw new Error('unexpected sentinel');
    },
  },
});
const { slotPrepare } = await import('./prepare.js');
beforeEach(() => {
  calls = [];
  refused = false;
});

test('failed prerequisites stop prepare before slot selection, retirement and checkout phases', async () => {
  await assert.rejects(
    slotPrepare({ slotId: vars.slotId }, () => undefined),
    /missing extension checkout/,
  );
  assert.deepEqual(calls, ['ownership', 'prerequisites']);
});
test('refused ownership never delivers or selects prerequisite support', async () => {
  refused = true;
  await assert.rejects(
    slotPrepare({ slotId: vars.slotId }, () => undefined),
    /belongs to another native run/,
  );
  assert.deepEqual(calls, ['ownership']);
});
