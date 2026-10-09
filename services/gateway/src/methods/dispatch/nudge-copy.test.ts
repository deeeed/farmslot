import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// mock.module replaces a module wholesale; spreading the real namespaces keeps
// every export the import graph needs and overrides only what this test fixes.
import * as realCore from '../../core/index.js';
import { fakeSshTools } from '../../core/ssh-test-fixtures.js';
import * as realFleetState from '../../fleet/state.js';
import * as realRegistry from '../../runners/registry.js';
import * as realRunStore from '../../runs/store.js';
import * as realSidecars from '../../tasks/sidecars.js';

import * as realPreview from './preview.js';

const tools = fakeSshTools();
after(() => tools.cleanup());

const SSH_TARGET = 'operator@fake-remote.invalid';
const REMOTE_REPO = '/remote/repo';
const SLOT_ID = 'fake-remote-mm-1';
const taskDir = path.join(tools.root, 'tasks', 'pr-complete', 'T-1');
const taskFile = path.join(taskDir, 'TASK.md');
const slotCommands: string[] = [];
const STOP = 'stop after the TASK.md copy';

mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({
      host: 'fake-remote.invalid',
      machine: 'fake-remote',
      sshTarget: SSH_TARGET,
      remoteRepo: REMOTE_REPO,
      projectName: 'demo',
      slotMode: 'pool',
    }),
    loadProjectVars: async () => ({ projectJson: {} }),
    readSlotField: async (_slot: string, field: string) => (field === 'runner' ? 'claude' : null),
    execOnSlot: async (_vars: unknown, cmd: string) => {
      slotCommands.push(cmd);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    // Real bash, with ssh/scp/rsync resolving to the recording stand-ins.
    execLocal: (cmd: string, opts?: realCore.ExecOptions) =>
      realCore.execLocal(tools.withFakePath(cmd), opts),
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({ slots: [{ slot: SLOT_ID, branch: 'fix/x' }] }),
  },
});
mock.module('../../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) =>
      id === 'run-1' ? { id, project: 'demo', transport: 'tmux', branch: 'fix/x' } : undefined,
    getAllRuns: () => [],
  },
});
mock.module('./preview.js', {
  namedExports: { ...realPreview, verifyBranchAffinityNudgeStillEligible: async () => null },
});
mock.module('../../runners/registry.js', {
  namedExports: { ...realRegistry, runnerSupportsTmuxNudges: () => true },
});
// The sidecar copy is covered with task-sync; stopping here keeps the nudge
// from reaching the runner.
mock.module('../../tasks/sidecars.js', {
  namedExports: {
    ...realSidecars,
    copyPreparedTaskRootSidecars: async () => {
      throw new Error(STOP);
    },
  },
});

// The real namespaces above already evaluated nudge.js through the dispatch
// graph, against the real modules; a fresh instance imports the mocks.
const fresh: string = './nudge.js?mocked';
const { nudgeDispatch } = (await import(fresh)) as typeof import('./nudge.js');

test('the nudge copies TASK.md to a remote slot with scp ConnectTimeout=10 and BatchMode=yes', async () => {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(taskFile, '# Task\n');

  await assert.rejects(
    nudgeDispatch(
      { slotId: SLOT_ID, taskFile, runId: 'run-1', ticketOrPr: '42', flowType: 'pr-complete' },
      () => {},
    ),
    new RegExp(STOP),
  );

  const workerTaskAbs = `${REMOTE_REPO}/.task/pr-complete/T-1`;
  assert.deepEqual(slotCommands, [`mkdir -p '${workerTaskAbs}'`]);
  assert.deepEqual(tools.calls(), [
    [
      'scp',
      '-q',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'BatchMode=yes',
      taskFile,
      `${SSH_TARGET}:${workerTaskAbs}/TASK.md`,
    ],
  ]);
});
