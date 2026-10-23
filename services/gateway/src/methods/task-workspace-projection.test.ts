// `task.progress` for a slot-free static review workspace (ADR-058) reports the
// same ADR-060 sidecars a slot run does: the child checklist unit under its
// parent step, and the acceptance ledger with the criteria it judges.
//
// Run and pool lookups are injected. File reads stay real, with a wrapper that
// can replace the owner during I/O. The method resolves the task directory and
// reads its shared subtask and acceptance files.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { PoolConfig, Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import * as realIo from '../core/slot-io.js';
import * as realFleetState from '../fleet/state.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import * as realRunStore from '../runs/store.js';

let workspaceRun: Run | undefined;
let snapshotRoot = '';
let beforeRead: (() => void) | undefined;

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) => (workspaceRun?.id === id ? workspaceRun : undefined),
    listRuns: () => ({ runs: [], totalCount: 0 }),
    runsDirectory: () => snapshotRoot,
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
  snapshotRoot = path.join(root, 'gateway-runs');
  workspaceRun = workspaceRunFor(root);
  try {
    await work(root);
  } finally {
    workspaceRun = undefined;
    beforeRead = undefined;
    snapshotRoot = '';
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

const SELECTED = '# Retained review\n- [x] **1. inspected**\n- [x] **2. recorded**\n';
const SELECTED_RELATIVE = 'artifacts/review-1.md';

function declareSelected(artifact: string): void {
  workspaceRun = {
    ...workspaceRun!,
    steps: [{ name: 'review', status: 'done', outputs: { taskProgressArtifactPath: artifact } }],
  };
}

test('a workspace selected artifact reads its declared file and keeps task-level acceptance', async () => {
  await withWorkspace(async (root) => {
    const artifact = path.join(root, 'task', SELECTED_RELATIVE);
    writeFileSync(artifact, SELECTED);
    declareSelected(artifact);
    for (const taskFile of [artifact, SELECTED_RELATIVE]) {
      const progress = await taskProgress({ slotId: '', runId: 'workspace-projection', taskFile });
      assert.equal(progress.markdown, SELECTED);
      assert.equal(progress.structured?.completedSteps, 2);
      assert.equal(progress.structured?.totalSteps, 2);
      assert.equal(progress.acceptanceStatus?.criteria[0].verdict, 'proven');
      assert.deepEqual(progress.acceptanceCriteria, [
        { id: 'AC-1', text: 'Every blocking finding is named.' },
      ]);
      assert(
        progress.structured?.phases.every((phase) => phase.steps.every((step) => !step.subtask)),
        'The current parent child registry must not rewrite a retained selected-step checklist',
      );
    }
    const parent = await taskProgress({ slotId: '', runId: 'workspace-projection' });
    assert.equal(parent.markdown, PARENT);
    assert.equal(parent.structured?.totalSteps, 3);
  });
});

test('cleaned workspace selections map the original task root and relative declarations into its view', async () => {
  await withWorkspace(async (root) => {
    const task = path.join(root, 'task');
    const originalArtifact = path.join(task, SELECTED_RELATIVE);
    writeFileSync(originalArtifact, SELECTED);
    declareSelected(originalArtifact);
    const viewer = path.join(
      snapshotRoot,
      'review-workspace-tasks',
      'workspace-projection',
      'view',
    );
    cpSync(task, viewer, { recursive: true });
    workspaceRun = {
      ...workspaceRun!,
      reviewWorkspace: { ...workspaceRun!.reviewWorkspace!, cleanedAt: '2026-10-23T12:00:00Z' },
    };
    rmSync(task, { recursive: true });
    for (const taskFile of [
      originalArtifact,
      SELECTED_RELATIVE,
      path.join(viewer, SELECTED_RELATIVE),
    ]) {
      const progress = await taskProgress({ slotId: '', runId: 'workspace-projection', taskFile });
      assert.equal(progress.markdown, SELECTED);
      assert.equal(progress.structured?.completedSteps, 2);
      assert.equal(progress.acceptanceStatus?.criteria[0].verdict, 'proven');
    }
    declareSelected(SELECTED_RELATIVE);
    assert.equal(
      (
        await taskProgress({
          slotId: '',
          runId: 'workspace-projection',
          taskFile: originalArtifact,
        })
      ).markdown,
      SELECTED,
      'A task-relative declaration also resolves the original absolute selection',
    );
    const parent = await taskProgress({ slotId: '', runId: 'workspace-projection' });
    assert.equal(parent.markdown, PARENT);
    assert.equal(
      parent.structured?.phases.flatMap((phase) => phase.steps).find((step) => step.index === 2)
        ?.subtask?.id,
      'perps-review',
      'Default cleaned progress still uses the parent checklist and its own child sidecars',
    );
  });
});

test('workspace selections refuse undeclared, traversal, foreign and escaping symlink files', async () => {
  await withWorkspace(async (root) => {
    const artifact = path.join(root, 'task', SELECTED_RELATIVE);
    const foreign = path.join(root, 'foreign.md');
    writeFileSync(artifact, SELECTED);
    writeFileSync(foreign, '# Foreign private file\n');
    declareSelected(SELECTED_RELATIVE);
    const refused = (taskFile: string) =>
      assert.rejects(
        taskProgress({ slotId: '', runId: 'workspace-projection', taskFile }),
        (error: unknown) => error instanceof GatewayMethodError && error.code === 'NOT_FOUND',
      );
    await refused('CHECKLIST.md');
    await refused(foreign);
    declareSelected(foreign);
    await refused(foreign);
    declareSelected('../foreign.md');
    await refused('../foreign.md');
    declareSelected('artifacts/../CHECKLIST.md');
    await refused('artifacts/../CHECKLIST.md');

    const link = path.join(root, 'task', 'artifacts', 'linked-review.md');
    symlinkSync(foreign, link);
    declareSelected('artifacts/linked-review.md');
    await assert.rejects(
      taskProgress({ slotId: '', runId: 'workspace-projection', taskFile: link }),
      /escapes its task directory/,
    );
  });
});

test('cleaned selected artifacts cannot escape the retained view through a symlink', async () => {
  await withWorkspace(async (root) => {
    const viewer = path.join(
      snapshotRoot,
      'review-workspace-tasks',
      'workspace-projection',
      'view',
    );
    cpSync(path.join(root, 'task'), viewer, { recursive: true });
    const foreign = path.join(root, 'foreign.md');
    writeFileSync(foreign, '# Foreign retained file\n');
    symlinkSync(foreign, path.join(viewer, SELECTED_RELATIVE));
    declareSelected(SELECTED_RELATIVE);
    workspaceRun = {
      ...workspaceRun!,
      reviewWorkspace: { ...workspaceRun!.reviewWorkspace!, cleanedAt: '2026-10-23T12:00:00Z' },
    };
    await assert.rejects(
      taskProgress({ slotId: '', runId: 'workspace-projection', taskFile: SELECTED_RELATIVE }),
      /escapes its task directory/,
    );
  });
});

test('a selected workspace read rejects owner, declaration or workspace replacement during real I/O', async () => {
  await withWorkspace(async (root) => {
    writeFileSync(path.join(root, 'task', SELECTED_RELATIVE), SELECTED);
    declareSelected(SELECTED_RELATIVE);
    const original = workspaceRun!;
    for (const changed of [
      { ...original, nativeOwnerPrincipalId: 'replacement-owner' },
      { ...original, steps: [] },
      {
        ...original,
        reviewWorkspace: { ...original.reviewWorkspace!, workspaceId: 'replacement-workspace' },
      },
    ]) {
      workspaceRun = original;
      beforeRead = () => {
        workspaceRun = changed;
      };
      await assert.rejects(
        taskProgress({ slotId: '', runId: 'workspace-projection', taskFile: SELECTED_RELATIVE }),
        (error: unknown) =>
          error instanceof GatewayMethodError && error.code === 'PROGRESS_OWNER_CHANGED',
      );
    }
  });
});
