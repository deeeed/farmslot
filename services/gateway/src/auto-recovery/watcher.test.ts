import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events, PipelineSteps, type RunReplayStepResult } from '@farmslot/protocol';

import { getRun, updateRun } from '../runs/store.js';

import {
  __drainAutoRecoveryForTest,
  __resetAutoRecoveryForTest,
  __setAutoRecoveryHandlersForTest,
  initAutoRecovery,
  routeEventToAutoRecovery,
  scanFailedRunsForAutoRecovery,
} from './watcher.js';
import {
  activeRun,
  cleanupRun,
  failRun,
  makeProject,
  readAuditLines,
  withTempAuditDir,
} from './watcher-test-fixtures.js';

test('watcher applies deterministic recovery through the typed replay RPC', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project);
  const events: Array<{ event: string; payload: unknown }> = [];
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params, emit): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      const updated = updateRun(params.runId, {
        recoveryAttempts: [
          ...(getRun(params.runId)?.recoveryAttempts ?? []),
          {
            id: 'auto-attempt-1',
            attempt: 1,
            stepName: params.stepName,
            startedAt: '2026-05-12T10:00:01.000Z',
            status: 'started',
            triggeredBy: 'auto-recovery',
            intelligenceActionId: params.intelligenceActionId,
          },
        ],
      });
      emit(Events.RUN_UPDATED, { run: updated });
      return { run: updated };
    },
  });
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0].triggeredBy, 'auto-recovery');
  assert.equal(replayCalls[0].stepName, 'prepare');
  assert.equal(getRun(run.id)?.recoveryProposal?.status, 'auto-in-progress');
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).outcome, 'applied');
  assert.equal(audit.at(-1).appliedAction.type, 'run.replayStep');
  assert.ok(events.some((e) => e.event === Events.RUN_UPDATED));
});

test('watcher treats an empty step allowlist as no auto-replay steps', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: [],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project);
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay with an empty step allowlist');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayed, false);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(latest.outcomeReason, 'non_recoverable_category');
  assert.equal(
    latest.guards.some((g: any) => g.name === 'step-allowed' && g.passed === false),
    true,
  );
});

test('watcher skips when per-step maxAttempts is exhausted and does not replay', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 1,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project, {
    recoveryAttempts: [
      {
        id: 'prior',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T09:00:00.000Z',
        status: 'failed',
        triggeredBy: 'auto-recovery',
      },
    ],
  });
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T10:01:00.000Z'));

  assert.equal(replayed, false);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).outcomeReason, 'max_attempts_per_step');
});

test('watcher observes manual-in-progress state and skips auto dispatch', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project, {
    recoveryProposal: { status: 'manual-in-progress', generation: 0 },
  });
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayed, false);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).outcomeReason, 'manual_in_progress');
});

test('watcher replays monitor when monitor terminal failure leaves later steps skipped', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['monitor'],
      allowedCategories: ['infra'],
    },
  });
  const base = failRun(project, { error: 'worker exited after socket hang up' });
  const run = updateRun(base.id, {
    error: 'worker exited after socket hang up',
    steps: base.steps.map((step) => {
      if (step.name === PipelineSteps.MONITOR) {
        return {
          ...step,
          status: 'done' as const,
          outputs: {
            workerSignal: { status: 'failed', reason: 'socket hang up' },
            exitReason: 'signal',
          },
        };
      }
      if (
        base.steps.findIndex((s) => s.name === step.name) >
        base.steps.findIndex((s) => s.name === PipelineSteps.MONITOR)
      ) {
        return { ...step, status: 'skipped' as const };
      }
      return { ...step, status: 'done' as const };
    }),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0].stepName, 'monitor');
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).stepName, 'monitor');
  assert.equal(audit.at(-1).outcome, 'applied');
});

test('watcher replays monitor when monitor terminalizes the run as blocked', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['monitor'],
      allowedCategories: ['timeout'],
    },
  });
  const base = failRun(project, { error: 'worker idle timeout' });
  const run = updateRun(base.id, {
    status: 'blocked',
    completedAt: '2026-05-12T10:02:00.000Z',
    error: 'worker idle timeout',
    steps: base.steps.map((step) => {
      if (step.name === PipelineSteps.MONITOR) {
        return {
          ...step,
          status: 'done' as const,
          outputs: {
            workerSignal: { status: 'blocked', reason: 'worker idle timeout' },
            exitReason: 'worker-done',
          },
        };
      }
      if (
        base.steps.findIndex((s) => s.name === step.name) >
        base.steps.findIndex((s) => s.name === PipelineSteps.MONITOR)
      ) {
        return { ...step, status: 'skipped' as const };
      }
      return { ...step, status: 'done' as const };
    }),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0].stepName, 'monitor');
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).stepName, 'monitor');
  assert.equal(audit.at(-1).outcome, 'applied');
});

test('watcher excludes human-decision blocked runs from auto-recovery', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['monitor'],
      allowedCategories: ['timeout'],
    },
  });
  const base = failRun(project, { error: 'Publication gate blocked by human decision' });
  const run = updateRun(base.id, {
    status: 'blocked',
    completedAt: '2026-05-12T10:03:00.000Z',
    error: 'Publication gate blocked by human decision',
    decisions: [
      {
        id: 'human-gate',
        type: 'engine_no_change_gate',
        title: 'Human gate',
        description: 'Operator marked this run blocked',
        actions: [],
        createdAt: '2026-05-12T10:02:00.000Z',
      },
    ],
    steps: base.steps.map((step) =>
      step.name === PipelineSteps.MONITOR ? { ...step, status: 'done' as const } : step,
    ),
  });
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay human-decision blocked run');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayed, false);
  assert.equal(getRun(run.id)?.recoveryProposal?.status, undefined);
  await assert.rejects(() => readAuditLines(), /ENOENT/);
});

test('watcher drops queued recovery when latest run is no longer failed', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project);
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay resolved run');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  updateRun(run.id, { status: 'done', completedAt: '2026-05-12T10:00:01.000Z' });
  await __drainAutoRecoveryForTest();

  assert.equal(replayed, false);
  assert.equal(getRun(run.id)?.recoveryProposal?.status, undefined);
});

test('boot-time scan replays recent failed runs and preserves completedAt as audit timestamp', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const completedAt = '2026-05-12T11:58:30.000Z';
  const run = failRun(project, { completedAt });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T12:00:00.000Z'));

  assert.equal(replayCalls.length, 1);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).timestamp, completedAt);
  assert.ok(Number.isFinite(Date.parse(audit.at(-1).decidedAt)));
});

test('boot-time scan replays recent monitor-blocked terminal runs', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['monitor'],
      allowedCategories: ['timeout'],
    },
  });
  const completedAt = '2026-05-12T12:02:30.000Z';
  const base = failRun(project, { completedAt, error: 'worker waiting timeout' });
  const run = updateRun(base.id, {
    status: 'blocked',
    completedAt,
    error: 'worker waiting timeout',
    steps: base.steps.map((step) => {
      if (step.name === PipelineSteps.MONITOR) {
        return {
          ...step,
          status: 'done' as const,
          outputs: {
            workerSignal: { status: 'blocked', reason: 'worker waiting timeout' },
            exitReason: 'worker-done',
          },
        };
      }
      if (
        base.steps.findIndex((s) => s.name === step.name) >
        base.steps.findIndex((s) => s.name === PipelineSteps.MONITOR)
      ) {
        return { ...step, status: 'skipped' as const };
      }
      return { ...step, status: 'done' as const };
    }),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T12:04:00.000Z'));

  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0].stepName, 'monitor');
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).timestamp, completedAt);
  assert.equal(audit.at(-1).outcome, 'applied');
});

test('watcher dead-letters config errors and still writes an audit record', async (t) => {
  withTempAuditDir(t);
  const run = failRun(`missing-auto-recovery-project-${process.pid}`);
  const events: Array<{ event: string; payload: unknown }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.match(
    getRun(run.id)?.engineState?.autoRecoveryDeadLetter ?? '',
    /Project config not found/,
  );
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).outcome, 'errored');
  assert.equal(audit.at(-1).outcomeReason, 'dead_letter');
  assert.ok(events.some((e) => e.event === Events.RUN_UPDATED));
});

test('watcher does not requeue failed runs from its own metadata broadcasts', async (t) => {
  withTempAuditDir(t);
  const run = failRun(`missing-auto-recovery-project-${process.pid}`);
  const events: Array<{ event: string; payload: unknown }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => {
    events.push({ event, payload });
    routeEventToAutoRecovery(event, payload);
  });
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  const audit = await readAuditLines();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'errored');
  assert.equal(audit[0].outcomeReason, 'dead_letter');
  assert.equal(events.filter((e) => e.event === Events.RUN_UPDATED).length, 1);
});

test('boot-time scan does not requeue failed runs from its own metadata broadcasts', async (t) => {
  withTempAuditDir(t);
  const run = failRun(`missing-auto-recovery-project-${process.pid}`, {
    completedAt: '2026-05-12T10:00:00.000Z',
  });
  const events: Array<{ event: string; payload: unknown }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => {
    events.push({ event, payload });
    routeEventToAutoRecovery(event, payload);
  });
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T10:01:00.000Z'));
  await __drainAutoRecoveryForTest();

  const audit = await readAuditLines();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'errored');
  assert.equal(audit[0].outcomeReason, 'dead_letter');
  assert.equal(events.filter((e) => e.event === Events.RUN_UPDATED).length, 1);
});

test('watcher still dispatches recovery when audit writing degrades', async (t) => {
  const previousDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const auditParent = mkdtempSync(path.join(tmpdir(), 'farmslot-watcher-audit-block-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = path.join(auditParent, 'not-a-dir');
  await writeFile(process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR, 'blocks mkdir', 'utf8');
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const run = failRun(project);
  const events: Array<{ event: string; payload: any }> = [];
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    if (previousDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousDir;
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
    await rm(auditParent, { recursive: true, force: true });
  });

  await scanFailedRunsForAutoRecovery(new Date('2026-05-12T10:01:00.000Z'));

  assert.equal(replayCalls.length, 1);
  assert.equal(getRun(run.id)?.engineState?.intelligenceAuditDegraded, true);
  assert.ok(
    events.some(
      (e) =>
        e.event === Events.RUN_UPDATED &&
        e.payload?.run?.engineState?.intelligenceAuditDegraded === true,
    ),
  );
});

test('watcher records stale worker monitor violations as human-reviewable intelligence proposals', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['monitor'],
      allowedCategories: ['timeout'],
    },
  });
  const run = activeRun(project, { slotId: 'stale-worker-slot' });
  let replayed = false;
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    runReplayStep: async () => {
      replayed = true;
      throw new Error('should not replay stale active workers');
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.MONITOR_VIOLATION, {
    violation: {
      slotId: 'stale-worker-slot',
      type: 'idle',
      message: 'Slot is working but agent is idle',
      nudgeSent: null,
      timestamp: '2026-05-12T12:00:00.000Z',
    },
  });
  await __drainAutoRecoveryForTest();

  assert.equal(replayed, false);
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.runId, run.id);
  assert.equal(latest.actor, 'auto-nudge');
  assert.equal(latest.outcome, 'proposed');
  assert.equal(latest.verdict.category, 'timeout');
  assert.equal(latest.verdict.patternId, 'worker-idle');
  assert.equal(latest.appliedAction.type, 'tmux.send');
});

test('watcher passes run flow and app context to fixture refresh before replay', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['env-drift'],
    },
  });
  const failed = failRun(project, {
    flowType: 'fix-bug',
    app: 'mobile',
    slotId: 'fixture-context-slot',
    error: 'fixture missing for selected app',
  });
  const run = updateRun(failed.id, {
    error: 'fixture missing for selected app',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'fixture missing for selected app' }
        : step,
    ),
  });
  const fixtureCalls: any[] = [];
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    slotFixtureRefresh: async (params) => {
      fixtureCalls.push(params);
      return { ok: true, requestId: params.requestId ?? 'r', logPath: '/tmp/fixture.log' };
    },
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(fixtureCalls.length, 1);
  assert.equal(fixtureCalls[0].slotId, 'fixture-context-slot');
  assert.equal(fixtureCalls[0].flowType, 'fix-bug');
  assert.equal(fixtureCalls[0].app, 'mobile');
  assert.equal(replayCalls.length, 1);
});

test('watcher drops recovery if latest run resolves during fixture refresh', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['env-drift'],
    },
  });
  const failed = failRun(project, {
    slotId: 'fixture-stale-slot',
    error: 'fixture missing for selected app',
  });
  const run = updateRun(failed.id, {
    error: 'fixture missing for selected app',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'fixture missing for selected app' }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    slotFixtureRefresh: async (params) => {
      updateRun(run.id, { status: 'done', completedAt: '2026-05-12T10:00:01.000Z' });
      return { ok: true, requestId: params.requestId ?? 'r', logPath: '/tmp/fixture.log' };
    },
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  assert.equal(replayCalls.length, 0);
  assert.equal(getRun(run.id)?.status, 'done');
  assert.equal(getRun(run.id)?.recoveryProposal?.status, 'idle');
  const audit = await readAuditLines();
  const latest = audit.at(-1);
  assert.equal(latest.outcome, 'skipped');
  assert.equal(latest.appliedAction.type, 'slot.fixtureRefresh');
  assert.equal(
    latest.guards.some((g: any) => g.name === 'run-still-failed' && g.passed === false),
    true,
  );
});

test('watcher clears auto-in-progress when fixture refresh errors before replay starts', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['env-drift'],
    },
  });
  const failed = failRun(project, {
    slotId: 'fixture-error-slot',
    error: 'fixture missing for selected app',
  });
  const run = updateRun(failed.id, {
    error: 'fixture missing for selected app',
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.PREPARE
        ? { ...step, status: 'failed' as const, detail: 'fixture missing for selected app' }
        : step,
    ),
  });
  const replayCalls: any[] = [];
  __resetAutoRecoveryForTest();
  __setAutoRecoveryHandlersForTest({
    slotFixtureRefresh: async () => {
      throw new Error('fixture refresh failed');
    },
    runReplayStep: async (params): Promise<RunReplayStepResult> => {
      replayCalls.push(params);
      return { run: getRun(params.runId)! };
    },
  });
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  const updated = getRun(run.id)!;
  assert.equal(replayCalls.length, 0);
  assert.equal(updated.recoveryProposal?.status, 'idle');
  assert.match(updated.engineState?.autoRecoveryDeadLetter ?? '', /fixture refresh failed/);
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).outcome, 'errored');
  assert.equal(audit.at(-1).outcomeReason, 'dead_letter');
});

test('watcher clears manual replay proposal state when terminal run completes', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const failed = failRun(project, {
    recoveryAttempts: [
      {
        id: 'manual-1',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T09:00:00.000Z',
        status: 'started',
        triggeredBy: 'operator',
      },
    ],
    recoveryProposal: { status: 'manual-in-progress', generation: 0 },
  });
  const run = updateRun(failed.id, { status: 'done', completedAt: '2026-05-12T09:05:00.000Z' });
  const events: Array<{ event: string; payload: any }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  const updated = getRun(run.id)!;
  assert.equal(updated.recoveryProposal?.status, 'idle');
  assert.equal(updated.recoveryAttempts?.[0]?.status, 'completed');
  assert.equal(updated.recoveryAttempts?.[0]?.completedAt, '2026-05-12T09:05:00.000Z');
  assert.ok(
    events.some(
      (e) => e.event === Events.RUN_UPDATED && e.payload.run.recoveryProposal?.status === 'idle',
    ),
  );
});

test('watcher clears manual replay proposal state when replay reaches human gate', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const failed = failRun(project, {
    flowType: 'dev',
    recoveryAttempts: [
      {
        id: 'manual-prepare',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T09:00:00.000Z',
        status: 'started',
        triggeredBy: 'operator',
      },
      {
        id: 'manual-dispatch',
        attempt: 1,
        stepName: 'dispatch',
        startedAt: '2026-05-12T09:02:00.000Z',
        status: 'started',
        triggeredBy: 'operator',
      },
    ],
    recoveryProposal: { status: 'manual-in-progress', generation: 0 },
  });
  const run = updateRun(failed.id, {
    status: 'blocked',
    completedAt: undefined,
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.HUMAN_GATE
        ? { ...step, status: 'running' as const, startedAt: '2026-05-12T09:05:00.000Z' }
        : { ...step, status: 'done' as const, completedAt: '2026-05-12T09:04:00.000Z' },
    ),
  });
  const events: Array<{ event: string; payload: any }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  const updated = getRun(run.id)!;
  assert.equal(updated.recoveryProposal?.status, 'idle');
  assert.equal(updated.recoveryAttempts?.[0]?.status, 'completed');
  assert.equal(updated.recoveryAttempts?.[1]?.status, 'completed');
  assert.equal(updated.recoveryAttempts?.[0]?.completedAt, '2026-05-12T09:05:00.000Z');
  assert.equal(updated.recoveryAttempts?.[1]?.completedAt, '2026-05-12T09:05:00.000Z');
  assert.ok(
    events.some(
      (e) => e.event === Events.RUN_UPDATED && e.payload.run.recoveryProposal?.status === 'idle',
    ),
  );
});

test('watcher records human-gate auto-recovery follow-up as recovered', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const failed = failRun(project, {
    flowType: 'dev',
    recoveryAttempts: [
      {
        id: 'auto-prepare',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T09:00:00.000Z',
        status: 'started',
        triggeredBy: 'auto-recovery',
        intelligenceActionId: 'action-1',
      },
    ],
    recoveryProposal: { status: 'auto-in-progress', proposalId: 'action-1', generation: 0 },
  });
  const run = updateRun(failed.id, {
    status: 'blocked',
    completedAt: undefined,
    steps: failed.steps.map((step) =>
      step.name === PipelineSteps.HUMAN_GATE
        ? { ...step, status: 'running' as const, startedAt: '2026-05-12T09:06:00.000Z' }
        : { ...step, status: 'done' as const, completedAt: '2026-05-12T09:05:00.000Z' },
    ),
  });
  __resetAutoRecoveryForTest();
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
  await __drainAutoRecoveryForTest();

  const updated = getRun(run.id)!;
  assert.equal(updated.recoveryProposal?.status, 'idle');
  assert.equal(updated.recoveryAttempts?.[0]?.status, 'completed');
  assert.equal(updated.recoveryAttempts?.[0]?.completedAt, '2026-05-12T09:06:00.000Z');
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).followupOutcome, 'recovered');
});

test('watcher follows up successful auto-recovery replay from run.completed events', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare'],
      allowedCategories: ['infra'],
    },
  });
  const failed = failRun(project, {
    recoveryAttempts: [
      {
        id: 'auto-1',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T09:00:00.000Z',
        status: 'started',
        triggeredBy: 'auto-recovery',
      },
    ],
    recoveryProposal: { status: 'auto-in-progress', proposalId: 'action-1', generation: 0 },
  });
  const run = updateRun(failed.id, { status: 'done', completedAt: '2026-05-12T09:07:00.000Z' });
  const events: Array<{ event: string; payload: any }> = [];
  __resetAutoRecoveryForTest();
  initAutoRecovery((event, payload) => events.push({ event, payload }));
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  routeEventToAutoRecovery(Events.RUN_COMPLETED, { run });
  await __drainAutoRecoveryForTest();

  const updated = getRun(run.id)!;
  assert.equal(updated.recoveryProposal?.status, 'idle');
  assert.equal(updated.recoveryAttempts?.[0]?.status, 'completed');
  assert.equal(updated.recoveryAttempts?.[0]?.completedAt, '2026-05-12T09:07:00.000Z');
  assert.ok(
    events.some(
      (e) =>
        e.event === Events.RUN_UPDATED &&
        e.payload.run.recoveryAttempts?.[0]?.status === 'completed',
    ),
  );
  const audit = await readAuditLines();
  assert.equal(audit.at(-1).followupOutcome, 'recovered');
});
