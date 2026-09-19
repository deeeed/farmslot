import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const SLOT_ID = 'slot-watch-subtask';
const RUN_ID = 'run-watch-subtask';
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

function writeTaskDir(): string {
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
  const root = writeTaskDir();
  emitted.length = 0;
  try {
    await watchSlot(SLOT_ID, { runId: RUN_ID });

    // The registry appears only when the worker runs `mark sub start`: the watch
    // must pick it up without a re-dispatch.
    registerChild(taskDirAbs());
    const registered = await waitFor(
      'the child registration update',
      (entry) => childProgressOf(entry)?.id === 'perps-review',
    );
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
