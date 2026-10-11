import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prepareSkipReason,
  safeRecipeToolingProvenance,
  safeReferenceRepoProvenance,
  shouldForceNewPrepareBranch,
} from './dispatch-lifecycle-steps.js';
import { makeRun } from './test-fixtures.js';

test('fresh dev and fix-bug runs may create new work branches', () => {
  for (const flowType of ['dev', 'fix-bug'] as const) {
    assert.equal(shouldForceNewPrepareBranch(makeRun({ flowType })), true);
  }
  assert.equal(shouldForceNewPrepareBranch(makeRun({ flowType: 'review-pr' })), false);
});

test('same-run replay reuses the branch regardless of its entry step', () => {
  for (const stepName of ['find-slot', 'grade', 'write-task', 'prepare'] as const) {
    const run = makeRun({ flowType: 'dev' });
    run.recoveryAttempts = [
      {
        id: 'retry',
        attempt: 1,
        stepName,
        startedAt: run.updatedAt,
        status: 'started',
        triggeredBy: 'operator',
      },
    ];
    assert.equal(shouldForceNewPrepareBranch(run), false, stepName);
    run.recoveryAttempts[0].status = 'completed';
    assert.equal(shouldForceNewPrepareBranch(run), false, `completed ${stepName}`);
  }
});

test('startup recovery and a previously prepared run never force a new branch', () => {
  const run = makeRun({ flowType: 'dev' });
  assert.equal(shouldForceNewPrepareBranch(run, true), false);
  run.engineState = { prepareBranch: { slotId: run.slotId!, branch: run.branch!, started: true } };
  assert.equal(shouldForceNewPrepareBranch(run), false);
});

test('static PR review runs minimal prepare unless the operator explicitly skips', () => {
  assert.equal(prepareSkipReason(false), null);
  assert.equal(prepareSkipReason(true), 'operator-skip');
});

test('safeRecipeToolingProvenance keeps the version contract without arbitrary doctor data', () => {
  assert.deepEqual(
    safeRecipeToolingProvenance({
      schemaVersion: 1,
      protocolVersion: 'v1',
      runner_protocol_version: 1,
      status: 'pass',
      adapter: 'core',
      target: '/private/checkout',
      runner: {
        packageName: '@deeeed/metamask-harness',
        version: '0.24.0',
        packageSource: 'node_modules',
        installKind: 'global-install',
        executablePath: '/private/bin/mm-harness',
      },
      requiredChecks: { status: 'pass', total: 1, passed: 1, failed: [] },
      unbounded: { nested: 'discarded' },
    }),
    {
      schemaVersion: 1,
      protocolVersion: 'v1',
      runner_protocol_version: 1,
      status: 'pass',
      adapter: 'core',
      runner: {
        packageName: '@deeeed/metamask-harness',
        version: '0.24.0',
        packageSource: 'node_modules',
        installKind: 'global-install',
      },
      requiredChecks: { status: 'pass', total: 1, passed: 1, failed: [] },
    },
  );
});

test('safeReferenceRepoProvenance omits credential-bearing repository URLs', () => {
  assert.deepEqual(
    safeReferenceRepoProvenance({
      version: 1,
      recordedAt: '2026-07-29T21:00:00Z',
      repositories: [
        {
          name: 'harness',
          localName: 'metamask-harness',
          path: '/repo/metamask-harness',
          requestedUrl: 'https://token@example.com/repo.git',
          originUrl: 'https://user:secret@example.com/repo.git',
          requestedBranch: 'main',
          actualBranch: 'main',
          head: 'abc123',
          dirty: false,
          syncStatus: 'updated',
        },
      ],
    }),
    {
      version: 1,
      recordedAt: '2026-07-29T21:00:00Z',
      repositories: [
        {
          name: 'harness',
          localName: 'metamask-harness',
          path: '/repo/metamask-harness',
          requestedBranch: 'main',
          actualBranch: 'main',
          head: 'abc123',
          dirty: false,
          syncStatus: 'updated',
        },
      ],
    },
  );
});
