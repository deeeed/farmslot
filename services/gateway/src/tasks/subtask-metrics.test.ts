import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// See replay-step-nested-checklist.test.ts: mock.module replaces a module
// wholesale, so the real namespace is spread in and only the fixtures these
// tests need are overridden.
import * as realConfig from '../core/config.js';

let remoteRepo = '';
let orchestratorTaskRoot = '';
/** Set to make the mocked project-config load fail, as an edited project.json would. */
let projectVarsError: Error | null = null;

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo,
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-subtask-metrics',
      projectName: 'farmslot',
    }),
    loadProjectVars: async () => {
      if (projectVarsError) throw projectVarsError;
      return { projectJson: {} };
    },
    getOrchestratorTaskRoot: () => orchestratorTaskRoot,
    resolveProjectTaskDirName: () => '.task',
    resolveTaskRelDir: (taskFile: string, taskRoot: string) => {
      const relative = path.relative(taskRoot, taskFile);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const dir = path.dirname(relative);
      return dir === '.' ? '' : dir;
    },
  },
});

const { collectRunSubtaskMetrics, subtaskDurationMs } = await import('./subtask-metrics.js');

const CHILD_MARKDOWN = [
  '- [x] **1. read the failing job output**',
  '- [x] **2. reproduce it locally**',
  '- [ ] **3. record the parity result**',
  '',
].join('\n');

function childSignal(status: string) {
  return `${JSON.stringify({
    role: 'subtask',
    contextId: 'ci-parity',
    parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
    status,
    checklistTiming: {
      schemaVersion: 1,
      events: [
        { stepNumber: 1, label: '1. read', checkedAt: '2026-09-19T10:00:00Z' },
        { stepNumber: 2, label: '2. reproduce', checkedAt: '2026-09-19T10:03:00Z' },
      ],
    },
    timestamp: '2026-09-19T10:03:00Z',
  })}\n`;
}

/** A slot repo whose worker task dir carries a registry, plus the run pointing at it. */
function setup(options: { withIndex: boolean; status?: string }): { run: Run; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-subtask-metrics-'));
  remoteRepo = path.join(root, 'repo');
  orchestratorTaskRoot = path.join(root, 'orchestrator', 'tasks');
  const workerTaskDir = path.join(remoteRepo, '.task', 'dev', 'demo');
  mkdirSync(workerTaskDir, { recursive: true });
  mkdirSync(path.join(orchestratorTaskRoot, 'dev', 'demo'), { recursive: true });
  writeFileSync(path.join(workerTaskDir, 'CHECKLIST.md'), '- [x] **1. work**\n');
  if (options.withIndex) {
    mkdirSync(path.join(workerTaskDir, 'subtasks'), { recursive: true });
    writeFileSync(
      path.join(workerTaskDir, 'subtasks', 'index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        units: [
          {
            id: 'ci-parity',
            parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
            checklist: 'subtasks/ci-parity.md',
            signal: 'subtasks/ci-parity-SIGNAL.json',
            source: { kind: 'skill', ref: 'skills/ci.md', sha256: 'aa', renderedSha256: 'bb' },
            registeredAt: '2026-09-19T09:59:00Z',
          },
        ],
      })}\n`,
    );
    writeFileSync(path.join(workerTaskDir, 'subtasks', 'ci-parity.md'), CHILD_MARKDOWN);
    writeFileSync(
      path.join(workerTaskDir, 'subtasks', 'ci-parity-SIGNAL.json'),
      childSignal(options.status ?? 'complete'),
    );
  }
  const run = {
    project: 'farmslot',
    taskFile: path.join(orchestratorTaskRoot, 'dev', 'demo', 'TASK.md'),
  } as Run;
  return { run, root };
}

test('subtaskDurationMs spans the first to the last child mark', () => {
  assert.equal(
    subtaskDurationMs({
      schemaVersion: 1,
      events: [
        { stepNumber: 2, label: '2. b', checkedAt: '2026-09-19T10:03:00Z' },
        { stepNumber: 1, label: '1. a', checkedAt: '2026-09-19T10:00:00Z' },
      ],
    }),
    180_000,
  );
  // One mark is a zero-length span, not a missing one.
  assert.equal(
    subtaskDurationMs({
      schemaVersion: 1,
      events: [{ stepNumber: 1, label: '1. a', checkedAt: '2026-09-19T10:00:00Z' }],
    }),
    0,
  );
  assert.equal(subtaskDurationMs({ schemaVersion: 1, events: [] }), null);
  assert.equal(subtaskDurationMs(undefined), null);
});

test('collectRunSubtaskMetrics rolls up each registered child from the slot', async () => {
  const { run, root } = setup({ withIndex: true });
  try {
    const metrics = await collectRunSubtaskMetrics(run, 'slot-subtask-metrics');
    assert.ok(metrics);
    assert.equal(metrics.length, 1);
    assert.deepEqual(
      { ...metrics[0], checklistTiming: undefined },
      {
        id: 'ci-parity',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
        source: { kind: 'skill', ref: 'skills/ci.md', sha256: 'aa', renderedSha256: 'bb' },
        status: 'complete',
        durationMs: 180_000,
        completedSteps: 2,
        totalSteps: 3,
        checklistTiming: undefined,
      },
    );
    // The child's own events are persisted so the gate summary can derive
    // per-step durations after the task dir is pruned.
    assert.equal(metrics[0].checklistTiming?.events.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectRunSubtaskMetrics records a child that is still open', async () => {
  const { run, root } = setup({ withIndex: true, status: 'blocked' });
  try {
    const metrics = await collectRunSubtaskMetrics(run, 'slot-subtask-metrics');
    assert.equal(metrics?.[0].status, 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectRunSubtaskMetrics returns null for a run with no child unit', async () => {
  const { run, root } = setup({ withIndex: false });
  try {
    assert.equal(await collectRunSubtaskMetrics(run, 'slot-subtask-metrics'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectRunSubtaskMetrics propagates a project-config load failure', async () => {
  const { run, root } = setup({ withIndex: true });
  projectVarsError = new Error('project.json is not valid JSON');
  try {
    // Dispatch already loaded this config to place the task directory, so a
    // failure here is a real fault. Falling back to DEFAULT_TASK_DIR would
    // resolve a DIFFERENT directory and report "no child units" for a run that
    // has two — a silent wrong answer instead of a visible failure.
    await assert.rejects(
      () => collectRunSubtaskMetrics(run, 'slot-subtask-metrics'),
      /project\.json is not valid JSON/,
    );
  } finally {
    projectVarsError = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('post-dispatch reports a lost subtask roll-up at error level, keeping parent metrics', async () => {
  // A source assertion: this catch lives inside the monitor pipeline step, which
  // needs the whole run engine (slot claim, tmux, monitor loop) to invoke. The
  // behaviour it guards is a logging LEVEL and the identifying detail in the
  // message, both of which are only visible in the source at unit scope. The
  // recovery itself — a metrics failure must not lose the parent's own metrics —
  // is what the surrounding assertions on the run record cover.
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'run-engine', 'post-dispatch-steps.ts'),
    'utf-8',
  );
  const block = source.slice(
    source.indexOf('collectRunSubtaskMetrics(after, current.slotId)'),
    source.indexOf('subtask metrics unavailable') + 200,
  );
  assert.ok(block, 'the subtask metrics catch must exist');
  assert.match(
    block,
    /console\.error\(/,
    'a lost child roll-up is error level: nothing else in the log explains the gap',
  );
  assert.doesNotMatch(block, /console\.warn\(/, 'warn would bury it among routine notices');
  assert.match(block, /after\.taskFile/, 'the report names the task directory it could not read');
});
