import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

// Same fixture shape as task-subtask-projection.test.ts: mock.module replaces a
// module wholesale, so the real namespaces are spread in and only the slot/run
// lookups these tests need are overridden.
import * as realConfig from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import * as realIo from '../core/slot-io.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

import { makeRun } from './run/test-fixtures.js';

let repoRoot = '';
let currentRunId: string | null = null;
let currentTaskFile: string | null = null;
let beforeRead: (() => void) | undefined;

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    // The fixture's task directories stand in for the project's orchestrator task root.
    getOrchestratorTaskRoot: () => path.join(repoRoot, '.task'),
    loadSlotVars: async () => ({
      remoteRepo: repoRoot,
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-acceptance',
      projectName: 'farmslot',
    }),
    resolveTaskPaths: async (slotId: string, taskFile: string) => {
      const taskDir = path.join(repoRoot, '.task', taskFile);
      return {
        vars: {
          remoteRepo: repoRoot,
          host: 'localhost',
          machine: 'local',
          sshTarget: '',
          slotId,
          projectName: 'demo',
        },
        taskDirName: '.task',
        taskDir,
        taskMdPath: path.join(taskDir, 'TASK.md'),
        signalPath: path.join(taskDir, 'SIGNAL.json'),
      };
    },
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'slot-acceptance', taskFile: currentTaskFile, currentRunId }],
    }),
  },
});

mock.module('../core/slot-io.js', {
  namedExports: {
    ...realIo,
    slotReadFile: async (...args: Parameters<typeof realIo.slotReadFile>) => {
      const intervene = beforeRead;
      beforeRead = undefined;
      intervene?.();
      return realIo.slotReadFile(...args);
    },
  },
});

// Runs a test registers by id; every other lookup finds none.
const runs = new Map<string, Run>();

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) => runs.get(id),
    listRuns: () => ({ runs: [] }),
  },
});

const { taskProgress } = await import('./task.js');
const {
  importRetainedAcceptanceLinks,
  RETAINED_LINK_SOURCE,
  RETAINED_LINK_HELPER_SHA256,
  retainedAcceptanceLinksPath,
} = await import('../tasks/retained-acceptance-links.js');

const CHECKLIST = ['# Worker', '', '- [x] **1. build it**', '- [ ] **2. prove it**', ''].join('\n');

const LEDGER = {
  schemaVersion: 1,
  criteria: [
    {
      id: 'AC-1',
      text: 'The ledger reaches run detail',
      verdict: 'proven',
      proofMode: 'state',
      evidence: ['artifacts/after.png'],
      recipeNodes: ['assert-panel'],
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: 'AC-2',
      text: 'A verdict is required before complete',
      verdict: 'weak',
      evidence: [],
      recipeNodes: [],
      updatedAt: '2026-09-19T10:01:00.000Z',
    },
  ],
};

const CRITERIA = [
  'The ledger reaches run detail',
  'A verdict is required before complete',
  'The third criterion is never judged in this fixture',
];

function writeFixture(ledgerBody: string | null): { root: string; taskFileRel: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-acceptance-progress-'));
  repoRoot = root;
  const taskDirRel = path.join('.task', 'dev', 'demo');
  const taskDir = path.join(root, taskDirRel);
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'CHECKLIST.md'), CHECKLIST);
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(taskDir, 'inputs', 'handoff.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      task: { title: 'Acceptance projection', acceptanceCriteria: CRITERIA },
    })}\n`,
  );
  if (ledgerBody !== null) {
    writeFileSync(path.join(taskDir, 'artifacts', 'acceptance-status.json'), ledgerBody);
  }
  return { root, taskFileRel: path.join(taskDirRel, 'CHECKLIST.md') };
}

async function progressFor(fixture: { taskFileRel: string }) {
  return taskProgress({ slotId: 'slot-acceptance', taskFile: fixture.taskFileRel });
}

test('task.progress preserves imported historical links without a verdict or timeline', async () => {
  const fixture = writeFixture(null);
  const taskDir = path.dirname(path.join(fixture.root, fixture.taskFileRel));
  const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const manifestPath = path.join(taskDir, 'artifacts/evidence-manifest.json');
  const manifest = JSON.stringify({
    standalone: [{ file: 'artifacts/retained.png', covers: ['AC-1'] }],
  });
  writeFileSync(manifestPath, manifest);
  writeFileSync(path.join(taskDir, 'artifacts/retained.png'), 'retained bytes');
  const links = [{ id: 'AC-1', evidence: ['artifacts/retained.png'] }];
  const inventory = {
    frozenSource: RETAINED_LINK_SOURCE,
    helperSha256: RETAINED_LINK_HELPER_SHA256,
    records: [
      {
        task: path.relative(fixture.root, taskDir),
        handoffSha256: sha256(readFileSync(path.join(taskDir, 'inputs/handoff.json'))),
        manifestSha256: sha256(manifest),
        links,
        refs: [
          {
            path: 'artifacts/retained.png',
            sha256: sha256('retained bytes'),
            contained: true,
            present: true,
          },
        ],
      },
    ],
  };
  try {
    await importRetainedAcceptanceLinks(Buffer.from(JSON.stringify(inventory)), fixture.root);
    const result = await progressFor(fixture);
    assert.deepEqual(result.acceptanceEvidenceLinks, links);
    assert.equal(result.acceptanceStatus, undefined);
    assert.equal(result.acceptanceSource, undefined);
    assert.equal(result.acceptanceStatusError, undefined);
    assert.equal(result.acceptanceEvidenceLinksError, undefined);
    assert.deepEqual(readFileSync(manifestPath), Buffer.from(manifest));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(retainedAcceptanceLinksPath(taskDir), { force: true });
  }
});

test('task.progress carries the acceptance ledger beside the step projection', async () => {
  const fixture = writeFixture(`${JSON.stringify(LEDGER, null, 2)}\n`);
  try {
    const result = await progressFor(fixture);
    assert.deepEqual(result.acceptanceStatus, LEDGER);
    assert.equal(result.acceptanceSource, 'ledger');
    assert.equal(result.acceptanceEvidenceLinks, undefined);
    // The registered criteria travel too, so a client can show the third one as
    // awaiting a verdict instead of hiding it.
    assert.deepEqual(result.acceptanceCriteria, [
      { id: 'AC-1', text: CRITERIA[0] },
      { id: 'AC-2', text: CRITERIA[1] },
      { id: 'AC-3', text: CRITERIA[2] },
    ]);
    // The ledger is task-directory state: it changes no step.
    const steps = (result.structured?.phases ?? []).flatMap((phase) => phase.steps);
    assert.equal(steps.length, 2);
    assert.equal(result.structured?.completedSteps, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a run with no ledger still reports the criteria it registered', async () => {
  const fixture = writeFixture(null);
  try {
    const result = await progressFor(fixture);
    assert.equal(result.acceptanceStatus, undefined);
    assert.equal(result.acceptanceCriteria?.length, 3);
    assert.equal(result.structured?.totalSteps, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an unreadable ledger leaves progress intact instead of failing the call', async () => {
  const fixture = writeFixture('{ not json');
  try {
    const result = await progressFor(fixture);
    assert.equal(result.acceptanceStatus, undefined);
    assert.equal(result.structured?.totalSteps, 2, 'the checklist still reports');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('with no ledger, manifest covers cannot supply task acceptance links', async () => {
  const fixture = writeFixture(null);
  try {
    writeFileSync(
      path.join(fixture.root, '.task', 'dev', 'demo', 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({ standalone: [{ label: 'Panel', covers: ['ac2'], file: 'after.png' }] }),
    );
    const result = await progressFor(fixture);
    assert.equal(result.acceptanceStatus, undefined, 'the ledger field stays empty');
    assert.equal(result.acceptanceSource, undefined);
    assert.equal(result.acceptanceEvidenceLinks, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function writeReleasedRun(options: { workerMirror: boolean }) {
  // The slot fixture has no taskFile, as after a release; the run keeps the
  // gateway's copy of its task directory, which run artifacts are served from.
  const fixture = writeFixture(null);
  const taskDir = path.join(fixture.root, '.task', 'dev', 'demo');
  writeFileSync(path.join(taskDir, 'TASK.md'), '# Task\n');
  // That copy's checklist is the unchecked dispatch template; the worker's
  // checked copy lands beside it as `.worker` at completion.
  writeFileSync(
    path.join(taskDir, 'CHECKLIST.md'),
    ['# Worker', '', '- [ ] **1. build it**', '- [ ] **2. prove it**', ''].join('\n'),
  );
  if (options.workerMirror) {
    writeFileSync(
      path.join(taskDir, 'CHECKLIST.md.worker'),
      ['# Worker', '', '- [x] **1. build it**', '- [x] **2. prove it**', ''].join('\n'),
    );
  }
  writeFileSync(
    path.join(taskDir, 'artifacts', 'evidence-manifest.json'),
    JSON.stringify({ standalone: [{ label: 'Teardown', covers: ['ac1'], file: 'teardown.png' }] }),
  );
  runs.set(
    'run-released',
    makeRun({
      id: 'run-released',
      project: 'demo',
      flowType: 'dev',
      taskFile: path.join(taskDir, 'TASK.md'),
      slotId: 'slot-acceptance',
      status: 'done',
    }),
  );
  return fixture;
}

test('a finished run whose slot no longer holds its task reads its recorded task directory', async () => {
  const fixture = writeReleasedRun({ workerMirror: true });
  try {
    const result = await taskProgress({ slotId: 'slot-acceptance', runId: 'run-released' });
    assert.equal(result.acceptanceCriteria?.length, 3);
    assert.equal(result.acceptanceEvidenceLinks, undefined);
    assert.equal(result.structured?.totalSteps, 2);
    assert.equal(
      result.structured?.completedSteps,
      2,
      "the worker's checked copy, not the template",
    );

    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'run-unknown' }),
      (error: unknown) => error instanceof GatewayMethodError && error.code === 'RUN_NOT_FOUND',
      'a missing requested run is an authorized not-found, not another slot task',
    );
  } finally {
    runs.delete('run-released');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('without the worker mirror a recorded run reports acceptance data and no steps', async () => {
  const fixture = writeReleasedRun({ workerMirror: false });
  try {
    const result = await taskProgress({ slotId: 'slot-acceptance', runId: 'run-released' });
    assert.equal(result.structured, undefined, 'the unchecked template is never shown as progress');
    assert.equal(result.acceptanceCriteria?.length, 3);
    assert.equal(result.acceptanceEvidenceLinks, undefined);
  } finally {
    runs.delete('run-released');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a recorded task file outside the project task root is not read', async () => {
  const fixture = writeReleasedRun({ workerMirror: true });
  const outside = mkdtempSync(path.join(os.tmpdir(), 'gw-outside-task-'));
  writeFileSync(path.join(outside, 'TASK.md'), '# Task\n');
  runs.set(
    'run-outside',
    makeRun({
      id: 'run-outside',
      project: 'demo',
      flowType: 'dev',
      taskFile: path.join(outside, 'TASK.md'),
      slotId: 'slot-acceptance',
      status: 'done',
    }),
  );
  try {
    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'run-outside' }),
      (error: unknown) =>
        error instanceof GatewayMethodError && error.code === 'PROGRESS_OWNER_CHANGED',
    );
  } finally {
    runs.delete('run-released');
    runs.delete('run-outside');
    rmSync(outside, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an old or missing run never reads the successor occupying its slot', async () => {
  const fixture = writeReleasedRun({ workerMirror: true });
  const nextDir = path.join(fixture.root, '.task', 'dev', 'successor');
  mkdirSync(nextDir, { recursive: true });
  writeFileSync(path.join(nextDir, 'TASK.md'), '# Successor task\n');
  writeFileSync(
    path.join(nextDir, 'CHECKLIST.md'),
    '# Successor\n- [x] **1. successor-only step**\n',
  );
  currentRunId = 'run-next';
  currentTaskFile = 'dev/successor';
  runs.set(
    'run-next',
    makeRun({
      id: 'run-next',
      project: 'demo',
      slotId: 'slot-acceptance',
      taskFile: path.join(nextDir, 'TASK.md'),
    }),
  );
  try {
    const old = await taskProgress({ slotId: 'slot-acceptance', runId: 'run-released' });
    assert.equal(old.structured?.totalSteps, 2);
    assert.equal(old.structured?.completedSteps, 2);
    assert(!old.markdown.includes('successor-only'));
    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'missing' }),
      (error: unknown) => error instanceof GatewayMethodError && error.code === 'RUN_NOT_FOUND',
    );
    await assert.rejects(
      taskProgress({
        slotId: 'slot-acceptance',
        runId: 'run-released',
        taskFile: path.join(nextDir, 'CHECKLIST.md'),
      }),
      (error: unknown) => error instanceof GatewayMethodError && error.code === 'NOT_FOUND',
    );
    const current = await taskProgress({ slotId: 'slot-acceptance', runId: 'run-next' });
    assert.equal(current.structured?.totalSteps, 1);
    assert(current.markdown.includes('successor-only'));
  } finally {
    currentRunId = null;
    currentTaskFile = null;
    runs.delete('run-next');
    runs.delete('run-released');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a retained selected-step artifact remains readable after slot reuse', async () => {
  const fixture = writeReleasedRun({ workerMirror: false });
  const artifact = '.task/dev/demo/artifacts/review-1/review.md';
  mkdirSync(path.dirname(path.join(fixture.root, artifact)), { recursive: true });
  writeFileSync(path.join(fixture.root, artifact), '# Old review\n- [x] **1. retained review**\n');
  runs.set(
    'run-released',
    makeRun({
      id: 'run-released',
      project: 'demo',
      slotId: 'slot-acceptance',
      taskFile: path.join(fixture.root, '.task/dev/demo/TASK.md'),
      steps: [{ name: 'review', status: 'done', outputs: { taskProgressArtifactPath: artifact } }],
    }),
  );
  currentRunId = 'successor';
  currentTaskFile = 'dev/successor';
  try {
    const result = await taskProgress({
      slotId: 'slot-acceptance',
      runId: 'run-released',
      taskFile: artifact,
    });
    assert.equal(result.structured?.completedSteps, 1);
    assert(result.markdown.includes('retained review'));
    beforeRead = () => {
      const run = runs.get('run-released')!;
      runs.set(run.id, { ...run, steps: [] });
    };
    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'run-released', taskFile: artifact }),
      (error: unknown) =>
        error instanceof GatewayMethodError && error.code === 'PROGRESS_OWNER_CHANGED',
      'An artifact removed from the run during I/O cannot publish under its old selection',
    );
  } finally {
    beforeRead = undefined;
    currentRunId = null;
    currentTaskFile = null;
    runs.delete('run-released');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('retained role progress stays within its run and rejects a replaced context', async () => {
  const fixture = writeReleasedRun({ workerMirror: true });
  const run = runs.get('run-released')!;
  const reviewFile = '.task/dev/demo/REVIEW.md';
  writeFileSync(path.join(fixture.root, reviewFile), '# Review template\n');
  writeFileSync(
    path.join(fixture.root, `${reviewFile}.worker`),
    '# Old reviewer\n- [x] **1. retained review**\n- [ ] **2. pending review**\n',
  );
  const context = {
    id: 'review-1',
    role: 'review' as const,
    label: 'Review',
    status: 'working' as const,
    slotId: 'slot-acceptance',
    runId: run.id,
    taskFile: `/retired-worker/${reviewFile}`,
    signalFile: null,
    target: null,
    runner: null,
    model: null,
    nudgeCount: 0,
    updatedAt: run.updatedAt,
  };
  runs.set(run.id, { ...run, agentContexts: [context] });
  currentRunId = 'successor';
  currentTaskFile = 'dev/successor';
  try {
    const result = await taskProgress({
      slotId: 'slot-acceptance',
      runId: run.id,
      contextId: context.id,
    });
    assert.equal(result.contextId, context.id);
    assert.equal(result.structured?.totalSteps, 2);
    assert.equal(result.structured?.completedSteps, 1);
    assert(result.markdown.includes('Old reviewer'));
    beforeRead = () => runs.set(run.id, { ...run, agentContexts: [] });
    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: run.id, contextId: context.id }),
      (error: unknown) => error instanceof GatewayMethodError && error.code === 'NOT_FOUND',
    );
  } finally {
    beforeRead = undefined;
    currentRunId = null;
    currentTaskFile = null;
    runs.delete(run.id);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a binding replacement during file I/O cannot publish successor bytes under the prior run', async () => {
  const fixture = writeFixture(null);
  const taskFile = path.join(fixture.root, '.task/dev/demo/TASK.md');
  writeFileSync(taskFile, '# Task\n');
  currentRunId = 'reading-run';
  currentTaskFile = 'dev/demo';
  runs.set(
    'reading-run',
    makeRun({ id: 'reading-run', project: 'demo', slotId: 'slot-acceptance', taskFile }),
  );
  beforeRead = () => {
    currentRunId = 'successor';
    writeFileSync(
      path.join(fixture.root, '.task/dev/demo/CHECKLIST.md'),
      '# New worker\n- [x] **1. successor bytes**\n',
    );
  };
  try {
    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'reading-run' }),
      (error: unknown) =>
        error instanceof GatewayMethodError && error.code === 'PROGRESS_OWNER_CHANGED',
    );
  } finally {
    beforeRead = undefined;
    currentRunId = null;
    currentTaskFile = null;
    runs.delete('reading-run');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
