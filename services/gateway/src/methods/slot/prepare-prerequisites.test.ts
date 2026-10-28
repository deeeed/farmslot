import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { SlotRecovery } from '@farmslot/protocol';

import type { ProjectVars, SlotVars } from '../../core/config.js';

await import('../../runtime/mock-pty.test-support.js');

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
const recovery: SlotRecovery = {
  id: 'fixture-recovery',
  identity: {
    epoch: 1,
    branch: 'main',
    headSha: 'a'.repeat(40),
    dirtyFingerprint: 'clean',
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    recoveryId: null,
  },
  completed: ['inspect', 'cleanup', 'reset', 'fixtures'],
  phase: 'verify',
  error: 'Fixtures did not verify',
};
let recoveryPending = false;
let refused = false;
let transportFailure = false;
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
const executeOnSlot = async (
  _vars: SlotVars,
  command: string,
  options: { selectNodeSupport?: boolean },
) => {
  if (!command.includes('check-configured-paths')) {
    assert.equal(transportFailure, true, 'unexpected execution outside prerequisites');
    return { exitCode: 0, stdout: command === 'echo ok' ? 'ok' : '', stderr: '' };
  }
  calls.push('prerequisites');
  if (transportFailure) throw new Error('node support bundle corrupt');
  assert.match(command, /check-configured-paths/);
  assert.equal(options.selectNodeSupport, false);
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'missing extension checkout on fixture-node, set TERMINAL_EXTENSION_CHECKOUT',
  };
};
const execution = await import('../../core/exec.js');
mock.module('../../core/exec.js', {
  namedExports: { ...execution, execOnSlot: executeOnSlot },
});
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => ({ ...vars, resourceVars: {} }),
    loadProjectVars: async () => project,
    readSlotField: async () => null,
    readSlotRow: async () => (recoveryPending ? { workspace_recovery: recovery } : null),
    execOnSlot: executeOnSlot,
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
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: { ...fleet, loadFleetStatus: async () => ({ slots: [] }) },
});
const { slotPrepare } = await import('./prepare.js');
const { slotCheck } = await import('./check.js');
beforeEach(() => {
  calls = [];
  refused = false;
  transportFailure = false;
  recoveryPending = false;
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

test('slot.check reports a prerequisite transport failure and completes sibling probes', async () => {
  transportFailure = true;
  const events: string[] = [];
  const result = await slotCheck({ slotId: vars.slotId }, (event) => events.push(event));
  assert.deepEqual(
    result.checks.find((step) => step.name === 'prerequisites'),
    {
      name: 'prerequisites',
      status: 'fail',
      detail: 'node support bundle corrupt',
    },
  );
  assert.ok(result.checks.some((step) => step.name === 'tmux'));
  assert.ok(events.includes('slot.check.done'));
});

test('pending workspace recovery refuses prepare before ownership and prerequisite effects', async () => {
  recoveryPending = true;
  await assert.rejects(
    slotPrepare({ slotId: vars.slotId }, () => undefined),
    /Slot recovery must be retried through slot\.refresh/,
  );
  assert.deepEqual(calls, []);
});

test('owner-validated recovery release keeps its internal prepare path', async () => {
  recoveryPending = true;
  await assert.rejects(
    slotPrepare({ slotId: vars.slotId }, () => undefined, undefined, { duringRelease: true }),
    /missing extension checkout/,
  );
  assert.deepEqual(calls, ['ownership', 'prerequisites']);
});
