#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FLOW_STEPS, type AgentContext, type Run } from '@farmslot/protocol';

type ReviewRecoveryState = NonNullable<
  NonNullable<Run['engineState']>['publishGate']
>['reviewRecovery'];

interface StoreModule {
  getRun(runId: string): Run | undefined;
  loadAllRuns(): Promise<void>;
  updateRun(runId: string, fields: Partial<Run>): Run;
}

interface RecoveryModule {
  recoverActiveRuns(): Promise<void>;
  startRun(runId: string): Promise<void>;
}

interface ReplayModule {
  runReplayStep(
    params: { runId: string; stepName: string; triggeredBy: 'operator' | 'auto-recovery' },
    emit: (event: string, payload: unknown) => void,
  ): Promise<unknown>;
}

interface FeedbackModule {
  readReviewFeedback(
    vars: unknown,
    taskDir: string,
    feedbackRelPath: string,
    resultRelPath?: string | null,
  ): Promise<{ terminalInvalidReason?: string }>;
}

interface ConfigModule {
  loadSlotVars(slotId: string): Promise<unknown>;
}

interface TerminalResultModule {
  terminalReviewArtifactErrorForCompletion?: (
    contextId: string,
    terminalInvalidReason: string | undefined,
    completionEstablished: boolean,
  ) => Error | undefined;
}

interface RecoverySnapshot {
  recoveryStatus: string | null;
  recoveryAttempts: number | null;
  recoveryStartedAt: string | null;
  nextRetryAtPresent: boolean;
  reviewVerdicts: Record<string, string>;
  reviewRecoveryPending: Record<string, boolean>;
  contextStatus: Record<string, string>;
  contextLastSignalAt: Record<string, string | null>;
  gateReplayed: boolean;
}

interface PipelineSnapshot {
  status: string;
  currentStepStatus: string | null;
  remainingStepStatuses: Record<string, string>;
  completedAtPresent: boolean;
  metricsOutcome: string | null;
  durationRecorded: boolean;
  slotLifecycle: string | null;
  slotCurrentRunId: string | null;
}

interface ContractExecution {
  sourceSha: string;
  recovery: RecoverySnapshot;
  replayClearedRecovery: boolean;
  pipeline: PipelineSnapshot;
  noSignalCorruptJsonOperatorRequired: boolean;
  contractSatisfied: boolean;
}

const sourceRoot = path.resolve(process.env.FARMSLOT_VALIDATION_SOURCE_ROOT ?? process.cwd());
const sourceSha = process.env.FARMSLOT_VALIDATION_SOURCE_SHA ?? 'unknown';
const resultPath = process.env.FARMSLOT_VALIDATION_RESULT_PATH;
assert.ok(resultPath, 'FARMSLOT_VALIDATION_RESULT_PATH is required');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-review-recovery-'));
const fixtureRoot = path.join(tempRoot, 'fixture-root');
const runsDir = path.join(fixtureRoot, '.runs');
const poolDir = path.join(fixtureRoot, 'pool');
const projectsDir = path.join(fixtureRoot, 'projects');
const repoDir = path.join(fixtureRoot, 'repo');
const taskRoot = path.join(repoDir, 'tasks');
const recoveryTaskDir = path.join(taskRoot, 'recovery');
const pipelineTaskDir = path.join(taskRoot, 'pipeline');
const classificationTaskDir = path.join(taskRoot, 'classification');
const statusPath = path.join(fixtureRoot, '.farm-status.json');
const recoveryRunId = 'recovery-contract-run';
const pipelineRunId = 'pipeline-terminal-contract-run';
const slotId = 'review-recovery-validation';
const project = 'review-recovery-validation';
const startedAt = '2026-08-06T10:00:00.000Z';
const completedAt = '2026-08-06T10:40:00.000Z';
const staleSignalAt = '2026-08-06T09:00:00.000Z';

process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
process.env.FARMSLOT_ROOT = fixtureRoot;
process.env.FARMSLOT_RUNS_DIR = runsDir;
process.env.FARMSLOT_POOL_DIR = poolDir;
process.env.FARMSLOT_PROJECTS_DIR = projectsDir;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeText(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf-8');
}

function moduleUrl(relativePath: string): string {
  return pathToFileURL(path.join(sourceRoot, relativePath)).href;
}

function terminalSignal(
  status: 'complete' | 'failed' | 'blocked',
  timestamp = completedAt,
): object {
  return {
    role: 'self-review',
    status,
    outcome: status === 'complete' ? 'success' : status === 'blocked' ? 'partial' : 'failure',
    disposition: status === 'complete' ? 'fixed' : status,
    timestamp,
  };
}

function reviewerContext(
  id: string,
  artifactScope: string,
  options: Pick<AgentContext, 'status' | 'completedAt'> = { status: 'working' },
): AgentContext {
  return {
    id,
    role: 'self-review',
    label: id,
    status: options.status,
    slotId,
    runId: recoveryRunId,
    taskFile: `tasks/recovery/SELF-REVIEW.${id}.md`,
    signalFile: `tasks/recovery/SELF-REVIEW.${id}-SIGNAL.json`,
    reviewResultFile: `artifacts/review-result.${id}.json`,
    artifactScope,
    runner: 'scripted',
    model: null,
    startedAt,
    attemptStartedAt: startedAt,
    updatedAt: startedAt,
    ...(options.completedAt ? { completedAt: options.completedAt } : {}),
  };
}

function runRecord(
  id: string,
  taskDir: string,
  status: Run['status'],
  contexts: AgentContext[],
  reviewRecovery: ReviewRecoveryState,
): Run {
  const steps = FLOW_STEPS['fix-bug'].map((name) => ({
    name,
    status:
      name === 'human-gate'
        ? ('pending' as const)
        : FLOW_STEPS['fix-bug'].indexOf(name) < FLOW_STEPS['fix-bug'].indexOf('human-gate')
          ? ('done' as const)
          : ('pending' as const),
  }));
  return {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: 'deeeed/farmslot#497',
    lane: 'validation',
    variant: null,
    flowType: 'fix-bug',
    mode: 'validation',
    status,
    project,
    ticketOrPr: 'deeeed/farmslot#497',
    slotId,
    branch: 'fix/review-recovery-terminal-contract',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps,
    decisions: [
      {
        id: `gate-${id}`,
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: completedAt,
      },
    ],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: 'scripted',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    agentContexts: contexts,
    engineState: {
      publishGate: {
        independentReviews: [],
        ...(reviewRecovery ? { reviewRecovery } : {}),
      },
    },
    createdAt: startedAt,
    startedAt,
    updatedAt: completedAt,
  };
}

function seedFixture(): void {
  writeText(path.join(fixtureRoot, 'CLAUDE.md'), '# isolated validation root\n');
  writeText(path.join(fixtureRoot, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  writeJson(path.join(fixtureRoot, 'services', 'gateway', 'package.json'), {
    name: '@farmslot/gateway-validation-root',
  });

  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'review-recovery@example.test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Review Recovery Validation'], { cwd: repoDir });
  writeText(path.join(repoDir, 'README.md'), '# Review recovery validation\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'test: seed review recovery validation'], {
    cwd: repoDir,
  });

  writeJson(path.join(poolDir, 'review-recovery.json'), {
    machine: 'review-recovery-validation',
    project,
    platform: 'cli',
    host: 'localhost',
    ssh_user: process.env.USER || 'dev',
    os: process.platform === 'darwin' ? 'darwin' : 'linux',
    slots: [{ id: slotId, enabled: true, repo: repoDir, session: slotId }],
  });
  writeJson(path.join(projectsDir, project, 'project.json'), {
    name: project,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    self_review: { enabled: true, max_retries: 0, review_timeout_min: 1 },
  });

  for (const taskDir of [recoveryTaskDir, pipelineTaskDir, classificationTaskDir]) {
    writeText(path.join(taskDir, 'TASK.md'), '# Review recovery terminal contract\n');
  }
  const recoveryCases = [
    'rev-missing',
    'rev-invalid',
    'rev-valid',
    'rev-failed',
    'rev-blocked',
    'rev-stale',
    'rev-no-signal-invalid',
  ];
  for (const id of recoveryCases) {
    writeText(path.join(recoveryTaskDir, `SELF-REVIEW.${id}.md`), `# Reviewer ${id}\n`);
  }
  for (const id of ['rev-missing', 'rev-invalid', 'rev-valid', 'rev-no-signal-invalid']) {
    writeText(
      path.join(recoveryTaskDir, 'artifacts', `review-feedback.${id}.md`),
      '# Review\n\nVERDICT: PASS\n',
    );
  }
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-missing-SIGNAL.json'),
    terminalSignal('complete'),
  );
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-invalid-SIGNAL.json'),
    terminalSignal('complete'),
  );
  writeText(
    path.join(recoveryTaskDir, 'artifacts', 'review-result.rev-invalid.json'),
    '{"verdict":"pass"}\n',
  );
  writeJson(path.join(recoveryTaskDir, 'artifacts', 'review-result.rev-valid.json'), {
    schemaVersion: 1,
    verdict: 'pass',
    issues: [],
  });
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-valid-SIGNAL.json'),
    terminalSignal('complete'),
  );
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-failed-SIGNAL.json'),
    terminalSignal('failed'),
  );
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-blocked-SIGNAL.json'),
    terminalSignal('blocked'),
  );
  writeJson(
    path.join(recoveryTaskDir, 'SELF-REVIEW.rev-stale-SIGNAL.json'),
    terminalSignal('failed', staleSignalAt),
  );
  writeText(
    path.join(recoveryTaskDir, 'artifacts', 'review-result.rev-no-signal-invalid.json'),
    '{"verdict":"pass"}\n',
  );

  const recoveryContexts = [
    reviewerContext('rev-missing', 'independent-review-1'),
    reviewerContext('rev-invalid', 'independent-review-2'),
    reviewerContext('rev-valid', 'independent-review-3'),
    reviewerContext('rev-failed', 'independent-review-4'),
    reviewerContext('rev-blocked', 'independent-review-5'),
    reviewerContext('rev-stale', 'independent-review-6'),
    reviewerContext('rev-no-signal-invalid', 'independent-review-7', {
      status: 'complete',
      completedAt,
    }),
  ];
  writeJson(
    path.join(runsDir, `${recoveryRunId}.json`),
    runRecord(recoveryRunId, recoveryTaskDir, 'blocked', recoveryContexts, {
      status: 'watching',
      attempts: 38,
      startedAt,
      updatedAt: completedAt,
      nextRetryAt: '2026-08-06T10:45:00.000Z',
    }),
  );

  const pipelineContext = reviewerContext('pipeline-invalid', 'independent-review-1');
  pipelineContext.runId = pipelineRunId;
  pipelineContext.taskFile = 'tasks/pipeline/SELF-REVIEW.pipeline-invalid.md';
  pipelineContext.signalFile = 'tasks/pipeline/SELF-REVIEW.pipeline-invalid-SIGNAL.json';
  pipelineContext.reviewResultFile = 'artifacts/review-result.pipeline-invalid.json';
  writeText(path.join(pipelineTaskDir, 'SELF-REVIEW.pipeline-invalid.md'), '# Pipeline reviewer\n');
  writeText(
    path.join(pipelineTaskDir, 'artifacts', 'review-feedback.pipeline-invalid.md'),
    '# Review\n\nVERDICT: PASS\n',
  );
  writeJson(
    path.join(pipelineTaskDir, 'SELF-REVIEW.pipeline-invalid-SIGNAL.json'),
    terminalSignal('complete'),
  );
  writeJson(
    path.join(runsDir, `${pipelineRunId}.json`),
    runRecord(pipelineRunId, pipelineTaskDir, 'paused', [pipelineContext], undefined),
  );

  writeText(
    path.join(classificationTaskDir, 'artifacts', 'review-feedback.no-signal.md'),
    '# Review\n\nVERDICT: PASS\n',
  );
  writeText(
    path.join(classificationTaskDir, 'artifacts', 'review-result.no-signal.json'),
    '{"verdict":"pass"}\n',
  );
  writeJson(statusPath, {
    slots: [
      {
        slot: slotId,
        lifecycle: 'busy',
        phase: 'review-gate',
        agent: 'working',
        current_run_id: recoveryRunId,
        slot_epoch: 1,
      },
    ],
  });
}

function recoverySnapshot(run: Run): RecoverySnapshot {
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  const recovery = run.engineState?.publishGate?.reviewRecovery;
  return {
    recoveryStatus: recovery?.status ?? null,
    recoveryAttempts: recovery?.attempts ?? null,
    recoveryStartedAt: recovery?.startedAt ?? null,
    nextRetryAtPresent: recovery?.nextRetryAt !== undefined,
    reviewVerdicts: Object.fromEntries(reviews.map((review) => [review.id, review.verdict])),
    reviewRecoveryPending: Object.fromEntries(
      reviews.map((review) => [review.id, review.recoveryContinuationPending === true]),
    ),
    contextStatus: Object.fromEntries(
      (run.agentContexts ?? []).map((context) => [context.id, context.status]),
    ),
    contextLastSignalAt: Object.fromEntries(
      (run.agentContexts ?? []).map((context) => [context.id, context.lastSignalAt ?? null]),
    ),
    gateReplayed: (run.recoveryAttempts ?? []).some(
      (attempt) => attempt.stepName === 'human-gate' && attempt.triggeredBy === 'auto-recovery',
    ),
  };
}

function readSlotSnapshot(): { lifecycle: string | null; currentRunId: string | null } {
  const parsed: { slots?: Array<Record<string, unknown>> } = JSON.parse(
    readFileSync(statusPath, 'utf-8'),
  );
  const slot = parsed.slots?.find((candidate) => candidate.slot === slotId);
  return {
    lifecycle: typeof slot?.lifecycle === 'string' ? slot.lifecycle : null,
    currentRunId: typeof slot?.current_run_id === 'string' ? slot.current_run_id : null,
  };
}

async function main(): Promise<void> {
  seedFixture();
  const store = (await import(
    moduleUrl('services/gateway/src/runs/store.ts')
  )) as unknown as StoreModule;
  const recovery = (await import(
    moduleUrl('services/gateway/src/run-engine/orchestrator.ts')
  )) as unknown as RecoveryModule;
  const replay = (await import(
    moduleUrl('services/gateway/src/methods/run/replay-step.ts')
  )) as unknown as ReplayModule;
  const feedbackModule = (await import(
    moduleUrl('services/gateway/src/self-review/feedback.ts')
  )) as unknown as FeedbackModule;
  const config = (await import(
    moduleUrl('services/gateway/src/core/config.ts')
  )) as unknown as ConfigModule;
  const terminalResult = (await import(
    moduleUrl('services/gateway/src/self-review/terminal-result.ts')
  )) as unknown as TerminalResultModule;

  await store.loadAllRuns();
  await recovery.recoverActiveRuns();
  const recoveredRun = store.getRun(recoveryRunId);
  assert.ok(recoveredRun);
  const recovered = recoverySnapshot(recoveredRun);

  await replay.runReplayStep(
    { runId: recoveryRunId, stepName: 'human-gate', triggeredBy: 'operator' },
    () => undefined,
  );
  const replayClearedRecovery =
    store.getRun(recoveryRunId)?.engineState?.publishGate?.reviewRecovery === undefined;

  writeJson(statusPath, {
    slots: [
      {
        slot: slotId,
        lifecycle: 'busy',
        phase: 'review-gate',
        agent: 'working',
        current_run_id: pipelineRunId,
        slot_epoch: 2,
      },
    ],
  });
  store.updateRun(pipelineRunId, { status: 'created' });
  await recovery.startRun(pipelineRunId);
  const pipelineRun = store.getRun(pipelineRunId);
  assert.ok(pipelineRun);
  const humanGateIndex = FLOW_STEPS['fix-bug'].indexOf('human-gate');
  const remainingStepNames = FLOW_STEPS['fix-bug'].slice(humanGateIndex + 1);
  const slot = readSlotSnapshot();
  const pipeline: PipelineSnapshot = {
    status: pipelineRun.status,
    currentStepStatus: pipelineRun.steps.find((step) => step.name === 'human-gate')?.status ?? null,
    remainingStepStatuses: Object.fromEntries(
      remainingStepNames.map((name) => [
        name,
        pipelineRun.steps.find((step) => step.name === name)?.status ?? 'missing',
      ]),
    ),
    completedAtPresent: typeof pipelineRun.completedAt === 'string',
    metricsOutcome: pipelineRun.metrics.outcome ?? null,
    durationRecorded: typeof pipelineRun.metrics.durationMs === 'number',
    slotLifecycle: slot.lifecycle,
    slotCurrentRunId: slot.currentRunId,
  };

  const vars = await config.loadSlotVars(slotId);
  const noSignalFeedback = await feedbackModule.readReviewFeedback(
    vars,
    'tasks/classification',
    'artifacts/review-feedback.no-signal.md',
    'artifacts/review-result.no-signal.json',
  );
  const noSignalCorruptJsonOperatorRequired = Boolean(
    terminalResult.terminalReviewArtifactErrorForCompletion?.(
      'no-signal-reviewer',
      noSignalFeedback.terminalInvalidReason,
      true,
    ),
  );

  const contractSatisfied =
    recovered.recoveryStatus === 'operator-required' &&
    recovered.recoveryAttempts === 38 &&
    recovered.recoveryStartedAt === startedAt &&
    !recovered.nextRetryAtPresent &&
    recovered.gateReplayed &&
    recovered.reviewVerdicts['independent-review-3'] === 'pass' &&
    recovered.reviewVerdicts['independent-review-4'] === 'failed' &&
    recovered.reviewVerdicts['independent-review-5'] === 'failed' &&
    recovered.reviewRecoveryPending['independent-review-4'] === false &&
    recovered.reviewRecoveryPending['independent-review-5'] === false &&
    recovered.reviewVerdicts['independent-review-6'] === undefined &&
    recovered.contextLastSignalAt['rev-stale'] !== staleSignalAt &&
    replayClearedRecovery &&
    pipeline.status === 'blocked' &&
    pipeline.currentStepStatus === 'done' &&
    Object.values(pipeline.remainingStepStatuses).every((status) => status === 'skipped') &&
    pipeline.completedAtPresent &&
    pipeline.metricsOutcome === 'partial' &&
    pipeline.durationRecorded &&
    pipeline.slotLifecycle === 'ready' &&
    pipeline.slotCurrentRunId === null &&
    noSignalCorruptJsonOperatorRequired;

  const result: ContractExecution = {
    sourceSha,
    recovery: recovered,
    replayClearedRecovery,
    pipeline,
    noSignalCorruptJsonOperatorRequired,
    contractSatisfied,
  };
  writeJson(resultPath, result);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeJson(resultPath, { sourceSha, fatalError: message, contractSatisfied: false });
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
