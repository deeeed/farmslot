import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { WebSocket } from 'ws';

import type { PRWorkspaceExecutionProfile } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'pr-execution-workspace-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects/review']) {
  mkdirSync(path.join(root, dir), { recursive: true });
}
writeFileSync(path.join(root, 'CLAUDE.md'), '# Test root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'projects/review/project.json'),
  JSON.stringify({
    name: 'review',
    repo_url: 'https://github.com/owner/repo.git',
    ci: { repo: 'owner/repo' },
    static_review: { template_id: 'team/review' },
    execution_templates: { sources: [], defaults: [] },
  }),
);
writeFileSync(
  path.join(root, 'pool/review.json'),
  JSON.stringify({
    machine: 'review-node',
    project: 'review',
    host: 'localhost',
    slots: [],
    review_workspaces: { max_concurrent: 2 },
  }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-owner';
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
after(() => rmSync(root, { recursive: true, force: true }));

const { resolvePRExecution } = await import('./pr-execution.js');
const { inspectReviewWorkspaceTarget, assertReviewWorkspaceAdmitted } =
  await import('../review-workspaces/admission.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { createRun, deleteRun } = await import('../runs/store.js');
const { updateMachineMetrics, resetPressureHistoryForTest } =
  await import('../fleet/node-health.js');
const execution: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['missing-node', 'review-node'] },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
  transport: 'native',
};

test('workspace execution resolves authorized machine alternatives without any device slots', async () => {
  const resolved = await resolvePRExecution('review', 'owner/repo', [execution], {
    ownerId: 'review-owner',
  });
  assert.deepEqual(resolved, {
    choices: [
      {
        machine: 'review-node',
        runner: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        transport: 'native',
      },
    ],
    errors: [],
  });
});

const admissionInput = {
  project: 'review',
  machine: 'review-node',
  runner: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  transport: 'native' as const,
};

test('workspace admission requires machine opt-in and valid explicit runner/model/effort', async (t) => {
  await inspectReviewWorkspaceTarget({ ...admissionInput, transport: 'tmux' }, 'review-owner');
  for (const change of [
    { runner: 'claude', model: 'sonnet' },
    { model: 'unknown' },
    { model: '' },
    { effort: 'unsupported-effort' },
    { transport: undefined },
  ]) {
    await assert.rejects(
      inspectReviewWorkspaceTarget({ ...admissionInput, ...change }, 'review-owner'),
      { code: 'REVIEW_WORKSPACE_UNSUPPORTED' },
    );
  }
  const noCapacity = path.join(root, 'pool/no-capacity.json');
  writeFileSync(
    noCapacity,
    JSON.stringify({ machine: 'no-capacity', project: 'review', host: 'localhost', slots: [] }),
  );
  t.after(() => rmSync(noCapacity));
  await assert.rejects(
    inspectReviewWorkspaceTarget({ ...admissionInput, machine: 'no-capacity' }, 'review-owner'),
    { code: 'REVIEW_WORKSPACE_NEEDS_CONFIGURATION' },
  );
  const duplicate = path.join(root, 'pool/duplicate.json');
  writeFileSync(
    duplicate,
    JSON.stringify({
      machine: 'review-node',
      project: 'review',
      host: 'localhost',
      slots: [],
      review_workspaces: { max_concurrent: 2 },
    }),
  );
  t.after(() => rmSync(duplicate));
  await assert.rejects(inspectReviewWorkspaceTarget(admissionInput, 'review-owner'), /exactly one/);
});

test('remote workspace admission requires current node ownership and worker capabilities', async (t) => {
  const file = path.join(root, 'pool/remote.json');
  writeFileSync(
    file,
    JSON.stringify({
      machine: 'remote',
      project: 'review',
      host: 'review.example.invalid',
      slots: [],
      review_workspaces: { max_concurrent: 2 },
    }),
  );
  t.after(() => rmSync(file));
  const input = { ...admissionInput, machine: 'remote' };
  await assert.rejects(inspectReviewWorkspaceTarget(input, 'review-owner'), {
    code: 'NATIVE_SESSION_ERROR',
  });
  const ws = {} as WebSocket;
  t.after(() => unregisterByWs(ws));
  const declaration = {
    ownerPrincipalId: 'review-owner',
    supportsWorkers: true,
    supportsEnsure: true,
  };
  let authorityValid = true;
  const authority = { principalId: 'node-owner', valid: () => authorityValid };
  registerNode('remote', 1, ws, undefined, undefined, declaration, authority);
  assert.equal(
    (await inspectReviewWorkspaceTarget(input, 'review-owner')).executionNodeId,
    'remote',
  );
  await assert.rejects(inspectReviewWorkspaceTarget(input, 'other'), {
    code: 'NATIVE_SESSION_ERROR',
  });
  authorityValid = false;
  await assert.rejects(inspectReviewWorkspaceTarget(input, 'review-owner'), {
    code: 'NATIVE_SESSION_ERROR',
  });
  authorityValid = true;
  for (const denied of [{ supportsWorkers: false }, { supportsEnsure: false }]) {
    registerNode('remote', 1, ws, undefined, undefined, { ...declaration, ...denied }, authority);
    await assert.rejects(inspectReviewWorkspaceTarget(input, 'review-owner'), {
      code: 'REVIEW_WORKSPACE_UNSUPPORTED',
    });
  }
});

test('workspace native profile is bound to the selected execution node and runner', async () => {
  const profile = {
    executionNodeId: 'local',
    runner: 'codex',
    profileId: 'review',
    accountContextId: '00000000-0000-0000-0000-000000000001',
  };
  await inspectReviewWorkspaceTarget({ ...admissionInput, nativeProfile: profile }, 'review-owner');
  for (const changed of [{ executionNodeId: 'remote' }, { runner: 'claude' }]) {
    await assert.rejects(
      inspectReviewWorkspaceTarget(
        { ...admissionInput, nativeProfile: { ...profile, ...changed } },
        'review-owner',
      ),
      { code: 'AUTH_FORBIDDEN' },
    );
  }
});

test('capacity admission rechecks current runs instead of using an earlier preview count', async (t) => {
  const admission = await inspectReviewWorkspaceTarget(admissionInput, 'review-owner');
  assert.equal(admission.active, 0);
  const runs = Array.from({ length: admission.limit }, (_, index) =>
    createRun(
      {
        project: 'review',
        flowType: 'review-pr',
        ticketOrPr: `owner/repo#${index + 1}`,
        reviewWorkspaceTarget: { machine: 'review-node' },
      },
      { deferBackgroundPersist: true },
    ),
  );
  t.after(async () => {
    for (const run of runs) {
      run.status = 'cancelled';
      await deleteRun(run.id);
    }
  });
  assert.throws(() => assertReviewWorkspaceAdmitted(admission), {
    code: 'REVIEW_WORKSPACE_CAPACITY',
  });
  assert.doesNotThrow(() => assertReviewWorkspaceAdmitted(admission, runs[0].id));
});

test('workspace admission uses the shared sustained pressure decision', async (t) => {
  process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'refuse';
  t.after(() => {
    process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
    resetPressureHistoryForTest();
  });
  for (let index = 0; index < 3; index++) {
    updateMachineMetrics('review-node', {
      cpuPercent: 100,
      memoryPercent: 99,
      memoryUsedGb: 15.8,
      memoryTotalGb: 16,
      diskPercent: 20,
      loadAvg1: 12,
      loadAvg5: 12,
      cpuCores: 4,
      collectedAt: new Date(Date.now() - (2 - index) * 1000).toISOString(),
    });
  }
  const admission = await inspectReviewWorkspaceTarget(admissionInput, 'review-owner');
  assert.equal(admission.pressure.outcome, 'rejected');
  assert.throws(() => assertReviewWorkspaceAdmitted(admission), {
    code: 'REVIEW_WORKSPACE_PRESSURE',
  });
});

test('workspace execution rejects missing owner, other owner, wrong repository and implicit transport', async () => {
  const missingOwner = await resolvePRExecution('review', 'owner/repo', [execution]);
  assert.deepEqual(missingOwner.choices, []);
  assert.match(missingOwner.errors.join('; '), /owner/);
  const otherOwner = await resolvePRExecution('review', 'owner/repo', [execution], {
    ownerId: 'other',
  });
  assert.deepEqual(otherOwner.choices, []);
  assert.match(otherOwner.errors.join('; '), /does not own/);
  const wrongRepo = await resolvePRExecution('review', 'other/repo', [execution], {
    ownerId: 'review-owner',
  });
  assert.deepEqual(wrongRepo.choices, []);
  assert.match(wrongRepo.errors.join('; '), /repository/);
  const implicit = await resolvePRExecution(
    'review',
    'owner/repo',
    [{ ...execution, transport: undefined }],
    { ownerId: 'review-owner' },
  );
  assert.deepEqual(implicit.choices, []);
  assert.match(implicit.errors.join('; '), /transport/);
});
