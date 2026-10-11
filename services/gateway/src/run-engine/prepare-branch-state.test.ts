import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'prepare-intent-'));
process.env.FARMSLOT_RUNS_DIR = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
after(() => rmSync(root, { recursive: true, force: true }));
const { createRun, getRun, persistRunNow, updateRun } = await import('../runs/store.js');
const { recordInitialPrepareBranchState, updateRunSummaryAndBranch } =
  await import('./prepare-branch-state.js');

test('original slot binding records intent before an early recovery can begin', async () => {
  const run = createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: 'TEST-930', slotId: 'slot', branch: 'work' },
    { deferBackgroundPersist: true },
  );
  await recordInitialPrepareBranchState(run.id);
  assert.deepEqual(getRun(run.id)?.engineState?.prepareBranch, {
    slotId: 'slot',
    branch: 'work',
    started: false,
  });
  await persistRunNow(
    updateRun(run.id, {
      recoveryAttempts: [
        {
          id: 'retry',
          attempt: 1,
          stepName: 'write-task',
          status: 'started',
          triggeredBy: 'operator',
          startedAt: new Date().toISOString(),
        },
      ],
    }),
    'fixture recovery',
  );
  await recordInitialPrepareBranchState(run.id);
  assert.equal(getRun(run.id)?.engineState?.prepareBranch?.started, false);
});

test('legacy and skip-prepare recoveries cannot manufacture setup-not-started evidence', async () => {
  for (const skipPrepare of [false, true]) {
    const run = createRun(
      {
        flowType: 'dev',
        project: 'fixture',
        ticketOrPr: 'TEST-930',
        slotId: 'slot',
        branch: 'work',
        engineState: { flags: { skipPrepare } },
      },
      { deferBackgroundPersist: true },
    );
    await persistRunNow(
      updateRun(run.id, {
        recoveryAttempts: [
          {
            id: 'retry',
            attempt: 1,
            stepName: 'find-slot',
            status: 'started',
            triggeredBy: 'operator',
            startedAt: new Date().toISOString(),
          },
        ],
      }),
      'fixture recovery',
    );
    await recordInitialPrepareBranchState(run.id);
    assert.equal(getRun(run.id)?.engineState?.prepareBranch, undefined);
  }
});

test('a skipped original prepare does not record unused branch authority', async () => {
  const run = createRun(
    {
      flowType: 'dev',
      project: 'fixture',
      ticketOrPr: 'TEST-930',
      slotId: 'slot',
      branch: 'work',
      engineState: { flags: { skipPrepare: true } },
    },
    { deferBackgroundPersist: true },
  );
  await recordInitialPrepareBranchState(run.id);
  assert.equal(getRun(run.id)?.engineState?.prepareBranch, undefined);
});

test('an original branchless claim can record intent when its branch is assigned later', async () => {
  const run = createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: 'TEST-930', slotId: 'slot' },
    { deferBackgroundPersist: true },
  );
  await recordInitialPrepareBranchState(run.id);
  assert.equal(getRun(run.id)?.engineState?.prepareBranch, undefined);
  updateRun(run.id, { branch: 'late-work' });
  await recordInitialPrepareBranchState(run.id);
  assert.deepEqual(getRun(run.id)?.engineState?.prepareBranch, {
    slotId: 'slot',
    branch: 'late-work',
    started: false,
  });
});

test('first branch assignment records intent atomically on recovery before slot binding', async () => {
  const run = createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: 'TEST-930' },
    { deferBackgroundPersist: true },
  );
  updateRun(run.id, {
    recoveryAttempts: [
      {
        id: 'retry',
        attempt: 1,
        stepName: 'find-slot',
        status: 'started',
        triggeredBy: 'operator',
        startedAt: new Date().toISOString(),
      },
    ],
  });
  await updateRunSummaryAndBranch(run.id, { branch: 'first-work', summary: 'Recovered intake' });
  assert.equal(getRun(run.id)?.branch, 'first-work');
  assert.deepEqual(getRun(run.id)?.engineState?.prepareBranch, {
    slotId: undefined,
    branch: 'first-work',
    started: false,
  });
});

test('existing historical branches and skipped setup cannot gain first-assignment authority', async () => {
  for (const skipPrepare of [false, true]) {
    const run = createRun(
      {
        flowType: 'dev',
        project: 'fixture',
        ticketOrPr: 'TEST-930',
        ...(skipPrepare ? {} : { branch: 'existing-work' }),
        engineState: { flags: { skipPrepare } },
      },
      { deferBackgroundPersist: true },
    );
    await updateRunSummaryAndBranch(run.id, { branch: 'work', summary: 'Update' });
    assert.equal(getRun(run.id)?.engineState?.prepareBranch, undefined);
    await persistRunNow(getRun(run.id)!, 'fixture cleanup');
  }
});
