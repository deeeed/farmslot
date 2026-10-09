import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run, WorkerSignal } from '@farmslot/protocol';

// Same fixture shape as watcher-acceptance.test.ts: the real namespaces are
// spread in and only the slot, fleet and run fixtures are overridden.
import * as realConfig from '../core/config.js';
import * as realState from '../core/state.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const SLOT_ID = 'slot-blocked-restart';
const RUN_ID = 'run-blocked-restart';
const TASK_REL = 'dev/blocked';

const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gw-blocked-restart-'));
const taskDir = path.join(repoRoot, '.task', TASK_REL);

function slotVars() {
  return {
    remoteRepo: repoRoot,
    host: 'localhost',
    machine: 'local',
    sshTarget: '',
    slotId: SLOT_ID,
    projectName: 'farmslot',
  };
}

const blockedRun = () =>
  ({
    id: RUN_ID,
    slotId: SLOT_ID,
    flowType: 'dev',
    project: 'farmslot',
    status: 'blocked',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0 },
  }) as unknown as Run;

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => slotVars(),
    loadProjectVars: async () => ({ projectJson: {} }),
    resolveTaskPaths: async () => ({
      vars: slotVars(),
      taskDirName: '.task',
      taskMdPath: path.join(taskDir, 'TASK.md'),
      signalPath: path.join(taskDir, 'SIGNAL.json'),
    }),
  },
});

// What a fleet refresh shows for a blocked run's slot.
mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: SLOT_ID,
          machine: 'local',
          taskFile: TASK_REL,
          currentRunId: RUN_ID,
          lifecycle: 'held',
          phase: 'pr-watch',
        },
      ],
    }),
    clearTaskProgressOverlay: () => {},
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    listRuns: () => ({ runs: [blockedRun()] }),
    getRun: (id: string) => (id === RUN_ID ? blockedRun() : undefined),
  },
});

mock.module('../core/state.js', {
  namedExports: { ...realState, updateSlotStatus: async () => {} },
});

const { onWorkerSignal, startWatchingActiveSlots, unwatchSlot } = await import('./watcher.js');

test('a restart reads a blocked run signal the worker wrote while the gateway was down', async (t) => {
  t.after(async () => {
    await unwatchSlot(SLOT_ID);
    rmSync(repoRoot, { recursive: true, force: true });
  });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, 'TASK.md'), '# Task\n\n- [x] **1. build it**\n');
  const resumed = {
    status: 'running',
    attemptId: 'a1',
    step: 'build it',
    timestamp: '2026-10-09T13:10:00Z',
  };
  writeFileSync(path.join(taskDir, 'SIGNAL.json'), `${JSON.stringify(resumed)}\n`);

  const seen: Array<{ runId: string | null; signal: WorkerSignal }> = [];
  const stop = onWorkerSignal((_slotId, runId, signal) => seen.push({ runId, signal }));
  t.after(stop);

  await startWatchingActiveSlots();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runId, RUN_ID);
  assert.equal(seen[0].signal.status, 'running');
  assert.equal(seen[0].signal.attemptId, 'a1');
});
