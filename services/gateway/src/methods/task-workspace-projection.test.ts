// `task.progress` for a slot-free static review workspace (ADR-058) reports the
// same ADR-060 sidecars a slot run does: the child checklist unit under its
// parent step, and the acceptance ledger with the criteria it judges.
//
// The run and the pool are the only mocks. Everything under them is real: the
// method resolves the workspace's own task directory and reads the files there
// through the shared subtask and acceptance read layers.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { PoolConfig, Run } from '@farmslot/protocol';

import * as realFleetState from '../fleet/state.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import * as realRunStore from '../runs/store.js';

let workspaceRun: Run | undefined;

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) => (workspaceRun?.id === id ? workspaceRun : undefined),
    listRuns: () => ({ runs: [], totalCount: 0 }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadPoolConfigs: async () => [
      { machine: 'local', host: 'localhost', sshUser: 'fixture' } as PoolConfig,
    ],
  },
});

const { taskProgress } = await import('./task.js');

const PARENT = [
  '# Review',
  '',
  '- [x] **1. read the exact diff**',
  '- [ ] **2. run the domain review**',
  '- [ ] **3. write the report**',
  '',
].join('\n');

const CHILD = [
  '# Perps review',
  '',
  '- [x] **1. read the diff**',
  '- [ ] **2. check the domain patterns**',
  '',
].join('\n');

function writeWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-workspace-projection-'));
  const taskDir = path.join(root, 'task');
  mkdirSync(path.join(taskDir, 'subtasks'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  writeFileSync(path.join(taskDir, 'CHECKLIST.md'), PARENT);
  writeFileSync(path.join(taskDir, 'subtasks', 'perps-review.md'), CHILD);
  writeFileSync(
    path.join(taskDir, 'subtasks', 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          id: 'perps-review',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
          checklist: 'subtasks/perps-review.md',
          signal: 'subtasks/perps-review-SIGNAL.json',
          source: {
            kind: 'skill',
            ref: 'skills/perps-review.md',
            sha256: 'aa',
            renderedSha256: 'bb',
          },
          registeredAt: '2026-09-20T09:00:00Z',
        },
      ],
    })}\n`,
  );
  writeFileSync(
    path.join(taskDir, 'subtasks', 'perps-review-SIGNAL.json'),
    `${JSON.stringify({
      role: 'subtask',
      contextId: 'perps-review',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
      status: 'running',
      checklistTiming: {
        schemaVersion: 1,
        source: 'subtasks/perps-review.md',
        events: [{ stepNumber: 1, label: '1. read the diff', checkedAt: new Date().toISOString() }],
      },
    })}\n`,
  );
  writeFileSync(
    path.join(taskDir, 'inputs', 'handoff.json'),
    `${JSON.stringify({ task: { acceptanceCriteria: ['Every blocking finding is named.'] } })}\n`,
  );
  writeFileSync(
    path.join(taskDir, 'artifacts', 'acceptance-status.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Every blocking finding is named.',
          verdict: 'proven',
          evidence: ['artifacts/review.md'],
          recipeNodes: [],
          updatedAt: '2026-09-20T09:05:00Z',
        },
      ],
    })}\n`,
  );
  return root;
}

function workspaceRunFor(root: string): Run {
  const taskDir = path.join(root, 'task');
  return {
    ...makeRun({
      id: 'workspace-projection',
      slotId: null,
      flowType: 'review-pr',
      project: 'fixture',
      mode: 'autonomous',
    }),
    nativeOwnerPrincipalId: 'fixture-owner',
    transport: 'native',
    executionTemplate: {
      id: 'review-pr/static-perps',
      sourceId: 'fixture',
      flow: 'review-pr',
      platforms: ['web'],
      labels: [],
      relativePath: 'worker/review-pr.md',
      sha256: 'a'.repeat(64),
    },
    reviewWorkspaceSubject: {
      repository: 'example/project',
      repositoryUrl: 'https://github.com/example/project.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature/child-units',
      title: 'Review fixture',
      body: 'Offline PR body.',
      capturedAt: '2026-09-20T08:00:00Z',
    },
    reviewWorkspaceTarget: { machine: 'local' },
    reviewWorkspace: {
      workspaceId: 'workspace-projection',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'source'),
      taskPath: taskDir,
      artifactPath: path.join(taskDir, 'artifacts'),
    },
  };
}

async function withWorkspace(work: (root: string) => Promise<void>): Promise<void> {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-owner';
  const root = writeWorkspace();
  workspaceRun = workspaceRunFor(root);
  try {
    await work(root);
  } finally {
    workspaceRun = undefined;
    rmSync(root, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  }
}

test('workspace progress projects the child unit under its parent step', async () => {
  await withWorkspace(async () => {
    const progress = await taskProgress({ slotId: '', runId: 'workspace-projection' });
    assert.equal(progress.slotId, '');
    assert.equal(progress.contextId, 'review');
    const steps = (progress.structured?.phases ?? []).flatMap((phase) => phase.steps);
    assert.equal(steps.length, 3);
    assert.equal(steps.find((step) => step.index === 1)?.subtask, undefined);
    const child = steps.find((step) => step.index === 2)?.subtask;
    assert.equal(child?.id, 'perps-review');
    assert.equal(child?.status, 'running');
    assert.equal(child?.source.kind, 'skill');
    assert.equal(child?.progress.completedSteps, 1);
    assert.equal(child?.progress.totalSteps, 2);
    assert.ok(child?.lastEventAt, 'the child reports its newest mark');
  });
});

test('workspace progress carries the acceptance ledger and its criteria', async () => {
  await withWorkspace(async () => {
    const progress = await taskProgress({ slotId: '', runId: 'workspace-projection' });
    assert.deepEqual(progress.acceptanceCriteria, [
      { id: 'AC-1', text: 'Every blocking finding is named.' },
    ]);
    assert.equal(progress.acceptanceStatus?.criteria[0].verdict, 'proven');
    assert.equal(progress.acceptanceStatusError, undefined);
  });
});

test('workspace progress reports an unreadable ledger instead of dropping it', async () => {
  await withWorkspace(async (root) => {
    writeFileSync(path.join(root, 'task', 'artifacts', 'acceptance-status.json'), '{ not json');
    const progress = await taskProgress({ slotId: '', runId: 'workspace-projection' });
    assert.match(progress.acceptanceStatusError ?? '', /acceptance-status\.json/);
    assert.equal(progress.acceptanceStatus, undefined);
  });
});

test('workspace progress fails loudly on a corrupt child registry', async () => {
  await withWorkspace(async (root) => {
    writeFileSync(path.join(root, 'task', 'subtasks', 'index.json'), '{"schemaVersion":2}');
    await assert.rejects(
      taskProgress({ slotId: '', runId: 'workspace-projection' }),
      /schemaVersion/,
    );
  });
});
