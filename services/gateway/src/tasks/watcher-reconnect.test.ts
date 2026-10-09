import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { WebSocket } from 'ws';

import type { Run, WorkerSignal } from '@farmslot/protocol';

// Same fixture shape as watcher-blocked-restart.test.ts: a remote slot whose
// files a fake node serves over the real node RPC.
import * as realConfig from '../core/config.js';
import * as realState from '../core/state.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const SLOT_ID = 'mini-farmslot-1';
const MACHINE = 'mini';
const RUN_ID = 'run-blocked-reconnect';
const REPO = '/remote/farmslot-1';
const TASK_DIR = `${REPO}/.task/dev/PROJ-RECONNECT`;
const PRIMARY_SIGNAL = `${TASK_DIR}/SIGNAL.json`;
const REVIEW_SIGNAL = `${TASK_DIR}/SELF-REVIEW-SIGNAL.json`;
const INDEX_FILE = `${TASK_DIR}/subtasks/index.json`;
const contexts = [
  {
    id: 'worker',
    role: 'primary',
    taskFile: `${TASK_DIR}/TASK.md`,
    signalFile: PRIMARY_SIGNAL,
  },
  {
    id: 'reviewer',
    role: 'self-review',
    taskFile: `${TASK_DIR}/SELF-REVIEW.md`,
    signalFile: REVIEW_SIGNAL,
  },
];
const run = () =>
  ({
    id: RUN_ID,
    slotId: SLOT_ID,
    project: 'farmslot',
    flowType: 'dev',
    status: 'blocked',
    taskFile: `${TASK_DIR}/TASK.md`,
    agentContexts: contexts,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0 },
  }) as unknown as Run;

const signal = (contextId: string, status: 'blocked' | 'running'): WorkerSignal => ({
  status,
  attemptId: contextId === 'worker' ? 'a1' : 'r1',
  role: contextId === 'worker' ? 'primary' : 'self-review',
  contextId,
  timestamp: status === 'blocked' ? '2026-10-09T13:10:00Z' : '2026-10-09T13:11:00Z',
});
const files = new Map([
  [`${TASK_DIR}/TASK.md`, '# Task\n\n- [x] **1. work**\n'],
  [`${TASK_DIR}/SELF-REVIEW.md`, '# Review\n\n- [x] **1. check**\n'],
  [PRIMARY_SIGNAL, JSON.stringify(signal('worker', 'blocked'))],
  [REVIEW_SIGNAL, JSON.stringify(signal('reviewer', 'blocked'))],
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
      signalPath: PRIMARY_SIGNAL,
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
          taskFile: 'dev/PROJ-RECONNECT',
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
    listRuns: () => ({ runs: [run()] }),
    getRun: (id: string) => (id === RUN_ID ? run() : undefined),
  },
});
mock.module('../core/state.js', {
  namedExports: { ...realState, updateSlotStatus: async () => {} },
});

const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { handleAgentFsChanged, onWorkerSignal, startWatchingActiveSlots, unwatchSlot } =
  await import('./watcher.js');

interface RpcCall {
  id: string;
  method: string;
  file: string;
}

function fakeNode(holdFinalIndexWatch = false) {
  const calls: RpcCall[] = [];
  const watches = new Map<string, string>();
  let heldRequest: RpcCall | undefined;
  const socket = {
    readyState: 1,
    send: (raw: string) => {
      const { id, method, params } = JSON.parse(raw);
      const file = params.path ?? `${params.root}${params.relPath}`;
      const call = { id, method, file };
      calls.push(call);
      let ok = true;
      let payload: unknown = {};
      let error: string | undefined;
      if (method === 'fs.exists') payload = { exists: files.has(file) };
      else if (method === 'fs.read') {
        if (files.has(file)) payload = { content: files.get(file) };
        else [ok, error] = [false, `ENOENT ${file}`];
      } else if (method === 'fs.watch') {
        watches.set(id, file);
        payload = { watching: true };
        if (holdFinalIndexWatch && file === INDEX_FILE && !heldRequest) {
          heldRequest = call;
          return; // Transport drops before this response reaches the gateway.
        }
      } else if (method === 'fs.watch.stop') {
        payload = { stopped: watches.delete(params.requestId) };
      } else if (method !== 'fs.mkdir') {
        [ok, error] = [false, `Unexpected ${method}`];
      }
      queueMicrotask(() =>
        handleNodeResponse(id, ok, payload, error, undefined, socket as unknown as WebSocket),
      );
    },
  };
  return {
    socket,
    calls,
    watches,
    heldRequest: () => heldRequest,
    disconnect: () => {
      socket.readyState = 3;
      watches.clear(); // services/node/src/index.ts closes all watches on disconnect.
      unregisterByWs(socket as unknown as WebSocket);
    },
    mark: (file: string, content: string): number => {
      files.set(file, content);
      let pushed = 0;
      for (const [requestId, watchPath] of watches) {
        if (watchPath !== file) continue;
        pushed++;
        handleAgentFsChanged({ requestId, machine: MACHINE, path: file, content });
      }
      return pushed;
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test(
  'a reconnect during a pending watch setup rebuilds the primary watch on the new connection',
  { timeout: 4000 },
  async (t) => {
    // Advance the real node RPC deadline without a 30-second wall-clock wait.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const oldNode = fakeNode(true);
    const newNode = fakeNode();
    const scans: Promise<void>[] = [];
    const seen: Array<{ contextId?: string; signal: WorkerSignal }> = [];
    const stop = onWorkerSignal((_slot, _run, workerSignal, _role, contextId) =>
      seen.push({ contextId, signal: workerSignal }),
    );
    t.after(async () => {
      // Release the held request if an assertion failed first. Every other
      // request answers on a microtask, so draining the scans leaves no timers.
      oldNode.disconnect();
      t.mock.timers.tick(30_000);
      try {
        await Promise.allSettled(scans);
        await unwatchSlot(SLOT_ID);
      } finally {
        newNode.disconnect();
        stop();
        t.mock.timers.reset();
      }
    });

    registerNode(MACHINE, 12345, oldNode.socket as unknown as WebSocket);
    scans.push(startWatchingActiveSlots());
    await nextTurn();
    assert.equal(oldNode.heldRequest()?.file, INDEX_FILE);

    // The node reconnects before the old request's 30-second deadline, and
    // registration rebuilds while that setup is still pending.
    oldNode.disconnect();
    registerNode(MACHINE, 12346, newNode.socket as unknown as WebSocket);
    scans.push(startWatchingActiveSlots({ machine: MACHINE }));
    await nextTurn();
    // The rebuild waits for the old setup instead of deduping against it.
    assert.equal(newNode.calls.filter((call) => call.method === 'fs.watch').length, 0);

    t.mock.timers.tick(30_000); // The node RPC deadline rejects the old request.
    await Promise.all(scans);
    assert.ok(
      newNode.calls.some((call) => call.method === 'fs.watch' && call.file === PRIMARY_SIGNAL),
      'the primary signal is watched on the new connection',
    );

    seen.length = 0;
    assert.equal(newNode.mark(PRIMARY_SIGNAL, JSON.stringify(signal('worker', 'running'))), 1);
    await nextTurn();
    assert.deepEqual(
      seen.map((entry) => [entry.contextId, entry.signal.status]),
      [['worker', 'running']],
    );
  },
);
