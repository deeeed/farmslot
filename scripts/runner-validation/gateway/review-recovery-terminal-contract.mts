#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  cleanupSlotProcesses?(slotId: string): Promise<void>;
  recoverActiveRuns(): Promise<void>;
  startRun(runId: string): Promise<void>;
}

interface PrepareCommandModule {
  buildPrepareWrappedCommand(
    command: string,
    sentinelPath: string,
    scratchDir: string,
    options: { prepareScope: { token: string; identityPath: string } },
  ): string;
}

interface ReplayModule {
  runReplayStep(
    params: { runId: string; stepName: string; triggeredBy: 'operator' | 'auto-recovery' },
    emit: (event: string, payload: unknown) => void,
  ): Promise<unknown>;
}

interface ReviewAgentModule {
  waitForReviewCompletion(
    vars: unknown,
    session: string,
    taskDir: string,
    timeoutMs: number,
    runId: string,
    runner: string,
    reviewWindow: string,
    reviewContextId: string,
    signalBasename: string,
    feedbackRelPath: string,
    resultRelPath?: string | null,
    pollInterval?: number,
  ): Promise<boolean>;
  waitForReviewCompletionOrThrow?(
    vars: unknown,
    session: string,
    taskDir: string,
    timeoutMs: number,
    runId: string,
    runner: string,
    reviewWindow: string,
    reviewContextId: string,
    signalBasename: string,
    feedbackRelPath: string,
    resultRelPath?: string | null,
    pollInterval?: number,
  ): Promise<void>;
}

interface SessionProcessModule {
  isRunnerAliveUnderPane(vars: unknown, panePid: string, runner: string): Promise<boolean>;
}

interface ConfigModule {
  loadSlotVars(slotId: string): Promise<unknown>;
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

interface RecoveryEpisodeSnapshot {
  status: string | null;
  attempts: number | null;
  startedAt: string | null;
}

interface WaitBehaviorSnapshot {
  failedSignalExited: boolean;
  blockedSignalExited: boolean;
  missingJsonTerminalInvalid: boolean;
  invalidJsonTerminalInvalid: boolean;
  noSignalInvalidJsonTerminalInvalid: boolean;
  activeInvalidRemainedRecoverable: boolean;
  activeInvalidReviewerAlive: boolean;
  overdueSettledBeforeDeadline: boolean;
  overdueReviewerTimedOut: boolean;
  overdueReviewWindowKilledBeforeThrow: boolean;
  overdueNeighborWindowPreserved: boolean;
}

interface SlotCleanupSnapshot {
  replacementPriorSentinelKilled: boolean;
  replacementPriorChildKilled: boolean;
  replacementCurrentIdentityPersisted: boolean;
  replacementCurrentScopedGroupPreserved: boolean;
  launcherPidAbsentBeforeCleanup: boolean;
  trackedPrePidLauncherKilled: boolean;
  similarlyNamedNeighborPreserved: boolean;
  processGroupIdentityRemoved: boolean;
  recycledWrongScopeGroupPreserved: boolean;
  staleIdentityRemoved: boolean;
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
  closedEpisodeReset: RecoveryEpisodeSnapshot;
  activeEpisodePreserved: RecoveryEpisodeSnapshot;
  replayClearedRecovery: boolean;
  pipeline: PipelineSnapshot;
  waitBehavior: WaitBehaviorSnapshot;
  slotCleanup: SlotCleanupSnapshot;
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
const waitTaskDir = path.join(taskRoot, 'wait');
const statusPath = path.join(fixtureRoot, '.farm-status.json');
const recoveryRunId = 'recovery-contract-run';
const pipelineRunId = 'pipeline-terminal-contract-run';
const waitRunId = 'wait-contract-run';
const closedEpisodeRunId = 'closed-episode-contract-run';
const activeEpisodeRunId = 'active-episode-contract-run';
const slotId = 'review-recovery-validation';
const project = 'review-recovery-validation';
const waitSession = `review-recovery-wait-${process.pid}`;
const runnerPath = path.join(tempRoot, 'bin', 'scripted-runner');
const generatedRunnerPids = new Set<number>();
let waitSessionId: string | null = null;
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

function contextForRun(id: string, runId: string, taskName: string): AgentContext {
  const context = reviewerContext(id, `independent-${id}`);
  context.runId = runId;
  context.taskFile = `tasks/${taskName}/SELF-REVIEW.${id}.md`;
  context.signalFile = `tasks/${taskName}/SELF-REVIEW.${id}-SIGNAL.json`;
  context.reviewResultFile = `artifacts/review-result.${id}.json`;
  return context;
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

  for (const taskDir of [recoveryTaskDir, pipelineTaskDir, waitTaskDir]) {
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

  const waitContexts = [
    'wait-failed',
    'wait-blocked',
    'wait-missing',
    'wait-invalid',
    'wait-no-signal-invalid',
    'wait-active-invalid',
    'wait-overdue',
  ].map((id) => contextForRun(id, waitRunId, 'wait'));
  writeJson(
    path.join(runsDir, `${waitRunId}.json`),
    runRecord(waitRunId, waitTaskDir, 'paused', waitContexts, undefined),
  );

  const closedEpisodeContext = contextForRun(
    'closed-episode-reviewer',
    closedEpisodeRunId,
    'recovery',
  );
  const activeEpisodeContext = contextForRun(
    'active-episode-reviewer',
    activeEpisodeRunId,
    'recovery',
  );
  writeJson(
    path.join(runsDir, `${closedEpisodeRunId}.json`),
    runRecord(closedEpisodeRunId, recoveryTaskDir, 'blocked', [closedEpisodeContext], {
      status: 'operator-required',
      attempts: 38,
      startedAt,
      updatedAt: completedAt,
      lastError: 'Earlier reviewer episode ended.',
    }),
  );
  writeJson(
    path.join(runsDir, `${activeEpisodeRunId}.json`),
    runRecord(activeEpisodeRunId, recoveryTaskDir, 'blocked', [activeEpisodeContext], {
      status: 'watching',
      attempts: 7,
      startedAt,
      updatedAt: completedAt,
      nextRetryAt: '2026-08-06T10:45:00.000Z',
    }),
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

function recoveryEpisodeSnapshot(run: Run): RecoveryEpisodeSnapshot {
  const recovery = run.engineState?.publishGate?.reviewRecovery;
  return {
    status: recovery?.status ?? null,
    attempts: recovery?.attempts ?? null,
    startedAt: recovery?.startedAt ?? null,
  };
}

interface WaitWindow {
  windowId: string;
  panePid: string;
  runnerPid?: number;
}

function createWaitWindow(name: string, lifetimeSeconds?: number): WaitWindow {
  const args = [
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{window_id}\t#{pane_pid}',
    '-t',
    waitSession,
    '-n',
    name,
  ];
  if (lifetimeSeconds !== undefined) {
    args.push(`${runnerPath} ${lifetimeSeconds}`);
  }
  const [windowId, panePid] = execFileSync('tmux', args, { encoding: 'utf-8' }).trim().split('\t');
  assert.ok(windowId);
  assert.ok(panePid);
  return { windowId, panePid };
}

function createActiveShellWindow(name: string, lifetimeSeconds: number): WaitWindow {
  const pidPath = path.join(tempRoot, `${name}.pid`);
  const command = `${runnerPath} ${lifetimeSeconds} & child=$!; printf '%s' "$child" > ${pidPath}; printf '$ \\n'; wait "$child"`;
  const [windowId, panePid] = execFileSync(
    'tmux',
    [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}\t#{pane_pid}',
      '-t',
      waitSession,
      '-n',
      name,
      command,
    ],
    { encoding: 'utf-8' },
  )
    .trim()
    .split('\t');
  assert.ok(windowId);
  assert.ok(panePid);
  const pidDeadline = Date.now() + 1_000;
  while (!existsSync(pidPath) && Date.now() < pidDeadline) {
    execFileSync('sleep', ['0.01']);
  }
  const runnerPid = Number(readFileSync(pidPath, 'utf-8'));
  assert.ok(Number.isInteger(runnerPid) && runnerPid > 1, `${name} runner pid was not recorded`);
  generatedRunnerPids.add(runnerPid);
  return { windowId, panePid, runnerPid };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnGeneratedRunner(): number {
  const child = spawn(runnerPath, ['30'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(child.pid && child.pid > 1, 'generated runner pid was not available');
  generatedRunnerPids.add(child.pid);
  child.unref();
  return child.pid;
}

function spawnScopedPrepareGroup(
  name: string,
  scope: string,
): {
  groupPid: number;
  launcherPid: number;
} {
  const launcherPidPath = path.join(tempRoot, `${name}.launcher.pid`);
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      '"$FARMSLOT_SCENARIO_RUNNER" 30 & child=$!; printf \'%s\' "$child" > "$FARMSLOT_SCENARIO_PID_FILE"; wait "$child"',
      'farmslot-prepare-scope',
      scope,
    ],
    {
      detached: true,
      env: {
        ...process.env,
        FARMSLOT_PREPARE_SCOPE: scope,
        FARMSLOT_SCENARIO_PID_FILE: launcherPidPath,
        FARMSLOT_SCENARIO_RUNNER: runnerPath,
      },
      stdio: 'ignore',
    },
  );
  assert.ok(child.pid && child.pid > 1, `${name} group pid was not available`);
  generatedRunnerPids.add(child.pid);
  child.unref();

  const pidDeadline = Date.now() + 1_000;
  while (!existsSync(launcherPidPath) && Date.now() < pidDeadline) {
    execFileSync('sleep', ['0.01']);
  }
  const launcherPid = Number(readFileSync(launcherPidPath, 'utf-8'));
  assert.ok(
    Number.isInteger(launcherPid) && launcherPid > 1,
    `${name} launcher pid was not recorded`,
  );
  generatedRunnerPids.add(launcherPid);
  return { groupPid: child.pid, launcherPid };
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

function readPrepareIdentity(
  identityPath: string,
): { pgid: number; sentinelPid: number; scope: string } | null {
  if (!existsSync(identityPath)) return null;
  const [pgidText, sentinelText, scope] = readFileSync(identityPath, 'utf-8').trim().split('\t');
  const pgid = Number(pgidText);
  const sentinelPid = Number(sentinelText);
  if (!Number.isInteger(pgid) || !Number.isInteger(sentinelPid) || !scope) return null;
  return { pgid, sentinelPid, scope };
}

async function waitForPrepareIdentityScope(
  identityPath: string,
  scope: string,
  timeoutMs = 1_000,
): Promise<{ pgid: number; sentinelPid: number; scope: string } | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const identity = readPrepareIdentity(identityPath);
    if (identity?.scope === scope) return identity;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}

function processGroupId(pid: number): number | null {
  try {
    const pgid = Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8' }).trim(),
    );
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

async function runSlotCleanupContract(
  recovery: RecoveryModule,
  prepareCommand: PrepareCommandModule,
): Promise<SlotCleanupSnapshot> {
  const runtimeDir = path.join(repoDir, '.agent');
  const processGroupPath = path.join(runtimeDir, 'preflight.identity');
  const launcherPidPath = path.join(runtimeDir, 'launcher.pid');
  mkdirSync(runtimeDir, { recursive: true });

  const trackedScope = '11111111111111111111111111111111';
  const recycledScope = '22222222222222222222222222222222';
  const staleScope = '33333333333333333333333333333333';
  const replacementScope = '44444444444444444444444444444444';

  const prior = spawnScopedPrepareGroup('prior-prepare', trackedScope);
  writeText(processGroupPath, `${prior.groupPid}\t${prior.groupPid}\t${trackedScope}\n`);
  const replacementCommand = prepareCommand.buildPrepareWrappedCommand(
    ':',
    path.join(tempRoot, 'replacement.exit'),
    path.join(tempRoot, 'replacement-scratch'),
    { prepareScope: { token: replacementScope, identityPath: processGroupPath } },
  );
  const replacementWrapper = spawn('/bin/bash', ['-c', replacementCommand], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(
    replacementWrapper.pid && replacementWrapper.pid > 1,
    'replacement wrapper pid missing',
  );
  replacementWrapper.unref();
  const replacementIdentity = await waitForPrepareIdentityScope(processGroupPath, replacementScope);
  const replacementPriorSentinelKilled = await waitForProcessExit(prior.groupPid);
  const replacementPriorChildKilled = await waitForProcessExit(prior.launcherPid);
  const replacementCurrentIdentityPersisted = replacementIdentity !== null;
  const replacementCurrentScopedGroupPreserved =
    replacementIdentity !== null &&
    processIsAlive(replacementIdentity.sentinelPid) &&
    processGroupId(replacementIdentity.sentinelPid) === replacementIdentity.pgid;

  if (recovery.cleanupSlotProcesses) {
    await recovery.cleanupSlotProcesses(slotId);
    if (replacementIdentity) {
      assert.ok(
        await waitForProcessExit(replacementIdentity.sentinelPid),
        'replacement group cleanup did not terminate its exact sentinel',
      );
    }
  }

  const tracked = spawnScopedPrepareGroup('tracked-prepare', trackedScope);
  const neighborPid = spawnGeneratedRunner();
  writeText(processGroupPath, `${tracked.groupPid}\t${tracked.groupPid}\t${trackedScope}\n`);
  const launcherPidAbsentBeforeCleanup = !existsSync(launcherPidPath);

  if (!recovery.cleanupSlotProcesses) {
    return {
      replacementPriorSentinelKilled,
      replacementPriorChildKilled,
      replacementCurrentIdentityPersisted,
      replacementCurrentScopedGroupPreserved,
      launcherPidAbsentBeforeCleanup,
      trackedPrePidLauncherKilled: false,
      similarlyNamedNeighborPreserved: processIsAlive(neighborPid),
      processGroupIdentityRemoved: false,
      recycledWrongScopeGroupPreserved: false,
      staleIdentityRemoved: false,
    };
  }

  await recovery.cleanupSlotProcesses(slotId);
  const trackedPrePidLauncherKilled = await waitForProcessExit(tracked.launcherPid);
  const similarlyNamedNeighborPreserved = processIsAlive(neighborPid);
  const processGroupIdentityRemoved = !existsSync(processGroupPath);

  const recycled = spawnScopedPrepareGroup('recycled-prepare', recycledScope);
  writeText(processGroupPath, `${recycled.groupPid}\t${recycled.groupPid}\t${staleScope}\n`);
  await recovery.cleanupSlotProcesses(slotId);
  return {
    replacementPriorSentinelKilled,
    replacementPriorChildKilled,
    replacementCurrentIdentityPersisted,
    replacementCurrentScopedGroupPreserved,
    launcherPidAbsentBeforeCleanup,
    trackedPrePidLauncherKilled,
    similarlyNamedNeighborPreserved,
    processGroupIdentityRemoved,
    recycledWrongScopeGroupPreserved:
      processIsAlive(recycled.groupPid) && processIsAlive(recycled.launcherPid),
    staleIdentityRemoved: !existsSync(processGroupPath),
  };
}

function tmuxWindowExists(windowId: string): boolean {
  const ids = execFileSync('tmux', ['list-windows', '-a', '-F', '#{window_id}'], {
    encoding: 'utf-8',
  })
    .trim()
    .split('\n');
  return ids.includes(windowId);
}

function writeWaitSignal(id: string, status: 'complete' | 'failed' | 'blocked'): void {
  writeJson(path.join(waitTaskDir, `SELF-REVIEW.${id}-SIGNAL.json`), terminalSignal(status));
}

async function runWaitBehaviorContract(
  vars: unknown,
  reviewAgent: ReviewAgentModule,
  sessionProcess: SessionProcessModule,
): Promise<WaitBehaviorSnapshot> {
  const waitForCase = async (id: string, timeoutMs = 1): Promise<boolean | Error> => {
    try {
      return await reviewAgent.waitForReviewCompletion(
        vars,
        waitSession,
        'tasks/wait',
        timeoutMs,
        waitRunId,
        'scripted',
        id,
        id,
        `SELF-REVIEW.${id}-SIGNAL.json`,
        `artifacts/review-feedback.${id}.md`,
        `artifacts/review-result.${id}.json`,
        25,
      );
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const runCase = async (
    id: string,
    lifetimeSeconds?: number,
    timeoutMs?: number,
  ): Promise<boolean | Error> => {
    createWaitWindow(id, lifetimeSeconds);
    return waitForCase(id, timeoutMs);
  };
  const isTerminalInvalid = (result: boolean | Error): boolean =>
    result instanceof Error && result.name === 'TerminalReviewArtifactError';

  writeWaitSignal('wait-failed', 'failed');
  const failed = await runCase('wait-failed', 0.5);

  writeWaitSignal('wait-blocked', 'blocked');
  const blocked = await runCase('wait-blocked', 0.5);

  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-feedback.wait-missing.md'),
    '# Review\n\n## Verdict: PASS\n',
  );
  writeWaitSignal('wait-missing', 'complete');
  const missing = await runCase('wait-missing', 0.5);

  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-feedback.wait-invalid.md'),
    '# Review\n\n## Verdict: PASS\n',
  );
  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-result.wait-invalid.json'),
    '{"schemaVersion":1,"verdict":"pass"}\n',
  );
  writeWaitSignal('wait-invalid', 'complete');
  const invalid = await runCase('wait-invalid', 0.5);

  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-feedback.wait-no-signal-invalid.md'),
    '# Review\n\n## Verdict: PASS\n',
  );
  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-result.wait-no-signal-invalid.json'),
    '{"schemaVersion":1,"verdict":"pass"}\n',
  );
  createActiveShellWindow('wait-no-signal-invalid', 0.2);
  const noSignalInvalid = await waitForCase('wait-no-signal-invalid', 1_000);

  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-feedback.wait-active-invalid.md'),
    '# Review\n\n## Verdict: PASS\n',
  );
  writeText(
    path.join(waitTaskDir, 'artifacts', 'review-result.wait-active-invalid.json'),
    '{"schemaVersion":1,"verdict":"pass"}\n',
  );
  const activeWindow = createActiveShellWindow('wait-active-invalid', 30);
  const activeInvalid = await waitForCase('wait-active-invalid');
  const activeInvalidReviewerAlive = await sessionProcess.isRunnerAliveUnderPane(
    vars,
    activeWindow.panePid,
    'scripted',
  );

  const overdueWindow = createActiveShellWindow('wait-overdue', 30);
  const overdueNeighbor = createActiveShellWindow('wait-overdue-neighbor', 30);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const overdueWait = reviewAgent.waitForReviewCompletionOrThrow
    ? reviewAgent
        .waitForReviewCompletionOrThrow(
          vars,
          waitSession,
          'tasks/wait',
          1_000,
          waitRunId,
          'scripted',
          'wait-overdue',
          'wait-overdue',
          'SELF-REVIEW.wait-overdue-SIGNAL.json',
          'artifacts/review-feedback.wait-overdue.md',
          'artifacts/review-result.wait-overdue.json',
        )
        .then(() => ({ timedOut: false }))
        .catch((error: unknown) => ({
          timedOut:
            error instanceof Error && error.message.includes('did not complete within 1000ms'),
        }))
    : waitForCase('wait-overdue', 1_000).then((result) => ({ timedOut: result === false }));
  const overdue = await Promise.race([
    overdueWait.then((result) => ({ settled: true as const, ...result })),
    new Promise<{ settled: false }>((resolve) => {
      deadline = setTimeout(() => resolve({ settled: false }), 3_000);
    }),
  ]);
  if (deadline) clearTimeout(deadline);
  const overdueReviewWindowKilledBeforeThrow = !tmuxWindowExists(overdueWindow.windowId);
  const overdueNeighborWindowPreserved =
    tmuxWindowExists(overdueNeighbor.windowId) &&
    overdueNeighbor.runnerPid !== undefined &&
    processIsAlive(overdueNeighbor.runnerPid);

  return {
    failedSignalExited: failed === true,
    blockedSignalExited: blocked === true,
    missingJsonTerminalInvalid: isTerminalInvalid(missing),
    invalidJsonTerminalInvalid: isTerminalInvalid(invalid),
    noSignalInvalidJsonTerminalInvalid: isTerminalInvalid(noSignalInvalid),
    activeInvalidRemainedRecoverable: activeInvalid === false,
    activeInvalidReviewerAlive,
    overdueSettledBeforeDeadline: overdue.settled,
    overdueReviewerTimedOut: overdue.settled && overdue.timedOut,
    overdueReviewWindowKilledBeforeThrow,
    overdueNeighborWindowPreserved,
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
  mkdirSync(path.dirname(runnerPath), { recursive: true });
  symlinkSync('/bin/sleep', runnerPath);
  waitSessionId = execFileSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{session_id}',
      '-s',
      waitSession,
      '-n',
      'anchor',
      'sleep 120',
    ],
    { encoding: 'utf-8' },
  ).trim();
  const store = (await import(
    moduleUrl('services/gateway/src/runs/store.ts')
  )) as unknown as StoreModule;
  const recovery = (await import(
    moduleUrl('services/gateway/src/run-engine/orchestrator.ts')
  )) as unknown as RecoveryModule;
  const prepareCommand = (await import(
    moduleUrl('services/gateway/src/methods/slot/prepare-command.ts')
  )) as unknown as PrepareCommandModule;
  const replay = (await import(
    moduleUrl('services/gateway/src/methods/run/replay-step.ts')
  )) as unknown as ReplayModule;
  const reviewAgent = (await import(
    moduleUrl('services/gateway/src/self-review/review-agent.ts')
  )) as unknown as ReviewAgentModule;
  const sessionProcess = (await import(
    moduleUrl('services/gateway/src/runners/session-process.ts')
  )) as unknown as SessionProcessModule;
  const config = (await import(
    moduleUrl('services/gateway/src/core/config.ts')
  )) as unknown as ConfigModule;

  await store.loadAllRuns();
  await recovery.recoverActiveRuns();
  const recoveredRun = store.getRun(recoveryRunId);
  assert.ok(recoveredRun);
  const recovered = recoverySnapshot(recoveredRun);
  const closedEpisodeRun = store.getRun(closedEpisodeRunId);
  const activeEpisodeRun = store.getRun(activeEpisodeRunId);
  assert.ok(closedEpisodeRun);
  assert.ok(activeEpisodeRun);
  const closedEpisodeReset = recoveryEpisodeSnapshot(closedEpisodeRun);
  const activeEpisodePreserved = recoveryEpisodeSnapshot(activeEpisodeRun);

  const vars = await config.loadSlotVars(slotId);
  const slotCleanup = await runSlotCleanupContract(recovery, prepareCommand);
  const waitBehavior = await runWaitBehaviorContract(vars, reviewAgent, sessionProcess);

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
    closedEpisodeReset.status === 'watching' &&
    closedEpisodeReset.attempts === 0 &&
    closedEpisodeReset.startedAt !== startedAt &&
    activeEpisodePreserved.status === 'watching' &&
    activeEpisodePreserved.attempts === 7 &&
    activeEpisodePreserved.startedAt === startedAt &&
    replayClearedRecovery &&
    pipeline.status === 'blocked' &&
    pipeline.currentStepStatus === 'done' &&
    Object.values(pipeline.remainingStepStatuses).every((status) => status === 'skipped') &&
    pipeline.completedAtPresent &&
    pipeline.metricsOutcome === 'partial' &&
    pipeline.durationRecorded &&
    pipeline.slotLifecycle === 'ready' &&
    pipeline.slotCurrentRunId === null &&
    Object.values(waitBehavior).every(Boolean) &&
    Object.values(slotCleanup).every(Boolean);

  const result: ContractExecution = {
    sourceSha,
    recovery: recovered,
    closedEpisodeReset,
    activeEpisodePreserved,
    replayClearedRecovery,
    pipeline,
    waitBehavior,
    slotCleanup,
    contractSatisfied,
  };
  // replay-step schedules engine continuation after returning. Let that
  // isolated continuation settle before removing its temporary run store.
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeJson(resultPath, result);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeJson(resultPath, { sourceSha, fatalError: message, contractSatisfied: false });
    process.exitCode = 1;
  })
  .finally(() => {
    for (const pid of generatedRunnerPids) {
      let command: string;
      try {
        command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
          encoding: 'utf-8',
        }).trim();
      } catch {
        // The exact generated process may have exited between scenario checks and cleanup.
        continue;
      }
      if (command !== runnerPath && !command.startsWith(`${runnerPath} `)) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Exact process exit raced cleanup; session and temp cleanup must still run.
      }
    }
    if (waitSessionId) {
      try {
        execFileSync('tmux', ['kill-session', '-t', waitSessionId], { stdio: 'ignore' });
      } catch {
        // The exact generated session may already have exited after a fatal setup error.
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });
