import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'workspace-template-replay-'));
for (const name of [
  'projects/demo/shared/review-pr',
  'pool',
  'source',
  'task/artifacts',
  'scripts',
  'services/gateway',
])
  mkdirSync(path.join(root, name), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  NODE_TEST_CONTEXT: '1',
});
writeFileSync(path.join(root, 'status.json'), '{"slots":[]}');
const template = '---\nplatforms: [cli]\n---\n\n- [ ] Review the frozen source.\n';
const expectedHash = createHash('sha256').update(template).digest('hex');
writeFileSync(path.join(root, 'projects/demo/shared/review-pr/default.md'), template);
writeFileSync(
  path.join(root, 'projects/demo/project.json'),
  JSON.stringify({
    name: 'demo',
    repo_url: 'https://github.com/example/repo.git',
    static_review: { template_id: 'review-pr/default' },
    execution_templates: {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
  }),
);
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'localhost',
    host: 'localhost',
    project: 'demo',
    platform: 'cli',
    slots: [],
    review_workspaces: { max_concurrent: 1 },
  }),
);
after(() => rmSync(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
let materialized = 0;
mock.module('./task.js', {
  namedExports: {
    materializeReviewWorkspaceTask: async (runId: string) => {
      assert.equal(
        getRun(runId)?.executionTemplate?.sha256,
        expectedHash,
        'the production writer must persist its selected template before materialization',
      );
      materialized++;
      return { prompt: 'Review the frozen source.', taskFile: path.join(root, 'task/TASK.md') };
    },
    readReviewWorkspaceProgress: async () => null,
    refreshReviewWorkspaceView: async () => 0,
    readReviewWorkspaceSignal: async () => null,
    readReviewWorkspaceCompletion: async () => null,
    collectReviewWorkspaceSubtaskMetrics: async () => null,
    reviewWorkspaceProgressLocation: async () => ({
      io: { host: 'localhost', machine: 'localhost' },
      taskDir: path.join(root, 'task'),
      checklistPath: path.join(root, 'task/CHECKLIST.md'),
    }),
  },
});
const support = await import('./support.js');
mock.module('./support.js', {
  namedExports: { ...support, ensureReviewWorkspaceSupport: async () => {} },
});
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const auth = createGatewayAuthRuntime({
  FARMSLOT_HOME: process.env.FARMSLOT_HOME!,
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
});
const owner = auth.writer.createPrincipal({ type: 'person', displayName: 'Replay fixture' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { createRun, getRun, updateRun, persistRunNow } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const { executeReviewWorkspaceStep } = await import('./pipeline.js');

test('static task replay reselects its cleared template before materialization', async (t) => {
  const created = runWithSessionOriginator(owner, () =>
    createRun(
      {
        flowType: 'review-pr',
        project: 'demo',
        ticketOrPr: 'example/repo#1',
        runner: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        transport: 'tmux',
        reviewWorkspaceTarget: { machine: 'localhost' },
      },
      { deferBackgroundPersist: true },
    ),
  );
  const run = updateRun(created.id, {
    status: 'preparing',
    slotId: null,
    engineState: { generation: 1 },
    executionTemplate: undefined,
    reviewWorkspace: {
      workspaceId: 'owned-replay',
      machine: 'localhost',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'source'),
      taskPath: path.join(root, 'task'),
      artifactPath: path.join(root, 'task/artifacts'),
    },
    reviewWorkspaceSubject: {
      repository: 'example/repo',
      repositoryUrl: 'https://github.com/example/repo.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Review',
      body: '',
      url: 'https://github.com/example/repo/pull/1',
      capturedAt: created.createdAt,
    },
  });
  await persistRunNow(run, 'private replay fixture');
  t.after(async () => {
    const latest = getRun(run.id)!;
    await persistRunNow(
      updateRun(run.id, {
        status: 'cancelled',
        reviewWorkspace: { ...latest.reviewWorkspace!, cleanedAt: new Date().toISOString() },
      }),
      'private replay cleanup',
    );
    await deleteTestRunIfPresent(run.id);
  });
  const result = await executeReviewWorkspaceStep(run.id, PipelineSteps.WRITE_TASK, 1, () => {});
  const current = getRun(run.id)!;
  assert.equal(materialized, 1);
  assert.equal(current.executionTemplate?.id, 'review-pr/default');
  assert.equal(current.executionTemplate?.sha256, expectedHash);
  assert.equal(current.nativeOwnerPrincipalId, run.nativeOwnerPrincipalId);
  assert.equal(current.engineState?.generation, 1);
  assert.deepEqual(current.reviewWorkspaceSubject, run.reviewWorkspaceSubject);
  assert.equal(result.outputs?.taskFile, path.join(root, 'task/TASK.md'));
});
