import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run, TaskProgressResult } from '@farmslot/protocol';

// See replay-step-nested-checklist.test.ts: mock.module replaces a module
// wholesale, so the real namespaces are spread in and only the fixtures these
// tests need are overridden. Both the watcher and methods/task.ts reach the same
// resolved modules, so one mock covers the whole read path.
import * as realConfig from '../core/config.js';
import * as realState from '../core/state.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

// Per-test slot and run ids: the watcher keys `activeWatches` and its debounce
// timers by slot, so two tests sharing one id share that state and the second
// one can observe the first one's teardown instead of its own setup.
let SLOT_ID = 'slot-watch-subtask';
let RUN_ID = 'run-watch-subtask';
const TASK_REL = 'dev/demo';

function useIds(suffix: string): void {
  SLOT_ID = `slot-watch-subtask-${suffix}`;
  RUN_ID = `run-watch-subtask-${suffix}`;
}

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

const PARENT_MARKDOWN = [
  '# Worker',
  '',
  '- [x] **1. read the ticket**',
  '- [ ] **2. run the review skill**',
  '',
].join('\n');

const CHILD_MARKDOWN = ['- [ ] **1. read the diff**', '- [ ] **2. check the patterns**', ''].join(
  '\n',
);

interface Emitted {
  progress: TaskProgressResult;
  parentChecklist?: string;
}

const emitted: Emitted[] = [];
onTaskProgress((_slotId, progress, _role, _contextId, _runId, parentChecklist) => {
  emitted.push({ progress, ...(parentChecklist ? { parentChecklist } : {}) });
});

function writeTaskDir(options: { withSubtasksDir?: boolean } = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-watch-subtask-'));
  repoRoot = root;
  const dir = taskDirAbs();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(dir, 'CHECKLIST.md'), PARENT_MARKDOWN);
  writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    `${JSON.stringify({ status: 'running', timestamp: new Date().toISOString() })}\n`,
  );
  if (options.withSubtasksDir) mkdirSync(path.join(dir, 'subtasks'), { recursive: true });
  return root;
}

/** `mark sub start`: the registry, the child checklist, and the child signal. */
function registerChild(dir: string): void {
  mkdirSync(path.join(dir, 'subtasks'), { recursive: true });
  writeFileSync(path.join(dir, 'subtasks', 'perps-review.md'), CHILD_MARKDOWN);
  writeFileSync(
    path.join(dir, 'subtasks', 'perps-review-SIGNAL.json'),
    `${JSON.stringify({
      role: 'subtask',
      contextId: 'perps-review',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
      status: 'running',
      checklistTiming: { schemaVersion: 1, source: 'subtasks/perps-review.md', events: [] },
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  writeFileSync(
    path.join(dir, 'subtasks', 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          id: 'perps-review',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
          checklist: 'subtasks/perps-review.md',
          signal: 'subtasks/perps-review-SIGNAL.json',
          source: { kind: 'skill', ref: 'skills/review.md', sha256: 'aa', renderedSha256: 'bb' },
          registeredAt: new Date().toISOString(),
        },
      ],
    })}\n`,
  );
}

/**
 * Register the child once and wait for the watcher to report it.
 *
 * One write is enough: the watch subject is the `subtasks/` DIRECTORY, so a file
 * created after the watch arms is reported on every platform. This used to need a
 * retry loop because the watch was registered on the not-yet-existing
 * `index.json` path, which only fsevents replays.
 */
async function registerChildAndWait(dir: string, label: string): Promise<Emitted> {
  registerChild(dir);
  return waitFor(label, (entry) => childProgressOf(entry)?.id === 'perps-review');
}

/** Wait for an emitted update that satisfies `predicate`, or fail with what arrived. */
// Generous: each hop is a chokidar event plus the watcher's 1s debounce plus a
// full progress re-read, and the suite runs this file alongside 400 others.
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
      emitted.map((entry) => ({
        parentChecklist: entry.parentChecklist,
        subtask: entry.progress.structured?.phases
          .flatMap((phase) => phase.steps)
          .find((step) => step.subtask)?.subtask?.progress.completedSteps,
      })),
    )}`,
  );
}

function childProgressOf(entry: Emitted) {
  return entry.progress.structured?.phases
    .flatMap((phase) => phase.steps)
    .find((step) => step.index === 2)?.subtask;
}

test('the watcher discovers a child unit registered mid-run and emits its marks', async () => {
  useIds('discovery');
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });

    // The registry appears only when the worker runs `mark sub start`: the watch
    // must pick it up without a re-dispatch.
    const registered = await registerChildAndWait(taskDirAbs(), 'the child registration update');
    // A child-driven update carries the parent checklist so the acceptance rule
    // can place it, and it is never a WORKER_SIGNAL — the child does not drive
    // the run's lifecycle.
    assert.equal(registered.parentChecklist, 'CHECKLIST.md');
    assert.equal(childProgressOf(registered)?.progress.completedSteps, 0);
    assert.equal(childProgressOf(registered)?.progress.totalSteps, 2);

    // `mark sub perps-review 1`: the child checklist and child signal change, the
    // parent checklist does not. The parent checkbox-hash guard must not swallow it.
    const subtasksDir = path.join(taskDirAbs(), 'subtasks');
    writeFileSync(
      path.join(subtasksDir, 'perps-review.md'),
      CHILD_MARKDOWN.replace('- [ ] **1. read the diff**', '- [x] **1. read the diff**'),
    );
    writeFileSync(
      path.join(subtasksDir, 'perps-review-SIGNAL.json'),
      `${JSON.stringify({
        role: 'subtask',
        contextId: 'perps-review',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
        status: 'running',
        checklistTiming: {
          schemaVersion: 1,
          source: 'subtasks/perps-review.md',
          events: [
            {
              stepNumber: 1,
              label: '1. read the diff',
              checkedAt: new Date().toISOString(),
            },
          ],
        },
        timestamp: new Date().toISOString(),
      })}\n`,
    );
    const marked = await waitFor(
      'the child step update',
      (entry) => childProgressOf(entry)?.progress.completedSteps === 1,
    );
    assert.equal(marked.parentChecklist, 'CHECKLIST.md');
    assert.equal(childProgressOf(marked)?.status, 'running');
    assert.equal(childProgressOf(marked)?.lastEventAt !== null, true);
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt child registry is reported at error level, and the watch survives it', async () => {
  useIds('corrupt-registry');
  const root = writeTaskDir();
  emitted.length = 0;
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    await registerChildAndWait(taskDirAbs(), 'the child registration update');

    // `mark sub` is the registry's only writer, so a file that does not parse is
    // a real fault. The watch must not die, and the operator must be able to see
    // WHY progress stopped advancing — both reports are error level.
    writeFileSync(path.join(taskDirAbs(), 'subtasks', 'index.json'), 'not a registry\n');

    const deadline = Date.now() + 40_000;
    const seen = () => ({
      registry: errors.find((line) => line.includes('cannot read subtask registry')),
      progress: errors.find((line) => line.includes('progress read failed')),
    });
    while (Date.now() < deadline && !(seen().registry && seen().progress)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { registry, progress } = seen();
    assert.ok(registry, `expected a registry error report; saw ${JSON.stringify(errors)}`);
    assert.match(registry, new RegExp(`${SLOT_ID}:dev`), 'names the watch key');
    assert.match(registry, /invalid|expected/, 'carries the parse reason');
    assert.ok(progress, `expected a progress-read error report; saw ${JSON.stringify(errors)}`);
    assert.match(
      progress,
      /CHECKLIST\.md/,
      'names the checklist whose progress could not be built',
    );

    // The watch is still live: repairing the registry resumes child updates
    // without a re-dispatch.
    emitted.length = 0;
    const recovered = await registerChildAndWait(
      taskDirAbs(),
      'the update after the registry is repaired',
    );
    assert.equal(recovered.parentChecklist, 'CHECKLIST.md');
  } finally {
    console.error = realError;
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a child registered after the watch is armed, with subtasks/ empty, is observed', async () => {
  useIds('arm-then-register');
  // The regression this guards: the watch used to be registered on the
  // not-yet-existing `subtasks/index.json` path. fsevents replays that creation,
  // inotify does not, so this passed on macOS and timed out on the Linux CI
  // runner. The directory is the watch subject now, so the platform cannot
  // decide the outcome.
  const root = writeTaskDir({ withSubtasksDir: true });
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    // Armed, and the directory is real but empty: nothing has been reported yet.
    assert.deepEqual(emitted, []);

    const observed = await registerChildAndWait(taskDirAbs(), 'the first registration');
    assert.equal(observed.parentChecklist, 'CHECKLIST.md');
    assert.equal(childProgressOf(observed)?.id, 'perps-review');
    assert.equal(childProgressOf(observed)?.progress.totalSteps, 2);
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a child registered when subtasks/ did not exist at arm time is observed', async () => {
  useIds('arm-without-dir');
  // `subtasks/` appears only with the first `mark sub start`. The gateway creates
  // it before attaching (both watch primitives observe a file through its parent),
  // so a watch armed against a task dir that has never had a child still sees the
  // first one.
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    assert.equal(existsSync(path.join(taskDirAbs(), 'subtasks')), false);
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    // The observer created the contract directory and wrote nothing into it.
    assert.equal(existsSync(path.join(taskDirAbs(), 'subtasks')), true);
    assert.deepEqual(readdirSync(path.join(taskDirAbs(), 'subtasks')), []);

    const observed = await registerChildAndWait(taskDirAbs(), 'the first registration');
    assert.equal(observed.parentChecklist, 'CHECKLIST.md');
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a registry that already exists when the watch arms is picked up with no further write', async () => {
  useIds('registry-before-arm');
  // A gateway restart mid-run, or a worker that registered before the watch was
  // set up: no filesystem event will ever describe it, so setup reads it once.
  const root = writeTaskDir({ withSubtasksDir: true });
  registerChild(taskDirAbs());
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });
    const observed = await waitFor(
      'the setup read of an existing registry',
      (entry) => childProgressOf(entry)?.id === 'perps-review',
    );
    assert.equal(observed.parentChecklist, 'CHECKLIST.md');
    assert.equal(childProgressOf(observed)?.progress.totalSteps, 2);

    // And the watch is live afterwards: a child mark still arrives.
    emitted.length = 0;
    writeFileSync(
      path.join(taskDirAbs(), 'subtasks', 'perps-review.md'),
      CHILD_MARKDOWN.replace('- [ ] **1. read the diff**', '- [x] **1. read the diff**'),
    );
    const marked = await waitFor(
      'the child step update after a setup read',
      (entry) => childProgressOf(entry)?.progress.completedSteps === 1,
    );
    assert.equal(marked.parentChecklist, 'CHECKLIST.md');
  } finally {
    await unwatchSlot(SLOT_ID);
    rmSync(root, { recursive: true, force: true });
  }
});
