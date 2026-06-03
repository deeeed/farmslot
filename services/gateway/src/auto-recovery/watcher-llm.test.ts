import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, PipelineSteps, type RunReplayStepResult } from '@farmslot/protocol';

import { getRun, updateRun } from '../runs/store.js';

import { __setLlmRecoveryCallerForTest } from './llm-classify.js';
import {
  __drainAutoRecoveryForTest,
  __resetAutoRecoveryForTest,
  __setAutoRecoveryHandlersForTest,
  initAutoRecovery,
  routeEventToAutoRecovery,
  scanFailedRunsForAutoRecovery,
} from './watcher.js';
import {
  cleanupRun,
  failRun,
  makeProject,
  readAuditLines,
  withTempAuditDir,
} from './watcher-test-fixtures.js';

test('watcher carries LLM proposed actions into proposal audit without unsafe execution', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1 },
    },
  });
  const failed = failRun(project, { error: 'unclassified runner stopped responding' });
  const run = updateRun(failed.id, {
    error: 'unclassified runner stopped responding',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? {
            ...step,
            status: 'failed' as const,
            detail: 'worker stopped abruptly without known signature',
          }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => ({
    output: {
      category: 'infra',
      confidence: 'high',
      proposedAction: { type: 'tmux.send', tmuxKeys: 'please continue' },
    },
    costUsd: 0.01,
  }));
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'proposed');
  assert.equal(latest.tier, 'llm-refined');
  assert.equal(latest.appliedAction.type, 'tmux.send');
  assert.equal(latest.appliedAction.tmuxKeys, 'please continue');
});

test('watcher enforces project LLM timeout before dispatch', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1, timeoutMs: 20 },
    },
  });
  const failed = failRun(project, { error: 'semantic product assertion failed' });
  const run = updateRun(failed.id, {
    error: 'semantic product assertion failed',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic product assertion failed' }
        : step,
    ),
  });
  let aborted = false;
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async ({ signal }) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    return new Promise<never>(() => undefined);
  });
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay timed-out LLM classification');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  const startedAt = Date.now();
  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(aborted, true);
  assert.equal(replayed, false);
  assert.ok(Date.now() - startedAt < 500);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).tier, 'llm-refined');
  assert.equal(audit.at(-1).outcome, 'skipped');
});

test('watcher supplies the backend default LLM timeout when project config omits one', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1 },
    },
  });
  const failed = failRun(project, { error: 'semantic product assertion failed' });
  const run = updateRun(failed.id, {
    error: 'semantic product assertion failed',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic product assertion failed' }
        : step,
    ),
  });
  let receivedSignal: AbortSignal | undefined;
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async ({ signal }) => {
    receivedSignal = signal;
    return {
      output: {
        category: 'infra',
        confidence: 'high',
        proposedAction: { type: 'tmux.send', tmuxKeys: 'please inspect' },
      },
      costUsd: 0.01,
    };
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.notEqual(receivedSignal, undefined);
  assert.equal(receivedSignal?.aborted, false);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).tier, 'llm-refined');
  assert.equal(audit.at(-1).outcome, 'proposed');
});

test('watcher reserves LLM budget before concurrent project classifications', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 0.01 },
    },
  });
  const failedA = failRun(project, {
    completedAt: '2026-05-12T12:01:00.000Z',
    error: 'semantic product assertion failed A',
  });
  const failedB = failRun(project, {
    completedAt: '2026-05-12T12:01:01.000Z',
    error: 'semantic product assertion failed B',
  });
  const runA = updateRun(failedA.id, {
    error: 'semantic product assertion failed A',
    steps: failedA.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic unknown failure A' }
        : step,
    ),
  });
  const runB = updateRun(failedB.id, {
    error: 'semantic product assertion failed B',
    steps: failedB.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic unknown failure B' }
        : step,
    ),
  });
  let llmCalls = 0;
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => {
    llmCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { output: { category: 'infra', confidence: 'low' }, costUsd: 0.01 };
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(runA.id);
    await cleanupRun(runB.id);
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T12:02:00.000Z'));

  assert.equal(llmCalls, 1);
  const audit = await readAuditLines();
  assert.equal(audit.filter((row) => row.tier === 'llm-refined' && row.costUsd > 0).length, 1);
  assert.equal(
    audit.some((row) => row.outcomeReason === 'budget_exceeded'),
    true,
  );
});

test('watcher skips LLM recovery when actual cost exceeds the daily cap', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 0.015 },
    },
  });
  const failed = failRun(project, { error: 'semantic product assertion failed' });
  const run = updateRun(failed.id, {
    error: 'semantic product assertion failed',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic unknown expensive failure' }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => ({
    output: { category: 'infra', confidence: 'high' },
    costUsd: 0.02,
  }));
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.tier, 'llm-refined');
  assert.equal(latest.costUsd, 0.02);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(latest.outcomeReason, 'budget_exceeded');
});

test('watcher drops recovery if latest run resolves during LLM classification', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1 },
    },
  });
  const failed = failRun(project, { error: 'semantic product assertion failed' });
  const run = updateRun(failed.id, {
    error: 'semantic product assertion failed',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'semantic product assertion failed' }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => {
    updateRun(run.id, { status: 'done', completedAt: '2026-05-12T10:00:01.000Z' });
    return { output: { category: 'infra', confidence: 'high' }, costUsd: 0.01 };
  });
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  assert.equal(getRun(run.id)?.status, 'done');
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(
    latest.guards.some((g: any) => g.name === 'run-still-failed' && g.passed === false),
    true,
  );
});

test('watcher rejects LLM replay proposals outside project allowed steps', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1 },
    },
  });
  const failed = failRun(project, { error: 'unclassified runner stopped responding' });
  const run = updateRun(failed.id, {
    error: 'unclassified runner stopped responding',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? {
            ...step,
            status: 'failed' as const,
            detail: 'worker stopped abruptly without known signature',
          }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => ({
    output: {
      category: 'infra',
      confidence: 'high',
      proposedAction: { type: 'run.replayStep', stepName: 'monitor' },
    },
    costUsd: 0.01,
  }));
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(latest.outcomeReason, 'non_recoverable_category');
  assert.equal(
    latest.guards.some(
      (g: any) => g.name === 'effective-replay-step-allowed' && g.passed === false,
    ),
    true,
  );
});

test('watcher applies maxAttempts to the LLM effective replay step', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 1,
      allowedSteps: ['prepare', 'monitor'],
      allowedCategories: ['infra'],
      llm: { enabled: true, dailyUsdCap: 1 },
    },
  });
  const failed = failRun(project, {
    error: 'unclassified runner stopped responding',
    recoveryAttempts: [
      {
        id: 'prior-monitor',
        attempt: 1,
        stepName: 'monitor',
        startedAt: '2026-05-12T09:00:00.000Z',
        completedAt: '2026-05-12T09:01:00.000Z',
        status: 'failed',
        triggeredBy: 'auto-recovery',
      },
    ],
  });
  const run = updateRun(failed.id, {
    error: 'unclassified runner stopped responding',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? {
            ...step,
            status: 'failed' as const,
            detail: 'worker stopped abruptly without known signature',
          }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setLlmRecoveryCallerForTest(async () => ({
    output: {
      category: 'infra',
      confidence: 'high',
      proposedAction: { type: 'run.replayStep', stepName: 'monitor' },
    },
    costUsd: 0.01,
  }));
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __setLlmRecoveryCallerForTest(null);
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(latest.outcomeReason, 'max_attempts_per_step');
  assert.equal(
    latest.guards.some(
      (g: any) => g.name === 'effective-replay-step-under-attempts' && g.passed === false,
    ),
    true,
  );
});
