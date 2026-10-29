import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { RecipeClaimLedger, Run, TaskProgressResult } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

// See replay-step-nested-checklist.test.ts: mock.module replaces a module
// wholesale, so the real namespaces are spread in and only the fixtures these
// tests need are overridden.
import * as realConfig from '../core/config.js';
import * as realSlotIo from '../core/slot-io.js';
import * as realState from '../core/state.js';
import * as realMachineRegistry from '../fleet/machine-registry.js';
import * as realNodeRpc from '../fleet/node-rpc.js';
import * as realFleetState from '../fleet/state.js';
import * as realFileObservations from '../resources/node-file-observations.js';
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
/** While set, parent checklist reads wait on it, standing in for a loaded node. */
let checklistReadGate: Promise<void> | undefined;
let checklistReadsInFlight = 0;
let maxChecklistReadsInFlight = 0;

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
    slotReadFile: async (_ctx: unknown, filePath: string) => {
      if (checklistReadGate && filePath.endsWith('CHECKLIST.md')) {
        checklistReadsInFlight += 1;
        maxChecklistReadsInFlight = Math.max(maxChecklistReadsInFlight, checklistReadsInFlight);
        try {
          await checklistReadGate;
        } finally {
          checklistReadsInFlight -= 1;
        }
      }
      return readFileSync(filePath, 'utf-8');
    },
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

const sendFixtureNodeRequest = async (
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
};

mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...realNodeRpc,
    sendNodeRequest: sendFixtureNodeRequest,
  },
});

// Keep this transport-bookkeeping test at its boundary; verified source admission has separate tests.
mock.module('../resources/node-file-observations.js', {
  namedExports: {
    ...realFileObservations,
    watchNodeFile: (node: unknown, file: string, onRequestId: (id: string) => void) =>
      sendFixtureNodeRequest(node, 'fs.watch', { path: file, observations: 1 }, { onRequestId }),
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

const progressUpdates: Array<{ progress: TaskProgressResult; parentChecklist?: string }> = [];
onTaskProgress((_slotId, progress, _role, _contextId, _runId, parentChecklist) => {
  progressUpdates.push({ progress, ...(parentChecklist ? { parentChecklist } : {}) });
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'remote watcher update arrives within the bounded window');
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
      'artifacts/operations-updated.json',
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
    await waitFor(() =>
      progressUpdates.some((update) => update.parentChecklist === 'CHECKLIST.md'),
    );
    assert.ok(
      progressUpdates.some((update) => update.parentChecklist === 'CHECKLIST.md'),
      'a remote child event emits a child-tagged progress update',
    );

    const operationCall = watchCalls.find((call) => call.path.endsWith('operations-updated.json'));
    assert.ok(operationCall);
    progressUpdates.length = 0;
    handleAgentFsChanged({
      requestId: operationCall.requestId,
      machine: MACHINE,
      path: operationCall.path,
      content: '{}',
    });
    await waitFor(() => progressUpdates.some((update) => !update.parentChecklist));
    assert.ok(
      progressUpdates.some((update) => !update.parentChecklist),
      'remote operation notifications emit parent task progress',
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
    await waitFor(() => watchCalls.length === 4);

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

test('a remote engine ledger event updates acceptance once, and nothing routes after unwatch', async () => {
  const root = writeTaskDir();
  const dir = taskDirAbs();
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    `${JSON.stringify({ task: { acceptanceCriteria: ['criterion AC-1'] } })}\n`,
  );
  watchCalls = [];
  stopCalls = [];
  progressUpdates.length = 0;
  const warn = console.warn;
  const warnings: string[] = [];
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    assert.equal(
      watchCalls.some((call) => call.path.endsWith('evidence-manifest.json')),
      false,
      'a current manifest does not drive acceptance progress',
    );
    const ledgerCall = watchCalls.find((call) => call.path.endsWith('acceptance-status.json'));
    assert.ok(ledgerCall, 'the engine ledger is watched on the node');
    const ledger: RecipeClaimLedger = {
      schemaVersion: 2,
      recipeRunId: 'test-execution',
      recording: { status: 'not-required', segments: [] },
      criteria: [
        {
          id: 'AC-1',
          text: 'criterion AC-1',
          verdict: 'proven',
          kind: 'acceptance',
          proofMode: 'state',
          assertionIndices: [],
          moments: [],
          evidence: ['artifacts/after.png'],
          recipeNodes: [],
        },
      ],
    };
    const content = JSON.stringify(ledger);
    writeFileSync(ledgerCall.path, content);
    const event = {
      requestId: ledgerCall.requestId,
      machine: MACHINE,
      path: ledgerCall.path,
      content,
    };
    handleAgentFsChanged(event);
    await waitFor(() => progressUpdates.length > 0);
    assert.equal(progressUpdates.length, 1, 'one event, one update');
    assert.deepEqual(progressUpdates[0].progress.acceptanceStatus, ledger);
    assert.equal(progressUpdates[0].progress.acceptanceEvidenceLinks, undefined);
    assert.equal(progressUpdates[0].parentChecklist, undefined, 'a parent-level update');

    await unwatchSlot(SLOT_ID);
    assert.ok(stopCalls.includes(ledgerCall.requestId), 'unwatch stops the ledger watch');
    // A late node event for the stopped watch is refused on the spot, so no
    // update can be scheduled for it.
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    handleAgentFsChanged(event);
    console.warn = warn;
    assert.match(warnings.join('\n'), /no active watch owns that request id/);
    assert.equal(progressUpdates.length, 1);
  } finally {
    console.warn = warn;
    try {
      await unwatchSlot(SLOT_ID);
    } catch (err) {
      console.error(`[test] teardown unwatch failed for ${SLOT_ID}: ${(err as Error).message}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('operation heartbeats during a slow progress read fold into one rerun', async () => {
  const root = writeTaskDir();
  watchCalls = [];
  stopCalls = [];
  let release = () => {};
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    const operationCall = watchCalls.find((call) => call.path.endsWith('operations-updated.json'));
    assert.ok(operationCall);
    const heartbeat = () =>
      handleAgentFsChanged({
        requestId: operationCall.requestId,
        machine: MACHINE,
        path: operationCall.path,
        content: '{}',
      });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    progressUpdates.length = 0;
    checklistReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    checklistReadsInFlight = 0;
    maxChecklistReadsInFlight = 0;

    // The runner rewrites operations-updated.json every 5 s; a busy node takes longer to answer.
    heartbeat();
    await waitFor(() => checklistReadsInFlight === 1);
    for (let beat = 0; beat < 2; beat++) {
      heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    assert.equal(maxChecklistReadsInFlight, 1, 'one progress read per watch at a time');
    assert.equal(progressUpdates.length, 0);

    checklistReadGate = undefined;
    release();
    await waitFor(() => progressUpdates.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(progressUpdates.length, 2, 'the held read, then one folded rerun');
  } finally {
    checklistReadGate = undefined;
    release();
    try {
      await unwatchSlot(SLOT_ID);
    } catch (err) {
      console.error(`[test] teardown unwatch failed for ${SLOT_ID}: ${(err as Error).message}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
