#!/usr/bin/env tsx
/**
 * E2E for child checklist units (ADR-060) on a slot-free static review workspace
 * (ADR-058).
 *
 * Everything the gateway runs here is production code on a REAL workspace task
 * directory: `materializeReviewWorkspaceTask` writes it from a project-owned
 * template, the task dir's own `mark` shim drives the child lifecycle, and the
 * pipeline's own MONITOR step polls it — the same step, publisher, completion
 * read, metrics roll-up and view refresh a live review runs.
 *
 * What is NOT real is the reviewer process. A workspace dispatch cannot be driven
 * by the `scripted` runner the slot E2E uses: `launchReviewWorkspaceWorker`
 * refuses any runner without `supportsReadOnlyWorkspace` in its native runner
 * definition (`runnerSupportsReadonlyReviewWorkspace`), and the tmux transport
 * builds an interactive runner command for one of those runners too. So this
 * drives the `tmux` transport with a real tmux session standing in for the
 * reviewer pane, and runs `mark` itself — which is the whole worker-side contract
 * the gateway observes.
 *
 * Asserted, in order, against the live files:
 *   - MONITOR publishes TASK_PROGRESS_UPDATED with the child under its parent
 *     step, tagged `parentChecklist` when only the child moved;
 *   - the view (the operator-visible mirror) gains `subtasks/` under the worker's
 *     own names while the run is live, plus the acceptance ledger;
 *   - a terminal signal written around the mark engine with an open child is
 *     refused, naming the unit;
 *   - the completed run records every child on `run.metrics.subtasks`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stamp = `${process.pid}-${Date.now()}`;
const repoRoot = process.cwd();
const root = mkdtempSync(path.join(os.tmpdir(), `farmslot-workspace-subtask-${stamp}-`));
const OWNER = `workspace-subtask-owner-${stamp}`;
const PROJECT = `workspace-subtask-${stamp}`;
const WORKSPACE_ID = `workspace-subtask-${stamp}`;
const MACHINE = 'local';

const poolDir = path.join(root, 'pool');
const projectsDir = path.join(root, 'projects');
const runsDir = path.join(root, 'runs');
const projectDir = path.join(projectsDir, PROJECT);
const checkoutPath = path.join(root, 'source');
const taskPath = path.join(root, 'review-workspace', 'task');
const skillFixture = path.join(repoRoot, 'scripts', 'fixtures', 'subtask-skill.md');
const session = `review-${WORKSPACE_ID}`;

process.env.FARMSLOT_POOL_DIR = poolDir;
process.env.FARMSLOT_PROJECTS_DIR = projectsDir;
process.env.FARMSLOT_RUNS_DIR = runsDir;
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = OWNER;

const CHECKLIST = [
  '# Review',
  '',
  '## Review',
  '',
  '- [ ] **1. read the exact diff**',
  '- [ ] **2. run the domain review skill**',
  '- [ ] **3. write the review report**',
  '',
].join('\n');

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function writeFixtures(): void {
  mkdirSync(path.join(projectDir, 'templates', 'worker'), { recursive: true });
  mkdirSync(path.join(projectDir, 'fixtures'), { recursive: true });
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(checkoutPath, { recursive: true });
  writeFileSync(path.join(projectDir, 'templates', 'worker', 'review-pr.md'), CHECKLIST);
  writeFileSync(
    path.join(projectDir, 'project.json'),
    `${JSON.stringify(
      {
        name: PROJECT,
        paths: { runtime_dir: '.agent', artifact_dir: 'artifacts' },
        execution_templates: {},
        static_review: { template_id: 'review-pr/default', instruction_files: [] },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(poolDir, `${MACHINE}.json`),
    `${JSON.stringify(
      {
        machine: MACHINE,
        project: PROJECT,
        platform: 'cli',
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        host: 'localhost',
        ssh_user: process.env.USER || 'dev',
        slots: [],
      },
      null,
      2,
    )}\n`,
  );
  // A git checkout: the review terminal resolves the source's git root.
  run('git', ['init', '--quiet', checkoutPath]);
}

function run(command: string, args: string[], options: { ignoreFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (!options.ignoreFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function mark(args: string[], options: { expectFailure?: boolean } = {}): string {
  const result = spawnSync(path.join(taskPath, 'mark'), args, {
    cwd: taskPath,
    encoding: 'utf-8',
    env: { ...process.env, FARMSLOT_MARK_CMD: '' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (options.expectFailure) {
    assert.notEqual(
      result.status,
      0,
      `mark ${args.join(' ')} should have been refused:\n${output}`,
    );
  } else {
    assert.equal(result.status, 0, `mark ${args.join(' ')} failed:\n${output}`);
  }
  return output;
}

async function main(): Promise<void> {
  writeFixtures();

  const { Events, PipelineSteps } = await import('@farmslot/protocol');
  const { loadProjectVars } = await import('../services/gateway/src/core/config.js');
  const { createRun, getRun, updateRun } = await import('../services/gateway/src/runs/store.js');
  const { resolveConfiguredExecutionTemplate } =
    await import('../services/gateway/src/tasks/execution-template-catalog.js');
  const { materializeReviewWorkspaceTask } =
    await import('../services/gateway/src/review-workspaces/task.js');
  const { executeReviewWorkspaceStep } =
    await import('../services/gateway/src/review-workspaces/pipeline.js');
  const { taskProgress } = await import('../services/gateway/src/methods/task.js');
  const { runsDirectory } = await import('../services/gateway/src/runs/store.js');

  const project = await loadProjectVars(PROJECT);
  const template = resolveConfiguredExecutionTemplate(project, {
    flow: 'review-pr',
    platform: 'cli',
    runMode: 'autonomous',
  });
  const capturedAt = new Date().toISOString();
  const subject = {
    repository: 'example/project',
    repositoryUrl: 'https://github.com/example/project.git',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: 'feature/child-units',
    title: 'Static review with a child checklist unit',
    body: 'Offline PR body.',
    capturedAt,
  };

  const created = createRun(
    {
      project: PROJECT,
      flowType: 'review-pr',
      ticketOrPr: 'https://github.com/example/project/pull/11',
      mode: 'autonomous',
      transport: 'tmux',
      runner: 'codex',
      model: 'gpt-5-codex',
      reviewWorkspaceTarget: { machine: MACHINE },
    } as never,
    { nativeOwnerPrincipalId: OWNER },
  );
  const runId = created.id;
  const startedAt = new Date(Date.now() - 1000).toISOString();
  updateRun(runId, {
    executionTemplate: template.reference,
    reviewWorkspaceSubject: subject,
    reviewWorkspace: {
      workspaceId: WORKSPACE_ID,
      machine: MACHINE,
      executionNodeId: 'local',
      checkoutPath,
      taskPath,
      artifactPath: path.posix.join(taskPath, 'artifacts'),
    },
    engineState: { generation: 0 },
    steps: [{ name: PipelineSteps.MONITOR, status: 'running', startedAt } as never],
  });

  // Materialization refuses to write a task after the worker launched, so the
  // accepted reviewer context is recorded once the real task dir exists.
  await materializeReviewWorkspaceTask(runId, subject);
  updateRun(runId, {
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        slotId: null,
        runId,
        status: 'working',
        runner: 'codex',
        model: 'gpt-5-codex',
        target: { session, target: session },
        attemptStartedAt: startedAt,
        promptDeliveryStartedAt: startedAt,
        taskFile: path.posix.join(taskPath, 'TASK.md'),
        signalFile: path.posix.join(taskPath, 'SIGNAL.json'),
        artifactScope: path.posix.join(taskPath, 'artifacts'),
      } as never,
    ],
  });
  console.log(`[e2e] materialized the real workspace task dir at ${taskPath}`);
  const viewDir = path.join(runsDirectory(), 'review-workspace-tasks', runId, 'view');
  assert.equal(
    existsSync(path.join(viewDir, 'subtasks')),
    false,
    'the pristine view starts with no child units',
  );

  // The reviewer pane the MONITOR step inspects. The runner itself is not part of
  // this proof (see the header); `mark` below is the worker contract.
  run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
  run('tmux', ['new-session', '-d', '-s', session, '-c', checkoutPath]);
  // The ownership marker the shared review-terminal script checks on every inspect.
  run('tmux', ['set-option', '-t', session, '@farmslot-review-workspace', WORKSPACE_ID]);

  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const emit = (event: string, payload: unknown) => {
    events.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
  };
  const monitor = (label: string) => {
    console.log(`[e2e] running the real MONITOR step (${label})`);
    return executeReviewWorkspaceStep(runId, PipelineSteps.MONITOR, 0, emit);
  };

  interface ChildView {
    id: string;
    status: string;
    completedSteps: number;
    totalSteps: number;
    parentChecklist?: string;
  }

  /** The child projection carried by a published progress event, newest first. */
  function publishedChild(step: number): ChildView | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (entry.event !== Events.TASK_PROGRESS_UPDATED) continue;
      const progress = entry.payload.progress as
        | { structured?: { phases: Array<{ steps: Array<Record<string, any>> }> } }
        | undefined;
      const owner = (progress?.structured?.phases ?? [])
        .flatMap((phase) => phase.steps)
        .find((candidate) => candidate.index === step);
      if (!owner?.subtask) continue;
      return {
        id: owner.subtask.id,
        status: owner.subtask.status,
        completedSteps: owner.subtask.progress.completedSteps,
        totalSteps: owner.subtask.progress.totalSteps,
        parentChecklist: entry.payload.parentChecklist as string | undefined,
      };
    }
    return null;
  }

  async function waitForPublishedChild(
    step: number,
    status: string,
    completedSteps: number,
  ): Promise<ChildView> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const seen = publishedChild(step);
      if (seen?.status === status && seen.completedSteps === completedSteps) return seen;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Timed out waiting for a published child on step ${step} at ${status} ${completedSteps}; ` +
        `last seen ${JSON.stringify(publishedChild(step))}`,
    );
  }

  mark(['start']);
  const started = JSON.parse(readFileSync(path.join(taskPath, 'SIGNAL.json'), 'utf-8')) as {
    attemptId: string;
  };

  // ── 1. A live child reaches clients under its parent step, and the view ──
  const firstMonitor = monitor('live child');
  // Let the publisher read the childless projection once, so the child's arrival
  // is an isolated change and must carry the parent-checklist tag.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  mark(['sub', 'start', 'perps-review', '--step', '2', '--from', skillFixture]);
  mark(['sub', 'perps-review', '1']);
  const running = await waitForPublishedChild(2, 'running', 1);
  assert.equal(running.id, 'perps-review');
  assert.equal(running.totalSteps, 3, 'the skill fixture enumerates three child steps');
  assert.equal(
    running.parentChecklist,
    'CHECKLIST.md',
    'a child-only change carries the parent checklist for the acceptance rule',
  );
  console.log(
    `[e2e] published child ${running.id} ${running.completedSteps}/${running.totalSteps} (parentChecklist=${running.parentChecklist})`,
  );

  // The same projection through the client method, and the mirrored view.
  const projected = await taskProgress({ slotId: '', runId });
  const projectedChild = (projected.structured?.phases ?? [])
    .flatMap((phase) => phase.steps)
    .find((step) => step.index === 2)?.subtask;
  assert.equal(projectedChild?.id, 'perps-review');
  assert.deepEqual(readdirSync(path.join(viewDir, 'subtasks')).sort(), [
    'index.json',
    'perps-review-SIGNAL.json',
    'perps-review.md',
  ]);
  const mirroredIndex = JSON.parse(
    readFileSync(path.join(viewDir, 'subtasks', 'index.json'), 'utf-8'),
  ) as { units: Array<{ checklist: string }> };
  assert.ok(
    existsSync(path.join(viewDir, mirroredIndex.units[0].checklist)),
    'the registry’s own relative path resolves inside the view',
  );
  console.log('[e2e] view mirror: subtasks/ present under the worker’s own names');

  // A recorded verdict rides the same refresh into the view.
  writeFileSync(
    path.join(taskPath, 'artifacts', 'acceptance-status.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Every blocking finding is named.',
          verdict: 'proven',
          evidence: ['artifacts/review.md'],
          recipeNodes: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    })}\n`,
  );

  // ── 2. The child completes; its parent box ticks ──
  mark(['sub', 'perps-review', '2']);
  mark(['sub', 'perps-review', '3']);
  writeFileSync(path.join(taskPath, 'artifacts', 'child-report.md'), '# Child\n\nNo findings.\n');
  mark(['sub', 'perps-review', 'complete', '--mark-last', '--report', 'artifacts/child-report.md']);
  const completedChild = await waitForPublishedChild(2, 'complete', 3);
  assert.equal(completedChild.completedSteps, 3);
  assert.match(
    readFileSync(path.join(taskPath, 'CHECKLIST.md'), 'utf-8').split('\n')[5],
    /- \[x\]/,
    'child completion ticked its parent box',
  );
  console.log('[e2e] child completed and ticked parent step 2');

  // ── 3. A second, open child refuses a terminal signal written around `mark` ──
  mark([
    'sub',
    'start',
    'evidence-pack',
    '--step',
    '3',
    '--from',
    'inline:- [ ] **1. collect the evidence paths**\n',
  ]);
  const report = `VERDICT: APPROVE\nCOMMIT: ${subject.headSha}\nNo findings.\n`;
  const resultArtifact = {
    schemaVersion: 1,
    verdict: 'pass',
    issues: [],
    runId,
    workspaceId: WORKSPACE_ID,
    headSha: subject.headSha,
    baseSha: subject.baseSha,
    attemptId: started.attemptId,
    reportSha256: digest(report),
  };
  writeFileSync(path.join(taskPath, 'artifacts', 'review.md'), report);
  writeFileSync(
    path.join(taskPath, 'artifacts', 'review-result.json'),
    `${JSON.stringify(resultArtifact)}\n`,
  );
  writeFileSync(path.join(taskPath, 'artifacts', 'line-comments.json'), '{"comments":[]}\n');
  writeFileSync(path.join(taskPath, 'artifacts', 'learnings.md'), '- Child units are files.\n');
  const engineRefusal = mark(['complete', '--mark-last'], { expectFailure: true });
  assert.match(engineRefusal, /evidence-pack/, 'the mark engine refuses the open child first');
  console.log('[e2e] mark refused the parent completion while evidence-pack was open');

  // Written around the engine, which is exactly what the gateway check is for.
  const handWritten = {
    ...started,
    status: 'complete',
    outcome: 'success',
    disposition: 'fixed',
    timestamp: new Date().toISOString(),
  };
  writeFileSync(path.join(taskPath, 'SIGNAL.json'), `${JSON.stringify(handWritten)}\n`);
  await assert.rejects(firstMonitor, /subtask unit still open: evidence-pack/);
  console.log('[e2e] the MONITOR step refused the hand-written completion, naming the open child');

  // ── 4. Settling the child lets the run finish, and its children are recorded ──
  mark(['sub', 'evidence-pack', 'complete', '--mark-last']);
  mark(['complete', '--mark-last']);
  const outputs = await monitor('completion');
  assert.equal(
    (outputs.outputs?.workerSignal as { status?: string } | undefined)?.status,
    'complete',
  );
  const finished = getRun(runId);
  assert.equal(finished?.reviewResult?.recommendation, 'APPROVE');
  const metrics = finished?.metrics.subtasks;
  assert.ok(metrics, 'the completed workspace run records its child units');
  assert.deepEqual(
    metrics.map((entry) => entry.id).sort(),
    ['evidence-pack', 'perps-review'],
    'both registered children roll up onto run.metrics.subtasks',
  );
  const reviewChild = metrics.find((entry) => entry.id === 'perps-review');
  assert.equal(reviewChild?.status, 'complete');
  assert.equal(reviewChild?.completedSteps, 3);
  assert.equal(reviewChild?.totalSteps, 3);
  assert.deepEqual(reviewChild?.parent, { checklist: 'CHECKLIST.md', stepNumber: 2 });
  assert.ok(reviewChild?.checklistTiming?.events.length, 'the child carries its own mark history');
  console.log(
    `[e2e] metrics: ${metrics
      .map(
        (entry) =>
          `${entry.id} ${entry.status} ${entry.completedSteps}/${entry.totalSteps} ${entry.durationMs}ms`,
      )
      .join(' | ')}`,
  );

  assert.deepEqual(readdirSync(path.join(viewDir, 'subtasks')).sort(), [
    'evidence-pack-SIGNAL.json',
    'evidence-pack.md',
    'index.json',
    'perps-review-SIGNAL.json',
    'perps-review.md',
  ]);
  assert.equal(
    (
      JSON.parse(
        readFileSync(path.join(viewDir, 'artifacts', 'acceptance-status.json'), 'utf-8'),
      ) as { criteria: Array<{ verdict: string }> }
    ).criteria[0].verdict,
    'proven',
    'the acceptance ledger reached the view too',
  );
  const childDriven = events.filter(
    (entry) => entry.event === Events.TASK_PROGRESS_UPDATED && entry.payload.parentChecklist,
  );
  assert.ok(childDriven.length >= 1, 'at least one published update was child-driven');
  console.log(
    `[e2e] published ${events.filter((entry) => entry.event === Events.TASK_PROGRESS_UPDATED).length} progress event(s), ${childDriven.length} child-driven`,
  );

  console.log(
    'e2e:subtask-workspace ok — projection, broadcast, view mirror, terminal refusal and metrics on a real review workspace',
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
  rmSync(root, { recursive: true, force: true });
}
