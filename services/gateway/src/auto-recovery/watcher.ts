import { randomUUID } from 'node:crypto';

import {
  Events,
  type FailureCategory,
  FLOW_STEPS,
  type IntelligenceAction,
  type IntelligenceActionGuard,
  type IntelligenceActionOutcomeReason,
  type IntelligenceActionProposedType,
  isTerminalRunStatus,
  type MonitorViolation,
  type PipelineStep,
  PipelineSteps,
  RECOVERABLE_FAILURE_CATEGORIES,
  type Run,
} from '@farmslot/protocol';

import { loadProjectVars, normalizeRawProjectAutoRecovery } from '../core/config.js';
import { classifyFailureText } from '../core/failure-patterns.js';
import { runReplayStep } from '../methods/run/replay-step.js';
import { slotFixtureRefresh } from '../methods/slot.js';
import { getAllRuns, getRun, updateRun } from '../runs/store.js';

import { writeAuditRecord } from './audit-writer.js';
import { reconcileLlmBudgetReservation, reserveLlmBudget } from './llm-budget.js';
import { classifyWithLlm } from './llm-classify.js';

type Emit = (event: string, payload: unknown) => void;
type RunReplayStepFn = typeof runReplayStep;
type SlotFixtureRefreshFn = typeof slotFixtureRefresh;

interface AutoRecoveryConfig {
  enabled: boolean;
  maxAttempts: number;
  allowedSteps: string[];
  allowedCategories: FailureCategory[];
  disabledPatterns: string[];
  llmEnabled: boolean;
  llmDailyUsdCap: number;
  llmTimeoutMs: number;
}

const DEFAULT_LLM_TIMEOUT_MS = 20_000;
// Minimum viable budget for one bounded classification call. The budget ledger
// pessimistically reserves all remaining daily budget before the provider call
// and reconciles unused spend afterward.
const LLM_MINIMUM_CALL_BUDGET_USD = 0.01;
const mutexes = new Map<string, Promise<void>>();
const monitorTasks = new Set<Promise<void>>();
const terminalTasks = new Set<Promise<void>>();
const followupWritten = new Set<string>();
const monitorViolationWritten = new Set<string>();
const failedTerminalEventsSeen = new Set<string>();
const MAX_DEDUP_KEYS = 5000;
let emitFn: Emit = () => undefined;
let runReplayStepImpl: RunReplayStepFn = runReplayStep;
let slotFixtureRefreshImpl: SlotFixtureRefreshFn = slotFixtureRefresh;

function configFromProject(
  raw: Awaited<ReturnType<typeof loadProjectVars>>['projectJson'],
): AutoRecoveryConfig {
  const cfg = normalizeRawProjectAutoRecovery(raw.auto_recovery) ?? {};
  const configuredLlmTimeoutMs = cfg.llm?.timeoutMs;
  const configuredLlmDailyUsdCap = cfg.llm?.dailyUsdCap;
  return {
    enabled: cfg.enabled === true,
    maxAttempts: cfg.maxAttempts ?? 1,
    allowedSteps: cfg.allowedSteps ?? [
      PipelineSteps.PREPARE,
      PipelineSteps.MONITOR,
      PipelineSteps.CI_WATCH,
    ],
    allowedCategories: (cfg.allowedCategories ?? [
      ...RECOVERABLE_FAILURE_CATEGORIES,
    ]) as FailureCategory[],
    disabledPatterns: cfg.disabledPatterns ?? [],
    llmEnabled: cfg.llm?.enabled === true,
    llmDailyUsdCap:
      configuredLlmDailyUsdCap !== undefined && Number.isFinite(configuredLlmDailyUsdCap)
        ? configuredLlmDailyUsdCap
        : 0,
    llmTimeoutMs:
      configuredLlmTimeoutMs && configuredLlmTimeoutMs > 0
        ? configuredLlmTimeoutMs
        : DEFAULT_LLM_TIMEOUT_MS,
  };
}

function currentStepName(run: Run): string {
  return (
    run.steps.find((s) => s.status === 'failed')?.name ??
    run.steps.find((s) => s.status === 'running')?.name ??
    run.steps.find((s) => s.status === 'pending')?.name ??
    run.steps.find(
      (s) =>
        s.name === PipelineSteps.MONITOR && s.status === 'done' && monitorStepEndedRun(s.outputs),
    )?.name ??
    run.steps.at(-1)?.name ??
    'unknown'
  );
}

function monitorStepEndedRun(outputs: unknown): boolean {
  if (!outputs || typeof outputs !== 'object') return false;
  const workerSignal = (outputs as { workerSignal?: unknown }).workerSignal;
  if (!workerSignal || typeof workerSignal !== 'object') return false;
  const status = (workerSignal as { status?: unknown }).status;
  return status === 'failed' || status === 'blocked';
}

function monitorStepWorkerSignalStatus(run: Run): unknown {
  const monitorStep = run.steps.find((step) => step.name === PipelineSteps.MONITOR);
  if (monitorStep?.status !== 'done') return undefined;
  const outputs = monitorStep.outputs;
  if (!outputs || typeof outputs !== 'object') return undefined;
  const workerSignal = (outputs as { workerSignal?: unknown }).workerSignal;
  if (!workerSignal || typeof workerSignal !== 'object') return undefined;
  return (workerSignal as { status?: unknown }).status;
}

function isMonitorBlockedRecoveryCandidate(run: Run): boolean {
  return (
    run.status === 'blocked' &&
    !!run.completedAt &&
    monitorStepWorkerSignalStatus(run) === 'blocked'
  );
}

function isAutoRecoveryCandidateRun(run: Run): boolean {
  return run.status === 'failed' || isMonitorBlockedRecoveryCandidate(run);
}

function isTerminalRunForAutoRecovery(run: Run): boolean {
  return (
    isTerminalRunStatus(run.status) ||
    isMonitorBlockedRecoveryCandidate(run) ||
    isRecoveredToHumanGate(run)
  );
}

function failureText(run: Run): string {
  const parts = [run.error ?? ''];
  for (const step of run.steps) {
    if (step.status !== 'failed' && step.status !== 'running') continue;
    parts.push(step.detail ?? '');
    if (step.outputs && typeof step.outputs === 'object') {
      parts.push(JSON.stringify(step.outputs));
    }
  }
  return parts.filter(Boolean).join('\n').slice(0, 16000);
}

function guard(name: string, passed: boolean): IntelligenceActionGuard {
  return { name, passed };
}

function isConfiguredStepAllowed(cfg: AutoRecoveryConfig, stepName: string): boolean {
  return cfg.allowedSteps.includes(stepName);
}

function attemptsForStep(run: Run, stepName: string): number {
  return (run.recoveryAttempts ?? []).filter(
    (a) => a.triggeredBy === 'auto-recovery' && a.stepName === stepName,
  ).length;
}

function isRecoveredToHumanGate(run: Run): boolean {
  if (run.status !== 'blocked') return false;
  if (!run.recoveryAttempts?.some((attempt) => !attempt.completedAt)) return false;

  const flowSteps = FLOW_STEPS[run.flowType] ?? [];
  const humanGateIdx = flowSteps.indexOf(PipelineSteps.HUMAN_GATE);
  if (humanGateIdx < 0) return false;

  const humanGate = run.steps.find((step) => step.name === PipelineSteps.HUMAN_GATE);
  if (humanGate?.status !== 'running') return false;

  return run.recoveryAttempts.some((attempt) => {
    if (attempt.completedAt) return false;
    const attemptIdx = flowSteps.indexOf(attempt.stepName as (typeof flowSteps)[number]);
    if (attemptIdx < 0 || attemptIdx >= humanGateIdx) return false;
    return flowSteps
      .slice(attemptIdx, humanGateIdx)
      .every((stepName) => run.steps.find((step) => step.name === stepName)?.status === 'done');
  });
}

function hasInlineCiFix(run: Run): boolean {
  return (
    (run.ciWatchState?.totalAttempts ?? 0) > 0 || (run.ciWatchState?.consecutiveAttempts ?? 0) > 0
  );
}

function baseAction(run: Run, stepName: string, timestamp: string): IntelligenceAction {
  return {
    id: randomUUID(),
    timestamp,
    decidedAt: new Date().toISOString(),
    runId: run.id,
    familyId: run.familyId,
    project: run.project,
    stepName,
    actor: 'auto-recovery',
    verdict: { confidence: 'low' },
    guards: [],
    outcome: 'skipped',
    tier: 'deterministic',
    costUsd: 0,
  };
}

function monitorViolationKey(run: Run, violation: MonitorViolation): string {
  return `${run.id}:${run.engineState?.generation ?? 0}:${violation.type}:${violation.contextId ?? ''}:${violation.timestamp}`;
}

function rememberBounded(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > MAX_DEDUP_KEYS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

function findActiveRunForViolation(violation: MonitorViolation): Run | undefined {
  const candidates = getAllRuns()
    .filter((run) => run.slotId === violation.slotId && !isTerminalRunStatus(run.status))
    .sort(
      (a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt),
    );
  return candidates[0];
}

function classifyMonitorViolation(violation: MonitorViolation): {
  category: FailureCategory;
  patternId: string;
  confidence: 'high' | 'medium' | 'low';
} {
  if (violation.type === 'error')
    return { category: 'infra', patternId: 'worker-error', confidence: 'medium' };
  return {
    category: 'timeout',
    patternId:
      violation.type === 'idle'
        ? 'worker-idle'
        : violation.type === 'waiting'
          ? 'worker-waiting'
          : 'worker-stale',
    confidence: 'medium',
  };
}

async function writeMonitorViolationRecommendation(violation: MonitorViolation): Promise<void> {
  if (
    violation.type !== 'stuck' &&
    violation.type !== 'idle' &&
    violation.type !== 'waiting' &&
    violation.type !== 'error'
  )
    return;
  const run = findActiveRunForViolation(violation);
  if (!run) return;
  const key = monitorViolationKey(run, violation);
  if (!rememberBounded(monitorViolationWritten, key)) return;

  const stepName = currentStepName(run);
  const action = baseAction(run, stepName, violation.timestamp);
  action.actor = 'auto-nudge';
  action.appliedAction = { type: 'tmux.send' };
  const startedAt = Date.now();

  try {
    const pv = await loadProjectVars(run.project);
    const cfg = configFromProject(pv.projectJson);
    const verdict = classifyMonitorViolation(violation);
    action.verdict = {
      category: verdict.category,
      patternId: verdict.patternId,
      confidence: verdict.confidence,
    };

    const manualInProgress = run.recoveryProposal?.status === 'manual-in-progress';
    const autoDisabled =
      run.autoRecoveryDisabled === true || run.recoveryProposal?.status === 'disabled';
    const stepAllowed = isConfiguredStepAllowed(cfg, stepName);
    const categoryAllowed = cfg.allowedCategories.includes(verdict.category);
    action.guards.push(
      guard('enabled', cfg.enabled),
      guard('manual-not-in-progress', !manualInProgress),
      guard('operator-not-disabled', !autoDisabled),
      guard('step-allowed', stepAllowed),
      guard('category-allowed', categoryAllowed),
      guard('confidence', true),
    );

    action.latencyMs = Date.now() - startedAt;
    if (!cfg.enabled || manualInProgress || autoDisabled || !stepAllowed || !categoryAllowed) {
      action.outcome = 'skipped';
      action.outcomeReason =
        manualInProgress || autoDisabled ? 'manual_in_progress' : 'non_recoverable_category';
      await writeAuditRecord(action, { runId: run.id, emit: emitFn });
      return;
    }

    action.outcome = 'proposed';
    await writeAuditRecord(action, { runId: run.id, emit: emitFn });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    action.outcome = 'errored';
    action.outcomeReason = 'dead_letter';
    action.latencyMs = Date.now() - startedAt;
    markDeadLetter(run, message);
    await writeAuditRecord(action, { runId: run.id, emit: emitFn });
  }
}

function markDeadLetter(run: Run, message: string): void {
  const current = getRun(run.id) ?? run;
  const updated = updateRun(run.id, {
    engineState: { ...(current.engineState ?? {}), autoRecoveryDeadLetter: message },
  });
  emitFn(Events.RUN_UPDATED, { run: updated });
}

function isForceCompleteReplayRefuse(message: string): boolean {
  return message.includes('was force-completed and cannot be replayed');
}

function autoDispatchRaceReason(
  current: Run | undefined,
  expectedGeneration: number,
): IntelligenceActionOutcomeReason | null {
  if (!current) return 'dead_letter';
  if (!isAutoRecoveryCandidateRun(current)) return 'manual_in_progress';
  if (current.recoveryProposal?.status === 'manual-in-progress') return 'manual_in_progress';
  if (current.autoRecoveryDisabled === true || current.recoveryProposal?.status === 'disabled')
    return 'manual_in_progress';
  if ((current.engineState?.generation ?? 0) !== expectedGeneration) return 'manual_in_progress';
  return null;
}

function failedTerminalEventKey(run: Run): string {
  return `${run.id}:${run.completedAt ?? 'no-completedAt'}:${run.engineState?.generation ?? 0}`;
}

function clearAutoInProgress(runId: string, proposalId: string): void {
  const current = getRun(runId);
  if (
    current?.recoveryProposal?.status !== 'auto-in-progress' ||
    current.recoveryProposal.proposalId !== proposalId
  )
    return;
  const updated = updateRun(runId, {
    recoveryProposal: { status: 'idle', generation: current.engineState?.generation ?? 0 },
  });
  emitFn(Events.RUN_UPDATED, { run: updated });
}

async function classify(
  run: Run,
  cfg: AutoRecoveryConfig,
): Promise<{
  category?: FailureCategory;
  patternId?: string;
  confidence: 'high' | 'medium' | 'low';
  tier: 'deterministic' | 'llm-refined';
  costUsd: number;
  warning?: string;
  proposedAction?: { type: IntelligenceActionProposedType; stepName?: string; tmuxKeys?: string };
}> {
  const text = failureText(run);
  const det = classifyFailureText(text, cfg.disabledPatterns);

  if (det && !cfg.disabledPatterns.includes(det.patternId)) {
    return {
      category: det.category,
      patternId: det.patternId,
      confidence: det.confidence,
      tier: 'deterministic',
      costUsd: 0,
    };
  }
  if (det && cfg.disabledPatterns.includes(det.patternId)) {
    return {
      category: det.category,
      patternId: det.patternId,
      confidence: 'low',
      tier: 'deterministic',
      costUsd: 0,
      warning: 'pattern_disabled',
    };
  }
  if (!cfg.llmEnabled) return { confidence: 'low', tier: 'deterministic', costUsd: 0 };

  const estimatedCost = LLM_MINIMUM_CALL_BUDGET_USD;
  const budgetDate = new Date();
  const reservation = await reserveLlmBudget(
    run.project,
    cfg.llmDailyUsdCap,
    estimatedCost,
    budgetDate,
  );
  if (!reservation) {
    return { confidence: 'low', tier: 'llm-refined', costUsd: 0, warning: 'budget_exceeded' };
  }

  const llm = await classifyWithLlm(run.project, text, { timeoutMs: cfg.llmTimeoutMs });

  const costUsd = Number.isFinite(llm.costUsd) && llm.costUsd > 0 ? llm.costUsd : estimatedCost;
  const budget = await reconcileLlmBudgetReservation(
    run.project,
    reservation.reservedCostUsd,
    costUsd,
    cfg.llmDailyUsdCap,
    budgetDate,
  );
  if (budget.overBudget)
    return { confidence: 'low', tier: 'llm-refined', costUsd, warning: 'budget_exceeded' };
  return {
    category: llm.verdict.category,
    confidence: llm.verdict.confidence,
    tier: 'llm-refined',
    costUsd,
    warning: llm.verdict.warning,
    proposedAction: llm.verdict.proposedAction,
  };
}

async function maybeDispatchFixtureRefresh(run: Run, action: IntelligenceAction): Promise<void> {
  if (
    (action.verdict.category !== 'env-drift' &&
      action.appliedAction?.type !== 'slot.fixtureRefresh') ||
    !run.slotId
  )
    return;
  await slotFixtureRefreshImpl(
    {
      slotId: run.slotId,
      requestId: `auto-recovery-${action.id}`,
      flowType: run.flowType,
      app: run.app,
      domain: run.domain,
    },
    emitFn,
  );
  action.appliedAction = { type: 'slot.fixtureRefresh' };
}

function canAutoApplyProposedAction(type: IntelligenceActionProposedType): boolean {
  return type === 'run.replayStep' || type === 'slot.fixtureRefresh';
}

function skipReason(
  run: Run,
  cfg: AutoRecoveryConfig,
  stepName: string,
  verdict: Awaited<ReturnType<typeof classify>>,
): { reason?: IntelligenceActionOutcomeReason; guards: IntelligenceActionGuard[] } {
  const manualInProgress = run.recoveryProposal?.status === 'manual-in-progress';
  const autoDisabled =
    run.autoRecoveryDisabled === true || run.recoveryProposal?.status === 'disabled';
  const categoryAllowed = !!verdict.category && cfg.allowedCategories.includes(verdict.category);
  const stepAllowed = isConfiguredStepAllowed(cfg, stepName);
  const underAttempts = attemptsForStep(run, stepName) < cfg.maxAttempts;
  const confidenceOk = verdict.confidence === 'high' || verdict.confidence === 'medium';
  const ciInlineOk = !(stepName === PipelineSteps.CI_WATCH && hasInlineCiFix(run));
  const patternEnabled = verdict.warning !== 'pattern_disabled';
  const budgetOk = verdict.warning !== 'budget_exceeded';

  const guards = [
    guard('enabled', true),
    guard('manual-not-in-progress', !manualInProgress),
    guard('operator-not-disabled', !autoDisabled),
    guard('step-allowed', stepAllowed),
    guard('category-allowed', categoryAllowed),
    guard('max-attempts-per-step', underAttempts),
    guard('confidence', confidenceOk),
    guard('ci-watch-inline-fix-idle', ciInlineOk),
    guard('pattern-enabled', patternEnabled),
    guard('budget', budgetOk),
  ];

  if (manualInProgress || autoDisabled) return { guards, reason: 'manual_in_progress' };
  if (!underAttempts) return { guards, reason: 'max_attempts_per_step' };
  if (!patternEnabled) return { guards, reason: 'pattern_disabled' };
  if (!budgetOk) return { guards, reason: 'budget_exceeded' };
  if (!categoryAllowed || !stepAllowed) return { guards, reason: 'non_recoverable_category' };
  if (!confidenceOk) return { guards, reason: 'low_confidence' };
  // A CI inline-fix replay already owns this run's recovery lane. Reuse the
  // existing manual-in-progress skip reason instead of expanding the public
  // outcomeReason enum for an internal runner handoff state.
  if (!ciInlineOk) return { guards, reason: 'manual_in_progress' };
  return { guards };
}

function effectiveReplayStep(
  run: Run,
  fallbackStepName: string,
  proposedAction?: Awaited<ReturnType<typeof classify>>['proposedAction'],
): string {
  if (proposedAction?.type !== 'run.replayStep' || !proposedAction.stepName)
    return fallbackStepName;
  return proposedAction.stepName;
}

function isReplayStepAllowed(run: Run, cfg: AutoRecoveryConfig, stepName: string): boolean {
  const flowAllowsStep = (FLOW_STEPS[run.flowType] ?? []).includes(stepName as PipelineStep);
  const projectAllowsStep = isConfiguredStepAllowed(cfg, stepName);
  return flowAllowsStep && projectAllowsStep;
}

async function writeSkippedAction(
  action: IntelligenceAction,
  reason: IntelligenceActionOutcomeReason,
  startedAt: number,
): Promise<void> {
  action.outcome = 'skipped';
  action.outcomeReason = reason;
  action.latencyMs = Date.now() - startedAt;
  await writeAuditRecord(action, { runId: action.runId, emit: emitFn });
}

async function maybeRecoverRun(run: Run, timestamp?: string): Promise<void> {
  const stepName = currentStepName(run);
  const action = baseAction(
    run,
    stepName,
    timestamp ?? run.completedAt ?? run.updatedAt ?? new Date().toISOString(),
  );
  const startedAt = Date.now();
  const expectedGeneration = run.engineState?.generation ?? 0;
  let replayAccepted = false;

  try {
    const pv = await loadProjectVars(run.project);
    const cfg = configFromProject(pv.projectJson);
    if (!cfg.enabled) {
      action.guards.push(guard('enabled', false));
      action.outcomeReason = 'non_recoverable_category';
      await writeAuditRecord(action, { runId: run.id, emit: emitFn });
      return;
    }

    const verdict = await classify(run, cfg);
    action.tier = verdict.tier;
    action.costUsd = verdict.costUsd;
    action.verdict = {
      confidence: verdict.confidence,
      ...(verdict.category ? { category: verdict.category } : {}),
      ...(verdict.patternId ? { patternId: verdict.patternId } : {}),
    };
    if (verdict.proposedAction) {
      action.appliedAction = verdict.proposedAction;
    }

    const { guards, reason } = skipReason(run, cfg, stepName, verdict);
    action.guards.push(...guards);
    const replayStepName = effectiveReplayStep(run, stepName, verdict.proposedAction);
    const effectiveStepAllowed = isReplayStepAllowed(run, cfg, replayStepName);
    const effectiveUnderAttempts = attemptsForStep(run, replayStepName) < cfg.maxAttempts;
    if (verdict.proposedAction?.type === 'run.replayStep') {
      action.guards.push(guard('effective-replay-step-allowed', effectiveStepAllowed));
      action.guards.push(guard('effective-replay-step-under-attempts', effectiveUnderAttempts));
    }
    if (reason) {
      await writeSkippedAction(action, reason, startedAt);
      return;
    }
    if (!effectiveStepAllowed) {
      await writeSkippedAction(action, 'non_recoverable_category', startedAt);
      return;
    }
    if (!effectiveUnderAttempts) {
      await writeSkippedAction(action, 'max_attempts_per_step', startedAt);
      return;
    }

    const preDispatchRun = getRun(run.id);
    const preDispatchReason = autoDispatchRaceReason(preDispatchRun, expectedGeneration);
    if (preDispatchReason) {
      action.guards.push(guard('run-still-failed', preDispatchRun?.status === 'failed'));
      action.guards.push(
        guard(
          'generation-unchanged',
          (preDispatchRun?.engineState?.generation ?? 0) === expectedGeneration,
        ),
      );
      await writeSkippedAction(action, preDispatchReason, startedAt);
      return;
    }

    if (verdict.proposedAction && !canAutoApplyProposedAction(verdict.proposedAction.type)) {
      action.outcome = 'proposed';
      action.latencyMs = Date.now() - startedAt;
      await writeAuditRecord(action, { runId: run.id, emit: emitFn });
      return;
    }

    const updated = updateRun(run.id, {
      recoveryProposal: {
        status: 'auto-in-progress',
        proposalId: action.id,
        generation: expectedGeneration,
      },
    });
    emitFn(Events.RUN_UPDATED, { run: updated });

    await maybeDispatchFixtureRefresh(updated, action);

    const postFixtureRun = getRun(run.id);
    const postFixtureReason = autoDispatchRaceReason(postFixtureRun, expectedGeneration);
    if (postFixtureReason) {
      action.guards.push(guard('run-still-failed', postFixtureRun?.status === 'failed'));
      action.guards.push(
        guard(
          'generation-unchanged',
          (postFixtureRun?.engineState?.generation ?? 0) === expectedGeneration,
        ),
      );
      clearAutoInProgress(run.id, action.id);
      await writeSkippedAction(action, postFixtureReason, startedAt);
      return;
    }

    const replay = await runReplayStepImpl(
      {
        runId: run.id,
        stepName: replayStepName,
        triggeredBy: 'auto-recovery',
        intelligenceActionId: action.id,
      },
      emitFn,
    );
    replayAccepted = true;
    action.appliedAction =
      action.appliedAction?.type === 'slot.fixtureRefresh'
        ? { ...action.appliedAction, replayRunId: replay.run.id }
        : { type: 'run.replayStep', stepName: replayStepName, replayRunId: replay.run.id };
    action.outcome = 'applied';
    action.latencyMs = Date.now() - startedAt;
    await writeAuditRecord(action, { runId: run.id, emit: emitFn });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    action.latencyMs = Date.now() - startedAt;
    if (!replayAccepted) clearAutoInProgress(run.id, action.id);
    if (isForceCompleteReplayRefuse(message)) {
      await writeSkippedAction(action, 'manual_in_progress', startedAt);
      return;
    }
    action.outcome = 'errored';
    action.outcomeReason = 'dead_letter';
    markDeadLetter(run, message);
    await writeAuditRecord(action, { runId: run.id, emit: emitFn });
  }
}

function enqueueRun(run: Run, timestamp?: string): Promise<void> {
  const previous = mutexes.get(run.id) ?? Promise.resolve();
  const next = previous.then(() => {
    const latest = getRun(run.id);
    if (!latest || !isAutoRecoveryCandidateRun(latest)) return;
    return maybeRecoverRun(latest, timestamp);
  });
  mutexes.set(
    run.id,
    next.finally(() => {
      if (mutexes.get(run.id) === next) mutexes.delete(run.id);
    }),
  );
  return next;
}

async function writeFollowup(run: Run): Promise<void> {
  const openAttempts = (run.recoveryAttempts ?? []).filter((a) => !a.completedAt);
  const latest = openAttempts.at(-1);
  if (!latest) return;

  const recoveredToHumanGate = isRecoveredToHumanGate(run);
  const humanGateStartedAt = run.steps.find(
    (step) => step.name === PipelineSteps.HUMAN_GATE,
  )?.startedAt;
  const completedAt = run.completedAt ?? humanGateStartedAt ?? new Date().toISOString();
  const completedOpenAttemptIds = new Set(
    recoveredToHumanGate ? openAttempts.map((attempt) => attempt.id) : [latest.id],
  );
  const attempts = (run.recoveryAttempts ?? []).map((a) =>
    completedOpenAttemptIds.has(a.id)
      ? {
          ...a,
          completedAt,
          status:
            run.status === 'done' || recoveredToHumanGate
              ? ('completed' as const)
              : run.status === 'cancelled'
                ? ('cancelled' as const)
                : ('failed' as const),
        }
      : a,
  );
  const updated = updateRun(run.id, {
    recoveryAttempts: attempts,
    recoveryProposal: { status: 'idle', generation: run.engineState?.generation ?? 0 },
  });
  emitFn(Events.RUN_UPDATED, { run: updated });
  if (latest.triggeredBy !== 'auto-recovery' || !rememberBounded(followupWritten, latest.id))
    return;

  const outcome =
    run.status === 'done' || recoveredToHumanGate
      ? 'recovered'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'failed-again';
  await writeAuditRecord(
    {
      id: randomUUID(),
      timestamp: completedAt,
      decidedAt: new Date().toISOString(),
      runId: run.id,
      familyId: run.familyId,
      project: run.project,
      stepName: latest.stepName,
      actor: 'auto-recovery',
      verdict: { confidence: 'high' },
      guards: [],
      // Follow-up rows observe a prior recovery attempt's terminal state. No new
      // action is proposed or applied by this row, so it is recorded as skipped.
      outcome: 'skipped',
      followupOutcome: outcome,
      tier: 'deterministic',
      costUsd: 0,
    },
    { runId: run.id, emit: emitFn },
  );
}

async function handleTerminalRun(run: Run): Promise<void> {
  await writeFollowup(run);
  if (isAutoRecoveryCandidateRun(run)) {
    await enqueueRun(getRun(run.id) ?? run);
  }
}

export function initAutoRecovery(emit: Emit): void {
  emitFn = emit;
}

export function routeEventToAutoRecovery(event: string, payload: unknown): void {
  if (event === Events.MONITOR_VIOLATION) {
    const violation = (payload as { violation?: MonitorViolation }).violation;
    if (violation) {
      const task = writeMonitorViolationRecommendation(violation).catch((err) => {
        // Monitor-violation recommendations are advisory audit rows, not run
        // state transitions. Keep the event fan-out alive; terminal run recovery
        // paths still dead-letter through handleTerminalRun below.
        console.error(
          '[auto-recovery] monitor violation recommendation failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
      monitorTasks.add(task);
      void task.finally(() => monitorTasks.delete(task));
    }
    return;
  }
  if (event !== Events.RUN_UPDATED && event !== Events.RUN_COMPLETED) return;
  const run = (payload as { run?: Run }).run;
  if (!run || !isTerminalRunForAutoRecovery(run)) return;
  if (
    isAutoRecoveryCandidateRun(run) &&
    !rememberBounded(failedTerminalEventsSeen, failedTerminalEventKey(run))
  )
    return;
  const task = handleTerminalRun(run).catch((err) => {
    markDeadLetter(run, err instanceof Error ? err.message : String(err));
  });
  terminalTasks.add(task);
  void task.finally(() => terminalTasks.delete(task));
}

export async function scanFailedRunsForAutoRecovery(now = new Date()): Promise<void> {
  const cutoff = now.getTime() - 5 * 60 * 1000;
  const queued: Promise<void>[] = [];
  for (const run of getAllRuns()) {
    if (!isAutoRecoveryCandidateRun(run) || !run.completedAt) continue;
    const ms = Date.parse(run.completedAt);
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    if (!rememberBounded(failedTerminalEventsSeen, failedTerminalEventKey(run))) continue;
    queued.push(enqueueRun(run, run.completedAt));
  }
  await Promise.all(queued);
}

export async function __drainAutoRecoveryForTest(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = [...mutexes.values(), ...monitorTasks.values(), ...terminalTasks.values()];
    if (pending.length === 0) continue;
    await Promise.all(pending);
  }
}

export function __setAutoRecoveryHandlersForTest(
  handlers: {
    runReplayStep?: RunReplayStepFn;
    slotFixtureRefresh?: SlotFixtureRefreshFn;
  } | null,
): void {
  runReplayStepImpl = handlers?.runReplayStep ?? runReplayStep;
  slotFixtureRefreshImpl = handlers?.slotFixtureRefresh ?? slotFixtureRefresh;
}

export function __resetAutoRecoveryForTest(): void {
  mutexes.clear();
  monitorTasks.clear();
  terminalTasks.clear();
  followupWritten.clear();
  monitorViolationWritten.clear();
  failedTerminalEventsSeen.clear();
  emitFn = () => undefined;
  runReplayStepImpl = runReplayStep;
  slotFixtureRefreshImpl = slotFixtureRefresh;
}
