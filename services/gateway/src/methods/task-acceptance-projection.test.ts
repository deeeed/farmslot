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

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: () => undefined,
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
