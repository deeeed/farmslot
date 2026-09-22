import type {
  CiCheckUpdatedPayload,
  CIWatchFixProgress,
  CIWatchFixTrigger,
  CIWatchPhase,
  DevInteractiveCompletionAction,
  FamilyObservabilityArtifact,
  PRStatus,
  RecipeRunArtifactGroup,
  Run,
  RunDecision,
  RunStep,
  TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import {
  buildComparisonVariant,
  isTerminalRunStatus,
  resolveRunSlotId,
  shouldAcceptTaskProgressUpdate as shouldAcceptTaskProgressForActiveChecklist,
} from '@farmslot/protocol';

import { desiredRecipeRunId } from '../shared/recipe-run-selection-model.js';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function reviewTerminalUnavailableReason(
  run: Pick<Run, 'reviewWorkspace' | 'transport' | 'agentContexts' | 'status'>,
): string | null {
  if (!run.reviewWorkspace) return null;
  if (run.reviewWorkspace.cleanedAt) return 'The review worktree has been cleaned up.';
  if (
    run.transport === 'tmux' &&
    !run.agentContexts?.some(
      (context) => context.id === 'review' && context.promptDeliveryStartedAt,
    )
  )
    return run.status === 'failed' || run.status === 'blocked'
      ? 'The review failed before its terminal started. Retry the failed step to launch the reviewer.'
      : 'The reviewer terminal will be available after dispatch.';
  return null;
}

export function isActiveInteractiveDevRun(run: Run): boolean {
  return run.flowType === 'dev' && run.mode === 'interactive' && !isTerminalRunStatus(run.status);
}

export function isInteractiveCompletionAwaitingOperator(run: Run | undefined): boolean {
  if (!run || run.status !== 'paused' || !isActiveInteractiveDevRun(run)) return false;
  const monitor = run.steps.find((step) => step.name === 'monitor');
  return (
    monitor?.status === 'running' &&
    monitor.outputs?.awaitingOperator === true &&
    monitor.outputs?.reason === 'interactive-completion-operator-owned'
  );
}

export function canReplayRunSteps(
  run:
    | Pick<Run, 'status' | 'decisions' | 'slotId' | 'steps' | 'agentContexts' | 'engineState'>
    | null
    | undefined,
  actionsBlocked = false,
): boolean {
  if (!run || actionsBlocked) return false;
  if (run.engineState?.operatorForceCompleted) return false;
  if (isTerminalRunStatus(run.status)) return true;
  // A blocked run is still live, so replay must re-enter its own slot. Offering
  // it after the slot was released only surfaces a backend reclaim failure.
  return (
    run.status === 'blocked' &&
    !!resolveRunSlotId(run) &&
    !run.decisions.some((decision) => !decision.resolvedAt)
  );
}

export function pendingCITimeoutDecision(run: Pick<Run, 'decisions'>): RunDecision | null {
  return (
    run.decisions.find((decision) => decision.type === 'ci_ci_timeout' && !decision.resolvedAt) ??
    null
  );
}

export function shouldShowRunCiStatus(run: Pick<Run, 'decisions' | 'status' | 'steps'>): boolean {
  return (
    run.status === 'ci-watching' ||
    Boolean(run.steps.find((step) => step.name === 'ci-watch') && pendingCITimeoutDecision(run))
  );
}

export function isLiveTimeoutPrStatusAllGreen(
  prStatus: Pick<PRStatus, 'checkSummary'> | null,
): boolean {
  const summary = prStatus?.checkSummary;
  // Skipped checks count toward total but must not block recovery: green means
  // nothing failed, nothing still running, and at least one check passed.
  return Boolean(
    summary &&
    summary.total > 0 &&
    summary.passed > 0 &&
    summary.failed === 0 &&
    summary.pending === 0,
  );
}

export function runFamilyPrStatus(
  run: Pick<Run, 'familyId'>,
  runs: readonly Pick<Run, 'familyId' | 'prNumber'>[],
  prs: readonly PRStatus[],
): PRStatus | null {
  const familyRuns = runs.filter((candidate) => candidate.familyId === run.familyId);
  const prNumbers = [
    ...new Set(
      familyRuns
        .map((candidate) => candidate.prNumber)
        .filter((value): value is number => value != null),
    ),
  ];
  if (prNumbers.length === 0) return null;
  return prs.find((pr) => prNumbers.includes(pr.pr)) ?? null;
}

const LIVE_PROGRESS_STEPS = new Set(['monitor', 'self-review', 'ci-watch', 'human-gate']);

export function isTaskProgressRunActive(
  run: Pick<Run, 'activeTaskFile' | 'status' | 'taskFile'> & {
    steps?: readonly Pick<RunStep, 'name' | 'status'>[];
  },
  options: { includeCompleting?: boolean } = {},
): boolean {
  if (
    run.status === 'monitoring' ||
    run.status === 'paused' ||
    run.status === 'self-reviewing' ||
    run.status === 'human-gating' ||
    run.status === 'ci-watching' ||
    (options.includeCompleting === true && run.status === 'completing') ||
    Boolean(run.activeTaskFile && run.activeTaskFile !== run.taskFile)
  ) {
    return true;
  }
  return Boolean(
    run.status === 'blocked' &&
    run.steps?.some((step) => LIVE_PROGRESS_STEPS.has(step.name) && step.status === 'running'),
  );
}

export function hasActiveInlineCiFix(run: Pick<Run, 'steps'>): boolean {
  const ciStep = run.steps.find((step) => step.name === 'ci-watch');
  const ciOut = (ciStep?.outputs ?? {}) as Record<string, unknown>;
  return (
    ciOut.fixInProgress === true &&
    (ciOut.phase === 'fixing' || ciOut.phase === 'waiting_for_worker')
  );
}

/**
 * Does this progress update belong to the run on screen? A static review
 * workspace run (ADR-058) has no slot, and its progress publishes under an empty
 * slot id, so the comparison is on the pair rather than on a slot id that only a
 * slot run has.
 */
export function taskProgressUpdateTargetsRun(
  run: Pick<Run, 'id' | 'slotId' | 'reviewWorkspace'> | null,
  update: Pick<TaskProgressUpdatedPayload, 'slotId' | 'runId'>,
): boolean {
  if (!run || (!run.slotId && !run.reviewWorkspace)) return false;
  return (run.slotId ?? '') === update.slotId && update.runId === run.id;
}

export function shouldAcceptTaskProgressUpdate(
  run: Pick<Run, 'activeTaskFile' | 'taskFile'> | null,
  // `parentChecklist` travels on child-unit updates (ADR-060); the protocol rule
  // needs it to tell a live child from one whose parent checklist is settled.
  update: Pick<TaskProgressUpdatedPayload, 'contextId' | 'role' | 'parentChecklist'>,
): boolean {
  return shouldAcceptTaskProgressForActiveChecklist(run, update);
}

export interface RunEvidenceLightboxItem {
  url: string;
  path: string;
  purpose: string;
  caption: string;
  frameRate?: number;
}

export function runEvidenceLightboxItems(
  artifacts: readonly FamilyObservabilityArtifact[],
  artifactUrl: (artifact: FamilyObservabilityArtifact) => string,
): RunEvidenceLightboxItem[] {
  return artifacts.map((artifact) => ({
    url: artifactUrl(artifact),
    path: artifact.path,
    purpose: artifact.purpose,
    caption: [
      artifact.stepName ? `step ${artifact.stepName}` : '',
      artifact.source.replace(/-/g, ' '),
    ]
      .filter(Boolean)
      .join(' · '),
    ...(artifact.maxFps != null ? { frameRate: artifact.maxFps } : {}),
  }));
}

export interface RunEvidenceSummary {
  shouldRender: boolean;
  completeStep: RunStep | undefined;
  title: string;
  badge: string;
  status: RunStep['status'];
  copy: string;
  showEvalPackageHint: boolean;
  emptyMessage: string;
}

export function runEvidenceSummary(
  run: Run,
  artifacts: readonly FamilyObservabilityArtifact[],
): RunEvidenceSummary {
  const isReplay =
    run.completionPolicy === 'artifact-only' || run.lane === 'comparison' || Boolean(run.startRef);
  const completeStep = run.steps.find((step) => step.name === 'complete');
  const sourceRef = run.startRef?.resolvedSha ?? run.startRef?.requestedRef;
  return {
    shouldRender: isReplay || artifacts.length > 0,
    completeStep,
    title: isReplay ? 'Replay evidence' : 'Run evidence',
    badge: isReplay ? 'comparison · artifact-only' : 'artifacts',
    status:
      completeStep?.status ??
      (run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : 'pending'),
    copy: run.startRef
      ? `This replay started from ${sourceRef ?? 'the selected ref'} and stopped at artifacts. Prior-run replay comparisons are represented by eval Reference and Candidate packages, not run parentage; no PR was published.`
      : isReplay
        ? 'This comparison run stops at artifacts instead of publishing a PR. Use these captured files as the run output evidence.'
        : 'Final artifacts captured by the worker.',
    showEvalPackageHint: Boolean(run.startRef),
    emptyMessage: 'No artifacts have been captured for this replay yet.',
  };
}

export function buildRunDiagnosisPrompt(run: Run): string {
  const failedSteps = run.steps.filter((step) => step.status === 'failed').map((step) => step.name);
  const slotId = resolveRunSlotId(run);
  return [
    `Why did run ${run.id} fail?`,
    `Ticket or PR: ${run.ticketOrPr}`,
    `Flow: ${run.flowType}`,
    slotId ? `Slot: ${slotId}` : '',
    run.error ? `Run error: ${run.error}` : '',
    failedSteps.length ? `Failed steps: ${failedSteps.join(', ')}` : '',
    'Call propose_run_recovery first, then use gateway evidence only if deeper detail is needed.',
    'Show the proposal finding, evidence, confidence, inference notes, and read-only next steps.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a `#dispatch?lane=comparison&...` href that prefills the wizard for
 * forking a comparison-lane sibling of this run. Baseline runner/model are
 * included when known so the operator starts from the same engine and can
 * still switch before dispatch.
 */
export function buildRerunAlongsideHref(run: Run, hash?: string): string {
  const params = new URLSearchParams();
  params.set('flow', run.flowType);
  params.set('ticket', run.ticketOrPr);
  params.set('project', run.project);
  params.set('lane', 'comparison');
  params.set('familyId', run.familyId);
  params.set('parentRunId', run.id);
  if (run.transport) params.set('transport', run.transport);
  const runner = run.metrics?.runner;
  const model = run.metrics?.model;
  if (runner) params.set('runner', runner);
  if (model) params.set('model', model);
  const variant = buildComparisonVariant(runner, model);
  if (variant) params.set('variant', variant);
  const sourceHash = hash ?? (typeof location !== 'undefined' ? location.hash : '');
  const hashQuery = sourceHash.includes('?') ? sourceHash.slice(sourceHash.indexOf('?') + 1) : '';
  const hashParams = new URLSearchParams(hashQuery);
  const machines = hashParams.get('machines');
  if (machines) params.set('machines', machines);
  return `#dispatch?${params.toString()}`;
}

export { canLaunchComparisonSibling } from './run-selector-model.js';

export function runDetailDesiredRecipeRunId(input: {
  recipeRuns: readonly Pick<RecipeRunArtifactGroup, 'id'>[];
  pendingRecipeRunId: string;
  currentRecipeRunId: string;
  gatewaySelectedRecipeRunId: string | null;
}): string {
  return desiredRecipeRunId(input.recipeRuns, [
    input.pendingRecipeRunId,
    input.currentRecipeRunId,
    input.gatewaySelectedRecipeRunId,
  ]);
}

export interface InteractiveDevActionModel {
  action: DevInteractiveCompletionAction;
  label: string;
  title: string;
  tone: 'primary' | 'muted' | 'danger';
}

export const INTERACTIVE_DEV_ACTIONS: readonly InteractiveDevActionModel[] = [
  {
    action: 'done-no-pr',
    label: 'Done no PR',
    title: 'Finish this dev task without PR or CI-watch.',
    tone: 'primary',
  },
  {
    action: 'detect-pr-and-ci-watch',
    label: 'Detect PR + CI',
    title: 'Find the PR from this run branch and start CI-watch.',
    tone: 'muted',
  },
  {
    action: 'link-pr-and-ci-watch',
    label: 'Link PR + CI',
    title: 'Link a PR ref manually and start CI-watch.',
    tone: 'muted',
  },
  {
    action: 'link-pr-and-pr-complete',
    label: 'PR Complete',
    title: 'Link a PR and start a pr-complete follow-up run.',
    tone: 'muted',
  },
  {
    action: 'run-self-review',
    label: 'Self-review',
    title: 'Run or replay self-review before finishing.',
    tone: 'muted',
  },
  {
    action: 'blocked',
    label: 'Blocked',
    title: 'Mark this interactive dev task blocked.',
    tone: 'muted',
  },
  {
    action: 'failed',
    label: 'Failed',
    title: 'Mark this interactive dev task failed.',
    tone: 'danger',
  },
  {
    action: 'abort',
    label: 'Abort',
    title: 'Cancel this interactive dev task.',
    tone: 'danger',
  },
];

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

interface PersistedCiSummary {
  passed?: number;
  failed?: number;
  pending?: number;
  skipped?: number;
  total?: number;
}

interface PersistedCiTimelineEntry {
  status?: string;
  detail?: string;
  timestamp?: string;
}

interface PersistedCiWatchOutputs {
  checkSummary?: PersistedCiSummary;
  checkTimeline: PersistedCiTimelineEntry[];
  result?: string;
  passedNames: string[];
  failedNames: string[];
  pendingNames: string[];
  pollCount: number;
  pollIntervalMs?: number;
  lastCheckedAt?: string;
  phase?: CIWatchPhase;
  fixInProgress?: boolean;
  fixTrigger?: CIWatchFixTrigger;
  fixProgress?: CIWatchFixProgress;
  activeTaskFile?: string | null;
  nextPollAt?: string | null;
  lastSignalAt?: string | null;
  dedupReason?: string | null;
  lastFixCommitSha?: string | null;
  timeoutWindowStartedAt?: string;
  lastProgressAt?: string;
  lastProgressReason?: string;
  inlineFixAttempts?: number;
  inlineFixTotalAttempts?: number;
}

const CI_WATCH_PHASES = new Set<string>([
  'polling',
  'deduped',
  'fixing',
  'waiting_for_worker',
  'blocked',
  'decision_required',
  'done',
]);

function readCiWatchPhase(value: unknown): CIWatchPhase | undefined {
  return typeof value === 'string' && CI_WATCH_PHASES.has(value)
    ? (value as CIWatchPhase)
    : undefined;
}

function readCiFixTrigger(value: unknown): CIWatchFixTrigger | undefined {
  // Persisted ci-watch outputs are an untyped Record bag, but the UI should only
  // surface protocol-owned fix trigger values. Unknown legacy strings are
  // intentionally dropped so downstream status badges do not normalize shape drift.
  if (value === null || value === 'failed_checks' || value === 'bot_comments') return value;
  return undefined;
}

function readCiFixProgress(value: unknown): CIWatchFixProgress | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const completed = record.completed;
  const total = record.total;
  if (typeof completed !== 'number' || typeof total !== 'number') return undefined;
  const currentLabel = optionalNullableString(record.currentLabel);
  return currentLabel === undefined ? { completed, total } : { completed, total, currentLabel };
}

function readCiSummary(value: unknown): PersistedCiSummary | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  return {
    passed: optionalNumber(record.passed),
    failed: optionalNumber(record.failed),
    pending: optionalNumber(record.pending),
    skipped: optionalNumber(record.skipped),
    total: optionalNumber(record.total),
  };
}

function readCiTimeline(value: unknown): PersistedCiTimelineEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      status: optionalString(entry.status),
      detail: optionalString(entry.detail),
      timestamp: optionalString(entry.timestamp),
    }));
}

export function readCiWatchOutputs(
  outputs: RunStep['outputs'] | undefined,
): PersistedCiWatchOutputs | null {
  if (!outputs) return null;
  const hasFailedNamesField = Array.isArray(outputs.failedNames);
  return {
    checkSummary: readCiSummary(outputs.checkSummary),
    checkTimeline: readCiTimeline(outputs.checkTimeline),
    result: optionalString(outputs.result),
    passedNames: stringList(outputs.passedNames),
    failedNames: hasFailedNamesField
      ? stringList(outputs.failedNames)
      : stringList(outputs.failedChecks),
    pendingNames: stringList(outputs.pendingNames),
    pollCount: Number(outputs.pollCount ?? 0),
    pollIntervalMs: optionalNumber(outputs.pollIntervalMs),
    lastCheckedAt: optionalString(outputs.lastCheckedAt),
    phase: readCiWatchPhase(outputs.phase),
    fixInProgress: optionalBoolean(outputs.fixInProgress),
    fixTrigger: readCiFixTrigger(outputs.fixTrigger),
    fixProgress: readCiFixProgress(outputs.fixProgress),
    activeTaskFile: optionalNullableString(outputs.activeTaskFile),
    nextPollAt: optionalNullableString(outputs.nextPollAt),
    lastSignalAt: optionalNullableString(outputs.lastSignalAt),
    dedupReason: optionalNullableString(outputs.dedupReason),
    lastFixCommitSha: optionalNullableString(outputs.lastFixCommitSha),
    timeoutWindowStartedAt: optionalString(outputs.timeoutWindowStartedAt),
    lastProgressAt: optionalString(outputs.lastProgressAt),
    lastProgressReason: optionalString(outputs.lastProgressReason),
    inlineFixAttempts: optionalNumber(outputs.inlineFixAttempts),
    inlineFixTotalAttempts: optionalNumber(outputs.inlineFixTotalAttempts),
  };
}

export function persistedCiStatusFromRun(run: Run): CiCheckUpdatedPayload | null {
  const ciStep = run.steps.find((step) => step.name === 'ci-watch');
  const out = readCiWatchOutputs(ciStep?.outputs);
  if (!out) return null;

  const storedSummary = out.checkSummary;
  const timeline = out.checkTimeline;
  const latest = timeline.length > 0 ? timeline[timeline.length - 1] : null;
  const statusLine = latest?.status ?? '';
  const match = /(\d+)\/(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+pending/i.exec(statusLine);
  const passed = storedSummary?.passed ?? (match ? Number(match[1]) : 0);
  const total = storedSummary?.total ?? (match ? Number(match[2]) : 0);
  const failed = storedSummary?.failed ?? (match ? Number(match[3]) : 0);
  const pending = storedSummary?.pending ?? (match ? Number(match[4]) : 0);
  // The regexed status line has no skipped figure; only stored summaries carry it.
  const skipped = storedSummary?.skipped;

  return {
    runId: run.id,
    prNumber: run.prNumber ?? 0,
    checkSummary: { passed, failed, pending, total, ...(skipped !== undefined ? { skipped } : {}) },
    recommendation: latest?.detail ?? (out.result ? `Result: ${out.result}` : ''),
    passedNames: out.passedNames,
    failedNames: out.failedNames,
    pendingNames: out.pendingNames,
    pollCount: Number(out.pollCount ?? 0),
    pollIntervalMs: typeof out.pollIntervalMs === 'number' ? out.pollIntervalMs : undefined,
    lastCheckedAt: typeof out.lastCheckedAt === 'string' ? out.lastCheckedAt : undefined,
    phase: out.phase,
    fixInProgress: out.fixInProgress,
    fixTrigger: out.fixTrigger,
    fixProgress: out.fixProgress,
    activeTaskFile: out.activeTaskFile,
    nextPollAt: out.nextPollAt,
    lastSignalAt: out.lastSignalAt,
    dedupReason: out.dedupReason,
    lastFixCommitSha: out.lastFixCommitSha,
    timeoutWindowStartedAt: out.timeoutWindowStartedAt,
    lastProgressAt: out.lastProgressAt,
    lastProgressReason: out.lastProgressReason,
  };
}

export function currentRunCiStatus(
  run: Run,
  liveStatus: CiCheckUpdatedPayload | null,
): CiCheckUpdatedPayload | null {
  const persisted = persistedCiStatusFromRun(run);
  if (!liveStatus) return persisted;
  if (!persisted) return liveStatus;
  return {
    ...persisted,
    ...liveStatus,
    phase: persisted.phase ?? liveStatus.phase,
    fixInProgress: persisted.fixInProgress ?? liveStatus.fixInProgress,
    fixTrigger: persisted.fixTrigger !== undefined ? persisted.fixTrigger : liveStatus.fixTrigger,
    fixProgress: persisted.fixProgress ?? liveStatus.fixProgress,
    activeTaskFile:
      persisted.activeTaskFile !== undefined ? persisted.activeTaskFile : liveStatus.activeTaskFile,
    nextPollAt: persisted.nextPollAt !== undefined ? persisted.nextPollAt : liveStatus.nextPollAt,
    lastSignalAt:
      persisted.lastSignalAt !== undefined ? persisted.lastSignalAt : liveStatus.lastSignalAt,
    dedupReason:
      persisted.dedupReason !== undefined ? persisted.dedupReason : liveStatus.dedupReason,
    lastFixCommitSha:
      persisted.lastFixCommitSha !== undefined
        ? persisted.lastFixCommitSha
        : liveStatus.lastFixCommitSha,
  };
}

/**
 * `run.list` leaves large decision payload values out and names them in
 * `payloadTrimmed`; the run page needs those (review markdown, PR package,
 * input snapshot) and gets them from its direct `run.get` copy.
 */
export function runHasTrimmedDecisions(run: Pick<Run, 'decisions'>): boolean {
  return (run.decisions ?? []).some((decision) => (decision.payloadTrimmed?.length ?? 0) > 0);
}

/**
 * The shared (list) run drives status and steps; each trimmed decision takes
 * its payload from the direct copy of the same decision when one is present.
 */
export function mergeTrimmedDecisions(shared: Run, direct: Run | null): Run {
  if (!direct || direct.id !== shared.id || !runHasTrimmedDecisions(shared)) return shared;
  const directById = new Map(direct.decisions.map((decision) => [decision.id, decision]));
  return {
    ...shared,
    decisions: shared.decisions.map((decision) => {
      if (!decision.payloadTrimmed?.length) return decision;
      const full = directById.get(decision.id);
      if (!full?.payload) return decision;
      const { payloadTrimmed: _trimmed, ...rest } = decision;
      return { ...rest, payload: full.payload };
    }),
  };
}

/** How long the run page waits before retrying a failed direct fetch of a trimmed row. */
export const TRIMMED_RUN_FETCH_RETRY_MS = 5_000;

/**
 * Whether the run page should fetch the full run behind a trimmed list row:
 * no direct copy yet, or the row moved past the copy. A failed fetch is
 * retried after TRIMMED_RUN_FETCH_RETRY_MS instead of pausing the page for
 * good; an in-flight fetch is never doubled.
 */
export function shouldFetchTrimmedRun(params: {
  sharedRun: Pick<Run, 'decisions' | 'updatedAt'> | null;
  directRun: Pick<Run, 'updatedAt'> | null;
  refreshing: boolean;
  failedAt: number | null;
  now: number;
}): boolean {
  if (!params.sharedRun || params.refreshing) return false;
  if (!runHasTrimmedDecisions(params.sharedRun)) return false;
  if (params.failedAt !== null && params.now - params.failedAt < TRIMMED_RUN_FETCH_RETRY_MS) {
    return false;
  }
  return !params.directRun || params.directRun.updatedAt < params.sharedRun.updatedAt;
}

/** A failed bulk run list does not invalidate a direct snapshot from this connection. */
export function runBootstrapBlocksActions(
  bootstrapFailed: boolean,
  runId: string,
  verified: { runId: string; connectionEpoch: number } | null,
  connectionEpoch: number,
): boolean {
  return (
    bootstrapFailed && (verified?.runId !== runId || verified.connectionEpoch !== connectionEpoch)
  );
}
