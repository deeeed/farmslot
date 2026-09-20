// Child checklist units (ADR-060) on a slot-free static review workspace
// (ADR-058). Every assertion here runs against a REAL workspace task directory:
// `materializeReviewWorkspaceTask` writes it, the task dir's own `mark` shim
// drives the child lifecycle, and the gateway reads the files the worker wrote.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { PoolConfig, ReviewWorkspaceSubject, Run } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { resolveConfiguredExecutionTemplate } from '../tasks/execution-template-catalog.js';

import {
  collectReviewWorkspaceSubtaskMetrics,
  materializeReviewWorkspaceTask,
  readReviewWorkspaceCompletion,
  readReviewWorkspaceProgress,
  refreshReviewWorkspaceView,
} from './task.js';

const exec = promisify(execFile);
const checklist = '# Review\n\n- [ ] Read the exact diff.\n- [ ] Write review artifacts.\n';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-subtask-'));
  const projectRoot = path.join(root, 'pack');
  await mkdir(path.join(projectRoot, 'templates/worker'), { recursive: true });
  await mkdir(path.join(projectRoot, 'fixtures'));
  await mkdir(path.join(root, 'source'));
  await writeFile(path.join(projectRoot, 'templates/worker/review-pr.md'), checklist);
  const project: ProjectVars = {
    projectName: 'fixture',
    projectConfig: path.join(projectRoot, 'project.json'),
    projectTemplatesDir: path.join(projectRoot, 'templates'),
    projectFixturesDir: path.join(projectRoot, 'fixtures'),
    projectJson: {
      execution_templates: {},
      static_review: { template_id: 'review-pr/default', instruction_files: [] },
    },
    runtimeDir: '.agent',
    artifactDir: 'artifacts',
  };
  await writeFile(project.projectConfig, JSON.stringify(project.projectJson));
  const selection = resolveConfiguredExecutionTemplate(project, {
    flow: 'review-pr',
    platform: 'web',
    runMode: 'autonomous',
  });
  const subject: ReviewWorkspaceSubject = {
    repository: 'example/project',
    repositoryUrl: 'https://github.com/example/project.git',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: 'feature/child-units',
    title: 'Review fixture',
    body: 'Offline PR body.',
    capturedAt: new Date().toISOString(),
  };
  const run: Run = {
    ...makeRun({
      id: 'workspace-subtask-test',
      slotId: null,
      flowType: 'review-pr',
      project: 'fixture',
      mode: 'autonomous',
      ticketOrPr: 'https://github.com/example/project/pull/7',
    }),
    nativeOwnerPrincipalId: 'fixture-owner',
    transport: 'native',
    executionTemplate: selection.reference,
    reviewWorkspaceSubject: subject,
    reviewWorkspaceTarget: { machine: 'local' },
    reviewWorkspace: {
      workspaceId: 'workspace-subtask',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'source'),
      taskPath: path.join(root, 'task'),
      artifactPath: path.join(root, 'task/artifacts'),
    },
  };
  const deps = {
    getRun: () => run,
    loadProjectVars: async () => project,
    loadPoolConfigs: async () => [
      { machine: 'local', host: 'localhost', sshUser: 'fixture' } as PoolConfig,
    ],
    snapshotRoot: () => path.join(root, 'gateway-snapshots'),
  };
  return { root, run, subject, deps, task: run.reviewWorkspace!.taskPath };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function withFixture(work: (f: Fixture) => Promise<void>) {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-owner';
  const f = await fixture();
  try {
    await work(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  }
}

/** The task dir's own marker, as the reviewer runs it. */
function marker(f: Fixture) {
  return (...args: string[]) =>
    exec(path.join(f.task, 'mark'), args, {
      cwd: f.task,
      env: { ...process.env, FARMSLOT_MARK_CMD: '' },
      maxBuffer: 256 * 1024,
    });
}

function acceptedContext(f: Fixture, startedAt: string): void {
  f.run.agentContexts = [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      slotId: null,
      runId: f.run.id,
      status: 'working',
      nativeSession: {
        sessionId: 'session',
        leaseId: 'lease',
        commandId: 'command',
        ownerPrincipalId: 'fixture-owner',
        executionNodeId: 'local',
        generation: 'generation',
        acceptedAt: startedAt,
        launchRequestedAt: startedAt,
      },
    },
  ];
}

function viewPath(f: Fixture, ...parts: string[]): string {
  return path.join(f.deps.snapshotRoot(), f.run.id, 'view', ...parts);
}

test('the view mirrors a live child unit and the ledger under the worker’s own names', async () => {
  await withFixture(async (f) => {
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const mark = marker(f);
    await mark('start');
    await mark(
      'sub',
      'start',
      'perps-review',
      '--step',
      '1',
      '--from',
      'inline:- [ ] **1. read the diff**\n- [ ] **2. check the domain patterns**\n',
    );
    await mark('sub', 'perps-review', '1');

    // Materialization left the pristine bundle in the view: no child files at all.
    await assert.rejects(readdir(viewPath(f, 'subtasks')), /ENOENT/);

    // A stale orchestrator-side mirror must never travel into the view.
    await writeFile(path.join(f.task, 'subtasks/index.json.worker'), '{"schemaVersion":1}\n');
    // A recorded verdict rides the same refresh.
    await writeFile(
      path.join(f.task, 'artifacts/acceptance-status.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        criteria: [
          {
            id: 'AC-1',
            text: 'The review names every blocking finding.',
            verdict: 'proven',
            evidence: ['artifacts/review.md'],
            recipeNodes: [],
            updatedAt: new Date().toISOString(),
          },
        ],
      })}\n`,
    );

    const copied = await refreshReviewWorkspaceView(f.run.id, f.deps);
    assert.equal(copied, 3, 'registry, child checklist and child signal');
    assert.deepEqual((await readdir(viewPath(f, 'subtasks'))).sort(), [
      'index.json',
      'perps-review-SIGNAL.json',
      'perps-review.md',
    ]);
    // The view keeps the worker's names, so the registry's own relative paths
    // resolve inside it.
    const index = JSON.parse(await readFile(viewPath(f, 'subtasks/index.json'), 'utf8'));
    assert.equal(index.units[0].checklist, 'subtasks/perps-review.md');
    assert.ok(await readFile(viewPath(f, index.units[0].checklist), 'utf8'));
    assert.equal(
      await readFile(viewPath(f, 'CHECKLIST.md'), 'utf8'),
      await readFile(path.join(f.task, 'CHECKLIST.md'), 'utf8'),
    );
    assert.equal(
      JSON.parse(await readFile(viewPath(f, 'artifacts/acceptance-status.json'), 'utf8'))
        .criteria[0].verdict,
      'proven',
    );
  });
});

test('workspace progress and child metrics read the live task, then the view after cleanup', async () => {
  await withFixture(async (f) => {
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const mark = marker(f);
    await mark('start');
    await mark(
      'sub',
      'start',
      'perps-review',
      '--step',
      '1',
      '--from',
      'inline:- [ ] **1. read**\n',
    );
    await mark('sub', 'perps-review', '1');
    await mark('sub', 'perps-review', 'complete', '--mark-last');

    const live = await readReviewWorkspaceProgress(f.run.id, f.deps);
    assert.equal(live.taskDir, f.task);
    assert.equal(live.checklistPath, path.posix.join(f.task, 'CHECKLIST.md'));
    assert.match(live.markdown, /- \[x\] Read the exact diff\./, 'the child ticked its parent box');

    const liveMetrics = await collectReviewWorkspaceSubtaskMetrics(f.run.id, f.deps);
    assert.equal(liveMetrics?.length, 1);
    assert.equal(liveMetrics?.[0].id, 'perps-review');
    assert.equal(liveMetrics?.[0].status, 'complete');
    assert.equal(liveMetrics?.[0].completedSteps, 1);
    assert.equal(liveMetrics?.[0].totalSteps, 1);
    assert.deepEqual(liveMetrics?.[0].parent, { checklist: 'CHECKLIST.md', stepNumber: 1 });

    await refreshReviewWorkspaceView(f.run.id, f.deps);
    // Cleanup removes the workspace; the view is the record from here on.
    f.run.reviewWorkspace!.cleanedAt = new Date().toISOString();
    await rm(f.task, { recursive: true, force: true });

    const retained = await readReviewWorkspaceProgress(f.run.id, f.deps);
    assert.equal(retained.taskDir, viewPath(f));
    assert.equal(retained.markdown, live.markdown);
    const retainedMetrics = await collectReviewWorkspaceSubtaskMetrics(f.run.id, f.deps);
    assert.deepEqual(retainedMetrics, liveMetrics);
  });
});

test('workspace completion refuses a terminal signal written around an open child', async () => {
  await withFixture(async (f) => {
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const startedAt = new Date().toISOString();
    acceptedContext(f, startedAt);
    const mark = marker(f);
    await mark('start');
    const started = JSON.parse(await readFile(path.join(f.task, 'SIGNAL.json'), 'utf8'));
    f.run.agentContexts![0].signalAttemptId = started.attemptId;
    await mark(
      'sub',
      'start',
      'evidence-pack',
      '--step',
      '2',
      '--from',
      'inline:- [ ] **1. collect the evidence paths**\n',
    );

    const report = `VERDICT: APPROVE\nCOMMIT: ${f.subject.headSha}\nNo findings.\n`;
    const result = {
      schemaVersion: 1,
      verdict: 'pass',
      issues: [],
      runId: f.run.id,
      workspaceId: f.run.reviewWorkspace!.workspaceId,
      headSha: f.subject.headSha,
      baseSha: f.subject.baseSha,
      attemptId: started.attemptId,
      reportSha256: digest(report),
    };
    await writeFile(path.join(f.task, 'artifacts/review.md'), report);
    await writeFile(path.join(f.task, 'artifacts/review-result.json'), JSON.stringify(result));
    await writeFile(path.join(f.task, 'artifacts/line-comments.json'), '{"comments":[]}');
    await writeFile(path.join(f.task, 'artifacts/learnings.md'), '- Nothing reusable.\n');

    // `mark complete` refuses while a child is open, so a signal that claims
    // completion here was written around the engine. The gateway must not accept it.
    await assert.rejects(mark('complete', '--mark-last'), /evidence-pack/);
    await writeFile(
      path.join(f.task, 'CHECKLIST.md'),
      (await readFile(path.join(f.task, 'CHECKLIST.md'), 'utf8')).replace(/- \[ \]/g, '- [x]'),
    );
    const handWrittenCompletion = async () =>
      writeFile(
        path.join(f.task, 'SIGNAL.json'),
        `${JSON.stringify({
          ...started,
          status: 'complete',
          outcome: 'success',
          disposition: 'fixed',
          timestamp: new Date().toISOString(),
        })}\n`,
      );
    await handWrittenCompletion();
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, f.deps),
      /subtask unit still open: evidence-pack/,
    );

    // Settling the child is what lets the same signal through. `mark sub complete`
    // rewrites the parent signal to the state the parent is actually in, so the
    // hand-written one is restored to isolate the child rule from that.
    await mark('sub', 'evidence-pack', 'complete', '--mark-last');
    await handWrittenCompletion();
    const completion = await readReviewWorkspaceCompletion(f.run.id, f.deps);
    assert.equal(completion?.result?.recommendation, 'APPROVE');
    // Completion's own view snapshot carries the child files too.
    assert.deepEqual((await readdir(viewPath(f, 'subtasks'))).sort(), [
      'evidence-pack-SIGNAL.json',
      'evidence-pack.md',
      'index.json',
    ]);
  });
});
