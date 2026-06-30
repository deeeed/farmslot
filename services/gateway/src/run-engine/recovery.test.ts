import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  recoverActiveRuns,
  recoveryHealthIsReady,
  type RunRecoveryCollaborators,
} from './recovery.js';

test('recoveryHealthIsReady requires configured ready indicator to match', () => {
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'OK\n' }, 'OK'), true);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'MANIFEST_ONLY\n' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: '' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 1, stdout: 'OK\n' }, 'OK'), false);
});

function minimalActiveRun(overrides: Partial<Run> = {}): Run {
  return {
    id: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    familyId: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    parentRunId: null,
    familyRootTicketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'writing-task',
    project: 'farmslot-farm',
    ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    slotId: 'macwork-ff-2',
    branch: null,
    taskFile: '/var/folders/xx/farmslot-package-drift-AbCdEf/task.md',
    steps: [{ name: 'write-task', status: 'running' }],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-06-30T14:08:05.000Z',
    updatedAt: '2026-06-30T14:25:00.000Z',
    ...overrides,
  };
}

test('recoverActiveRuns quarantines leaked gateway test runs before orchestration', async () => {
  let quarantined = false;
  const deps = {
    listRuns: () => ({ runs: [minimalActiveRun()] }),
    loadFleetStatus: async () => ({ slots: [] }),
    quarantineLeakedRun: async () => {
      quarantined = true;
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);
  assert.equal(quarantined, true);
});
