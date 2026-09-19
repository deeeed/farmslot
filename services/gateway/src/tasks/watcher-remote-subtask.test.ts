import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// See replay-step-nested-checklist.test.ts: mock.module replaces a module
// wholesale, so the real namespaces are spread in and only the fixtures these
// tests need are overridden.
import * as realConfig from '../core/config.js';
import * as realSlotIo from '../core/slot-io.js';
import * as realState from '../core/state.js';
import * as realMachineRegistry from '../fleet/machine-registry.js';
import * as realNodeRpc from '../fleet/node-rpc.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const SLOT_ID = 'slot-remote-subtask';
const RUN_ID = 'run-remote-subtask';
const TASK_REL = 'dev/demo';
const MACHINE = 'remote-machine';

let repoRoot = '';

/** Every fs.watch the gateway asked the node to open, in order. */
interface WatchCall {
  requestId: string;
  path: string;
}
let watchCalls: WatchCall[] = [];
let stopCalls: string[] = [];
let requestCounter = 0;

function taskDirAbs(): string {
  return path.join(repoRoot, '.task', TASK_REL);
}

function slotVars() {
  return {
    remoteRepo: repoRoot,
    // A remote slot: not localhost, and the machine is not this host.
    host: 'remote-host',
    machine: MACHINE,
    sshTarget: 'user@remote-host',
    slotId: SLOT_ID,
    projectName: 'farmslot',
  };
}

const activeRun = () =>
  ({
    id: RUN_ID,
    slotId: SLOT_ID,
    flowType: 'dev',
    project: 'farmslot',
    status: 'monitoring',
    taskFile: path.join(taskDirAbs(), 'TASK.md'),
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
      taskMdPath: path.join(taskDirAbs(), 'TASK.md'),
      signalPath: path.join(taskDirAbs(), 'SIGNAL.json'),
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
          taskFile: TASK_REL,
          currentRunId: RUN_ID,
          lifecycle: 'busy',
          phase: 'working',
        },
      ],
    }),
    clearTaskProgressOverlay: () => {},
  },
});

// The subject is the WATCH transport (fs.watch / fs.watch.stop request-id
// bookkeeping), not slot-io. Serving slot-io's file reads from the local temp
// directory keeps this test on the watcher and off the byte-transfer layer.
mock.module('../core/slot-io.js', {
  namedExports: {
    ...realSlotIo,
    slotFileExists: async (_ctx: unknown, filePath: string) => existsSync(filePath),
    slotReadFile: async (_ctx: unknown, filePath: string) => readFileSync(filePath, 'utf-8'),
    slotMkdir: async (_ctx: unknown, dirPath: string) => {
      mkdirSync(dirPath, { recursive: true });
    },
  },
});

mock.module('../fleet/machine-registry.js', {
  namedExports: {
    ...realMachineRegistry,
    // A connected node stands in for the real WebSocket peer.
    getNode: (machine: string) => (machine === MACHINE ? { machine } : undefined),
  },
});

mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...realNodeRpc,
    sendNodeRequest: async (
      _node: unknown,
      method: string,
      params: unknown,
      opts?: { onRequestId?: (id: string) => void },
    ) => {
      if (method === 'fs.watch') {
        requestCounter += 1;
        const requestId = `req-${requestCounter}`;
        const watched = (params as { path: string }).path;
        // The gateway records the id through this callback, exactly as the real
        // transport hands it back before the response arrives.
        opts?.onRequestId?.(requestId);
        watchCalls.push({ requestId, path: watched });
        return { watching: true };
      }
      if (method === 'fs.watch.stop') {
        stopCalls.push((params as { requestId: string }).requestId);
        return { stopped: true };
      }
      // Nothing else should reach the node: slot-io is mocked to the local
      // filesystem, so any other method here is the watcher taking a path this
      // test did not intend.
      throw new Error(`unexpected node method ${method}`);
    },
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    listRuns: () => ({ runs: [activeRun()] }),
    getRun: (id: string) => (id === RUN_ID ? activeRun() : undefined),
  },
});

mock.module('../core/state.js', {
  namedExports: { ...realState, updateSlotStatus: async () => {} },
});

const { handleAgentFsChanged, onTaskProgress, unwatchSlot, watchSlot } =
  await import('./watcher.js');

const PARENT_MARKDOWN = [
  '- [x] **1. read the ticket**',
  '- [ ] **2. run the review skill**',
  '',
].join('\n');
const CHILD_MARKDOWN = ['- [ ] **1. read the diff**', '- [ ] **2. check the patterns**', ''].join(
  '\n',
);

const progressUpdates: Array<{ parentChecklist?: string }> = [];
onTaskProgress((_slotId, _progress, _role, _contextId, _runId, parentChecklist) => {
  progressUpdates.push({ ...(parentChecklist ? { parentChecklist } : {}) });
});

/**
 * The slot's files are local to this test process even though the slot is
 * declared remote: only the WATCH transport is under test, and slot-io reads go
 * through the mocked node too, so the task dir must exist for the reads the
 * watcher performs after an event.
 */
function writeTaskDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-remote-subtask-'));
  repoRoot = root;
  const dir = taskDirAbs();
  mkdirSync(path.join(dir, 'subtasks'), { recursive: true });
  writeFileSync(path.join(dir, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(dir, 'CHECKLIST.md'), PARENT_MARKDOWN);
  writeFileSync(path.join(dir, 'SIGNAL.json'), '{"status":"running","timestamp":"x"}\n');
  return root;
}

function unitEntry(id: string, stepNumber: number) {
  return {
    id,
    parent: { checklist: 'CHECKLIST.md', stepNumber },
    checklist: `subtasks/${id}.md`,
    signal: `subtasks/${id}-SIGNAL.json`,
    source: { kind: 'skill', ref: 'skills/r.md', sha256: 'aa', renderedSha256: 'bb' },
    registeredAt: '2026-09-19T10:00:00Z',
  };
}

function writeRegistry(dir: string, ids: Array<{ id: string; step: number }>): string {
  const body = `${JSON.stringify({
    schemaVersion: 1,
    units: ids.map((entry) => unitEntry(entry.id, entry.step)),
  })}\n`;
  writeFileSync(path.join(dir, 'subtasks', 'index.json'), body);
  for (const entry of ids) {
    writeFileSync(path.join(dir, 'subtasks', `${entry.id}.md`), CHILD_MARKDOWN);
    writeFileSync(
      path.join(dir, 'subtasks', `${entry.id}-SIGNAL.json`),
      `${JSON.stringify({
        role: 'subtask',
        contextId: entry.id,
        parent: { checklist: 'CHECKLIST.md', stepNumber: entry.step },
        status: 'running',
        timestamp: '2026-09-19T10:00:00Z',
      })}\n`,
    );
  }
  return body;
}

function watchedPathsUnder(dir: string): string[] {
  return watchCalls
    .map((call) => path.relative(dir, call.path))
    .filter((rel) => !rel.startsWith('..'))
    .sort();
}

test('a remote watch registers the registry and every child file, and unwatch stops each id', async () => {
  const root = writeTaskDir();
  const dir = taskDirAbs();
  watchCalls = [];
  stopCalls = [];
  progressUpdates.length = 0;
  const registry = writeRegistry(dir, [{ id: 'perps-review', step: 2 }]);

  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });

    // The parent pair, the acceptance ledger (ADR-060 phase 5) and the registry go
    // up at watch setup. The registry was already on disk, so the initial read
    // wires the child pair too — a node's fs.watch reports changes only, so
    // without that read a gateway restart mid-run would never watch an existing
    // child.
    assert.deepEqual(watchedPathsUnder(dir), [
      'CHECKLIST.md',
      'SIGNAL.json',
      'artifacts/acceptance-status.json',
      'subtasks/index.json',
      'subtasks/perps-review-SIGNAL.json',
      'subtasks/perps-review.md',
    ]);
    // Every registration recorded a distinct request id.
    assert.equal(new Set(watchCalls.map((call) => call.requestId)).size, watchCalls.length);

    // A child file event routes by the id it was opened with and produces a
    // progress update tagged with the parent checklist.
    const childSignalCall = watchCalls.find((call) =>
      call.path.endsWith('perps-review-SIGNAL.json'),
    );
    assert.ok(childSignalCall);
    handleAgentFsChanged({
      requestId: childSignalCall.requestId,
      machine: MACHINE,
      path: childSignalCall.path,
      content: '{"status":"running","timestamp":"y"}',
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.ok(
      progressUpdates.some((update) => update.parentChecklist === 'CHECKLIST.md'),
      'a remote child event emits a child-tagged progress update',
    );

    // ── rebind: the registry gains a second unit ──
    const firstChildIds = watchCalls
      .filter((call) => call.path.includes(`${path.sep}subtasks${path.sep}perps-review`))
      .map((call) => call.requestId);
    assert.equal(firstChildIds.length, 2);
    const registryCall = watchCalls.find((call) => call.path.endsWith('index.json'));
    assert.ok(registryCall);

    watchCalls = [];
    const nextRegistry = writeRegistry(dir, [
      { id: 'perps-review', step: 2 },
      { id: 'evidence-pack', step: 1 },
    ]);
    assert.notEqual(registry, nextRegistry);
    handleAgentFsChanged({
      requestId: registryCall.requestId,
      machine: MACHINE,
      path: registryCall.path,
      content: nextRegistry,
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));

    // The rebind stopped the previous unit watches and opened four: two per unit.
    for (const requestId of firstChildIds) {
      assert.ok(stopCalls.includes(requestId), `rebind must stop stale unit watch ${requestId}`);
    }
    assert.deepEqual(watchedPathsUnder(dir), [
      'subtasks/evidence-pack-SIGNAL.json',
      'subtasks/evidence-pack.md',
      'subtasks/perps-review-SIGNAL.json',
      'subtasks/perps-review.md',
    ]);
    // The registry and parent watches are NOT reopened by a rebind.
    assert.equal(
      watchCalls.some((call) => call.path.endsWith('index.json')),
      false,
    );

    const liveUnitIds = watchCalls.map((call) => call.requestId);
    stopCalls = [];
    await unwatchSlot(SLOT_ID);

    // Teardown stops every id still registered: the parent pair, the registry,
    // and the four unit watches the rebind installed.
    assert.ok(stopCalls.includes(registryCall.requestId), 'unwatch stops the registry watch');
    for (const requestId of liveUnitIds) {
      assert.ok(stopCalls.includes(requestId), `unwatch stops unit watch ${requestId}`);
    }
    assert.equal(new Set(stopCalls).size, stopCalls.length, 'no id is stopped twice');
  } finally {
    // Safety net for the failure path: the success path already awaited an
    // unwatch above, so this only does work when an assertion threw. A failure
    // here is reported at error level rather than swallowed — but NOT rethrown,
    // because a throw from `finally` replaces the assertion error that actually
    // explains the test, and a leaked watch would then hide its own cause.
    try {
      await unwatchSlot(SLOT_ID);
    } catch (err) {
      console.error(`[test] teardown unwatch failed for ${SLOT_ID}: ${(err as Error).message}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
