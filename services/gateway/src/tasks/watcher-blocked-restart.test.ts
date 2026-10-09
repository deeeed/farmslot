import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { WebSocket } from 'ws';

import type { Run, WorkerSignal } from '@farmslot/protocol';

// Same fixture shape as watcher-acceptance.test.ts: the real namespaces are
// spread in and only the slot, fleet and run fixtures are overridden. The slot
// is remote, so its files are served by a fake node over the real node RPC.
import * as realConfig from '../core/config.js';
import * as realState from '../core/state.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const SLOT_ID = 'mini-farmslot-1';
const MACHINE = 'mini';
const RUN_ID = 'run-blocked-restart';
const REPO = '/remote/farmslot-1';
const TASK_DIR = `${REPO}/.task/dev/PROJ-RESTART`;

const contexts = [
  {
    id: 'worker',
    role: 'primary',
    taskFile: `${TASK_DIR}/TASK.md`,
    signalFile: `${TASK_DIR}/SIGNAL.json`,
  },
  {
    id: 'reviewer',
    role: 'self-review',
    taskFile: `${TASK_DIR}/SELF-REVIEW.md`,
    signalFile: `${TASK_DIR}/SELF-REVIEW-SIGNAL.json`,
  },
];
let runStatus = 'blocked';
let lifecycle = 'held';
let phase = 'pr-watch';

const run = () =>
  ({
    id: RUN_ID,
    slotId: SLOT_ID,
    project: 'farmslot',
    flowType: 'dev',
    status: runStatus,
    taskFile: `${TASK_DIR}/TASK.md`,
    agentContexts: contexts,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0 },
  }) as unknown as Run;

const files = new Map([
  [`${TASK_DIR}/TASK.md`, '# Task\n\n- [x] **1. work**\n'],
  [`${TASK_DIR}/SELF-REVIEW.md`, '# Review\n\n- [x] **1. check**\n'],
  [
    `${TASK_DIR}/SIGNAL.json`,
    JSON.stringify({
      status: 'running',
      attemptId: 'a1',
      timestamp: '2026-10-09T13:10:00Z',
      role: 'primary',
      contextId: 'worker',
    }),
  ],
  [
    `${TASK_DIR}/SELF-REVIEW-SIGNAL.json`,
    JSON.stringify({
      status: 'running',
      attemptId: 'r1',
      timestamp: '2026-10-09T13:11:00Z',
      role: 'self-review',
      contextId: 'reviewer',
    }),
  ],
]);

const slotVars = () => ({
  remoteRepo: REPO,
  host: 'mini.local',
  machine: MACHINE,
  sshTarget: 'mini.local',
  slotId: SLOT_ID,
  projectName: 'farmslot',
});

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => slotVars(),
    loadProjectVars: async () => ({ projectJson: {} }),
    resolveTaskPaths: async () => ({
      vars: slotVars(),
      taskDirName: '.task',
      taskMdPath: `${TASK_DIR}/TASK.md`,
      signalPath: `${TASK_DIR}/SIGNAL.json`,
    }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: SLOT_ID,
          machine: MACHINE,
          taskFile: 'dev/PROJ-RESTART',
          currentRunId: RUN_ID,
          lifecycle,
          phase,
        },
      ],
    }),
    clearTaskProgressOverlay: () => {},
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    listRuns: () => ({ runs: [run()] }),
    getRun: (id: string) => (id === RUN_ID ? run() : undefined),
  },
});

mock.module('../core/state.js', {
  namedExports: { ...realState, updateSlotStatus: async () => {} },
});

const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { onWorkerSignal, startWatchingActiveSlots, unwatchSlot } = await import('./watcher.js');

/** A node that serves `files` and accepts watches, answering each request on the next tick. */
const calls: Array<{ method: string; file: string }> = [];
const node = {
  readyState: 1,
  send: (raw: string) => {
    const { id, method, params } = JSON.parse(raw);
    const file = params.path ?? `${params.root}${params.relPath}`;
    calls.push({ method, file });
    let ok = true;
    let payload: unknown = {};
    let error: string | undefined;
    if (method === 'fs.exists') payload = { exists: files.has(file) };
    else if (method === 'fs.read') {
      if (files.has(file)) payload = { content: files.get(file) };
      else [ok, error] = [false, `ENOENT ${file}`];
    } else if (method === 'fs.watch') payload = { watching: true };
    else if (method !== 'fs.mkdir' && method !== 'fs.watch.stop')
      [ok, error] = [false, `Unexpected ${method}`];
    queueMicrotask(() =>
      handleNodeResponse(id, ok, payload, error, undefined, node as unknown as WebSocket),
    );
  },
};

const signalReads = () =>
  calls.filter((call) => call.method === 'fs.read' && call.file.endsWith('SIGNAL.json')).length;

test('a node that registers after startup gets its task watches and the blocked signal read', async (t) => {
  const seen: Array<{ runId: string | null; contextId?: string; signal: WorkerSignal }> = [];
  const stop = onWorkerSignal((_slotId, runId, signal, _role, contextId) =>
    seen.push({ runId, contextId, signal }),
  );
  t.after(async () => {
    await unwatchSlot(SLOT_ID);
    unregisterByWs(node as unknown as WebSocket);
    stop();
  });

  // Startup with the node absent: nothing can be watched or read yet.
  await startWatchingActiveSlots();
  assert.equal(calls.length, 0);

  // What node registration now does for that machine.
  registerNode(MACHINE, 12345, node as unknown as WebSocket);
  await startWatchingActiveSlots({ machine: MACHINE });
  assert.deepEqual(
    seen.map((entry) => [entry.runId, entry.contextId, entry.signal.attemptId]),
    [
      [RUN_ID, 'worker', 'a1'],
      [RUN_ID, 'reviewer', 'r1'],
    ],
  );
  const watches = calls.filter((call) => call.method === 'fs.watch').length;
  assert.ok(watches > 0);

  // A reconnect rebuilds the watches its previous connection held.
  calls.length = 0;
  await startWatchingActiveSlots({ machine: MACHINE });
  assert.ok(calls.some((call) => call.method === 'fs.watch.stop'));
  assert.equal(calls.filter((call) => call.method === 'fs.watch').length, watches);

  // A run that is not blocked gets its watches but no signal read.
  calls.length = 0;
  seen.length = 0;
  [runStatus, lifecycle, phase] = ['monitoring', 'busy', 'working'];
  await startWatchingActiveSlots({ machine: MACHINE });
  assert.ok(calls.some((call) => call.method === 'fs.watch'));
  assert.equal(signalReads(), 0);
  assert.equal(seen.length, 0);
});
