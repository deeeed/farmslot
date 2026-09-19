import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run, TaskProgressResult } from '@farmslot/protocol';

// Same fixture shape as watcher-subtask.test.ts: mock.module replaces a module
// wholesale, so the real namespaces are spread in and only the fixtures these
// tests need are overridden. Both the watcher and methods/task.ts reach the same
// resolved modules, so one mock covers the whole read path.
import * as realConfig from '../core/config.js';
import * as realState from '../core/state.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const SLOT_ID = 'slot-watch-acceptance';
const RUN_ID = 'run-watch-acceptance';
const TASK_REL = 'dev/demo';

let repoRoot = '';

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

function taskDirAbs(): string {
  return path.join(repoRoot, '.task', TASK_REL);
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
          machine: 'local',
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

const { onTaskProgress, unwatchSlot, watchSlot } = await import('./watcher.js');

const CHECKLIST_MARKDOWN = [
  '# Worker',
  '',
  '- [x] **1. build it**',
  '- [ ] **2. prove it**',
  '',
].join('\n');

interface Emitted {
  progress: TaskProgressResult;
  parentChecklist?: string;
}

const emitted: Emitted[] = [];
onTaskProgress((_slotId, progress, _role, _contextId, _runId, parentChecklist) => {
  emitted.push({ progress, ...(parentChecklist ? { parentChecklist } : {}) });
});

function writeTaskDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-watch-acceptance-'));
  repoRoot = root;
  const dir = taskDirAbs();
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(dir, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(dir, 'CHECKLIST.md'), CHECKLIST_MARKDOWN);
  writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    `${JSON.stringify({ status: 'running', timestamp: new Date().toISOString() })}\n`,
  );
  return root;
}

/** What `farmslot-agent ac set` leaves on disk. */
function writeLedger(dir: string, criteria: Array<Record<string, unknown>>): void {
  writeFileSync(
    path.join(dir, 'artifacts', 'acceptance-status.json'),
    `${JSON.stringify({ schemaVersion: 1, criteria }, null, 2)}\n`,
  );
}

function criterion(id: string, verdict: string): Record<string, unknown> {
  return {
    id,
    text: `criterion ${id}`,
    verdict,
    evidence: [],
    recipeNodes: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Quiet window longer than the watcher's 1s debounce plus a progress read, so an
 * emission that was going to happen has happened before a count is asserted.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

/** Wait for an emitted update that satisfies `predicate`, or fail with what arrived. */
// Generous for the same reason as the child-unit watcher test: a chokidar event
// plus the watcher's 1s debounce plus a full progress re-read, in a 400-file suite.
async function waitFor(
  label: string,
  predicate: (entry: Emitted) => boolean,
  timeoutMs = 60_000,
): Promise<Emitted> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = emitted.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${label}; emitted ${emitted.length} update(s): ${JSON.stringify(
      emitted.map((entry) => entry.progress.acceptanceStatus?.criteria.map((c) => c.verdict)),
    )}`,
  );
}

test('a ledger already on disk reaches clients once, and a later write once more', async () => {
  const root = writeTaskDir();
  // The state a gateway restart finds: verdicts recorded before this watch began.
  // The directory watch runs with `ignoreInitial: true`, so the only thing that
  // reports this ledger is the explicit read after arming — and it must report it
  // exactly once, not once per mechanism.
  writeLedger(taskDirAbs(), [criterion('AC-1', 'proven'), criterion('AC-2', 'untestable')]);
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    const first = await waitFor(
      'the existing ledger',
      (entry) => entry.progress.acceptanceStatus?.criteria.length === 2,
    );
    assert.deepEqual(
      first.progress.acceptanceStatus?.criteria.map((entry) => entry.verdict),
      ['proven', 'untestable'],
    );
    await settle();
    assert.equal(emitted.length, 1, 'the initial read and the watch must not both emit');

    // A later verdict is one more update, and only one.
    writeLedger(taskDirAbs(), [
      criterion('AC-1', 'proven'),
      criterion('AC-2', 'untestable'),
      criterion('AC-3', 'weak'),
    ]);
    await waitFor(
      'the later verdict',
      (entry) => entry.progress.acceptanceStatus?.criteria.length === 3,
    );
    await settle();
    assert.equal(emitted.length, 2, 'one write, one update');
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('other files in artifacts/ never drive a progress update', async () => {
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    // The directory is the watch subject, so every worker artifact lands in it.
    // Only the ledger is progress; the rest must not re-read the task dir.
    const artifacts = path.join(taskDirAbs(), 'artifacts');
    writeFileSync(path.join(artifacts, 'report.md'), '# Report\n');
    writeFileSync(path.join(artifacts, 'after.png'), 'png-bytes');
    writeFileSync(path.join(artifacts, 'recipe.json'), '{}\n');
    await settle();
    assert.equal(emitted.length, 0, `worker artifacts emitted: ${emitted.length}`);

    // The ledger in the same directory still does.
    writeLedger(taskDirAbs(), [criterion('AC-1', 'proven')]);
    await waitFor('the ledger', (entry) => entry.progress.acceptanceStatus?.criteria.length === 1);
    await settle();
    assert.equal(emitted.length, 1);
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a released slot stops reporting ledger writes', async () => {
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    writeLedger(taskDirAbs(), [criterion('AC-1', 'proven')]);
    await waitFor('the ledger', (entry) => entry.progress.acceptanceStatus?.criteria.length === 1);

    // A released slot must stop reporting. This asserts the observable effect —
    // no emission after unwatch — which the teardown delivers by closing the
    // acceptance watcher alongside the others and dropping the watch entry.
    // Closure itself has no observable signal from here without a test-only
    // export, so the entry removal alone would satisfy this assertion.
    await unwatchSlot(SLOT_ID);
    emitted.length = 0;
    writeLedger(taskDirAbs(), [criterion('AC-1', 'proven'), criterion('AC-2', 'weak')]);
    await settle();
    assert.equal(emitted.length, 0, 'the closed watch must not emit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the watcher emits the acceptance ledger as verdicts land, without a parent mark', async () => {
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });

    // First verdict: the ledger file appears mid-run, like `ac set` writes it.
    writeLedger(taskDirAbs(), [criterion('AC-1', 'proven')]);
    const first = await waitFor(
      'the first verdict',
      (entry) => entry.progress.acceptanceStatus?.criteria.length === 1,
    );
    assert.equal(first.progress.acceptanceStatus?.criteria[0].verdict, 'proven');
    // A ledger update is parent-level, not a child update: no parentChecklist tag,
    // and the parent checkbox hash must not swallow it — no box changed.
    assert.equal(first.parentChecklist, undefined);
    assert.equal(first.progress.structured?.completedSteps, 1);

    // Second verdict on the same file: the change must reach clients too.
    writeLedger(taskDirAbs(), [criterion('AC-1', 'proven'), criterion('AC-2', 'weak')]);
    const second = await waitFor(
      'the second verdict',
      (entry) => entry.progress.acceptanceStatus?.criteria.length === 2,
    );
    assert.deepEqual(
      second.progress.acceptanceStatus?.criteria.map((entry) => entry.verdict),
      ['proven', 'weak'],
    );
    assert.equal(second.parentChecklist, undefined);
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});
