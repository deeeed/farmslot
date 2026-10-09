import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

// Same fixture shape as task-subtask-projection.test.ts: mock.module replaces a
// module wholesale, so the real namespaces are spread in and only the slot/run
// lookups these tests need are overridden.
import * as realConfig from '../core/config.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

let repoRoot = '';

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo: repoRoot,
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-acceptance',
      projectName: 'farmslot',
    }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({ slots: [{ slot: 'slot-acceptance', taskFile: null }] }),
  },
});

// Runs a test registers by id; every other lookup finds none.
const runs = new Map<string, unknown>();

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) => runs.get(id),
    listRuns: () => ({ runs: [] }),
  },
});

const { taskProgress } = await import('./task.js');

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

test('with no ledger, manifest links ride in their own field and never as a verdict', async () => {
  const fixture = writeFixture(null);
  try {
    writeFileSync(
      path.join(fixture.root, '.task', 'dev', 'demo', 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({ standalone: [{ label: 'Panel', covers: ['ac2'], file: 'after.png' }] }),
    );
    const result = await progressFor(fixture);
    assert.equal(result.acceptanceStatus, undefined, 'the ledger field stays empty');
    assert.equal(result.acceptanceSource, 'evidence-manifest');
    assert.deepEqual(result.acceptanceEvidenceLinks, [
      { id: 'AC-2', evidence: ['artifacts/after.png'] },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a finished run whose slot no longer holds its task reads its recorded task directory', async () => {
  // The slot fixture has no taskFile, as after a release; the run keeps the
  // gateway's copy of its task directory, which run artifacts are served from.
  const fixture = writeFixture(null);
  const taskDir = path.join(fixture.root, '.task', 'dev', 'demo');
  writeFileSync(path.join(taskDir, 'TASK.md'), '# Task\n');
  writeFileSync(
    path.join(taskDir, 'artifacts', 'evidence-manifest.json'),
    JSON.stringify({ standalone: [{ label: 'Teardown', covers: ['ac1'], file: 'teardown.png' }] }),
  );
  runs.set('run-released', {
    id: 'run-released',
    flowType: 'dev',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  try {
    const result = await taskProgress({ slotId: 'slot-acceptance', runId: 'run-released' });
    assert.equal(result.acceptanceCriteria?.length, 3);
    assert.deepEqual(result.acceptanceEvidenceLinks, [
      { id: 'AC-1', evidence: ['artifacts/teardown.png'] },
    ]);
    assert.equal(result.structured?.totalSteps, 2, 'the checklist reads from the same copy');

    await assert.rejects(
      taskProgress({ slotId: 'slot-acceptance', runId: 'run-unknown' }),
      /No task file for slot slot-acceptance/,
      'a run with no recorded copy still says why',
    );
  } finally {
    runs.delete('run-released');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
