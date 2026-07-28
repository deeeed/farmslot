// methods/run.ts — run CRUD, lifecycle, grading, cleanup
import {
  DEFAULT_DEV_INTERACTIVE_PROFILE,
  type DevInteractiveActionRecord,
  type DevInteractiveProfile,
  Events,
  type ExecutionTemplateReference,
  FLOW_STEPS,
  isInteractiveDevRun,
  isTerminalRunStatus,
  parseGitHubRef,
  PR_BOUND_FLOW_TYPES,
  primaryRoleForFlow,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type Run,
  type RunCreateParams,
  type RunCreateResult,
  type RunInteractiveDevResolveParams,
  type RunInteractiveDevResolveResult,
  type RunProbeWorkerSignalParams,
  type RunProbeWorkerSignalResult,
  type RunRehydratePrNumberParams,
  type RunRehydratePrNumberResult,
  type RunResolveDecisionParams,
  type RunResolveDecisionResult,
  type SafetyTier,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { isValidManualBacklogRunHandoff } from '../backlog/store.js';
import { resolveCIDecision } from '../ci-monitor/service.js';
import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { buildFollowUpLineage, isFollowUpFlow } from '../family-observability/context.js';
import { findFollowUpParentRun } from '../family-observability/state.js';
import { loadFleetStatus, loadProjectConfig } from '../fleet/state.js';
import { assertStartRefSkipPrepareEligible } from '../projects/start-ref-policy.js';
import {
  assertReadyGatePackageInputsCurrent,
  isArtifactOnlyRun,
  isPublishedStatus,
  publicationStatusForRun,
  requiresPublicationApproval,
} from '../run-completion/orchestrator.js';
import {
  readReadyGatePreparedPackage,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';
import { buildCIWatchChainedRunParams } from '../run-engine/ci-watch-chain.js';
import { resolveEngineDecision } from '../run-engine/engine-decisions.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  assertEvidenceRefreshOverrideAvailable,
  assertPublicationReviewPolicySatisfied,
  isPublishApprovalAction,
  validatePackageApprovalSelection,
} from '../run-engine/gate-policy.js';
import {
  applyChainedRunEngineFlags,
  bumpRunGeneration,
  cancelRunEngine,
  setRunFlags,
  startRun,
} from '../run-engine/orchestrator.js';
import { publicationReviewPolicyForRun } from '../run-engine/publication-policy.js';
import {
  probeWorkerSignalForRun,
  readFreshTerminalSignalForRun,
  resolveMonitorDecision,
} from '../run-engine/run-monitor.js';
import {
  assertSupportedRunnerSpelling,
  normalizeRunner,
  runnerSupportsModel,
} from '../runners/registry.js';
import { assertScriptedRunnerConfig } from '../runners/scripted-config.js';
import {
  createRun,
  getAllRuns,
  getRun,
  listRuns,
  normalizeRunClassification,
  persistRunNow,
  updateRun,
  updateRunStep,
} from '../runs/store.js';
import { resolveConfiguredExecutionTemplateForSlot } from '../tasks/execution-template-catalog.js';
import { resolveWorkerTemplateSelectionForRun } from '../tasks/worker-template-options.js';

import { resolveDispatchTargetBranch } from './dispatch/target-branch.js';
import {
  assertTicketRefMatchesProjectRepo,
  normalizeTicketRef,
  resolvePrRef,
  validateTicketRef,
} from './dispatch/ticket-ref.js';
import { applyComparisonBranchPolicy } from './run/comparison-branch-policy.js';
import { runCancel } from './run/lifecycle-control.js';
import { triggerImprovementAnalysis } from './run/propose-improvement.js';
import { runReplayStep } from './run/replay-step.js';
import {
  buildLocalDevRef,
  isInternalArtifactOnlyEvalTicket,
  isManualBacklogRef,
  isValidTicketForFlow,
} from './run/ticket-policy.js';
import { normalizeRunCreateMode } from './run-create-mode.js';

type Emit = (event: string, payload: unknown) => void;

export function assertDuplicateRunAllowed(
  params: Pick<
    RunCreateParams,
    | 'ticketOrPr'
    | 'project'
    | 'flowType'
    | 'lane'
    | 'variant'
    | 'familyId'
    | 'parentRunId'
    | 'completionPolicy'
    | 'startRef'
    | 'startRefSource'
  >,
  existing: Run[],
): void {
  const sameTicket = existing.filter(
    (r) => r.ticketOrPr === params.ticketOrPr && r.project === params.project,
  );
  if (sameTicket.length === 0) return;
  if (params.lane !== 'comparison') {
    const duplicate = sameTicket[0];
    throw new Error(
      `Active run already exists for ${params.ticketOrPr}: ${duplicate.id.slice(0, 8)} (status=${duplicate.status}). Cancel it first.`,
    );
  }
  if (!params.familyId) {
    throw new Error('Comparison lane duplicates require an explicit familyId.');
  }
  const conflicting = sameTicket.find((r) => {
    if (r.lane === 'comparison') {
      return r.familyId !== params.familyId || (r.variant ?? null) === (params.variant ?? null);
    }
    if (
      r.lane === 'production' &&
      (r.id === params.familyId ||
        r.id === params.parentRunId ||
        (r.familyId === params.familyId && r.id === r.familyId))
    ) {
      return false;
    }
    return true;
  });
  if (conflicting) {
    throw new Error(
      `Comparison duplicate blocked for ${params.ticketOrPr}: conflicting active run ${conflicting.id.slice(0, 8)} ` +
        `(lane=${conflicting.lane}, family=${conflicting.familyId.slice(0, 8)}, variant=${conflicting.variant ?? 'none'}).`,
    );
  }
}

/**
 * Resolve the run's safety tier from dispatch params and project policy.
 * Runner-level fallback is applied later in createRun once the runner is known.
 * Pure helper — exported for unit testing.
 */
export function resolveCreateSafetyTier(
  paramsTier: SafetyTier | undefined,
  projectDefault: SafetyTier | undefined,
): SafetyTier | undefined {
  return paramsTier ?? projectDefault;
}

function interactiveDevProfileFor(
  params: Pick<RunCreateParams, 'flowType' | 'mode' | 'devInteractiveProfile'>,
): DevInteractiveProfile | undefined {
  if (params.flowType !== 'dev' || params.mode !== 'interactive') return undefined;
  return params.devInteractiveProfile ?? DEFAULT_DEV_INTERACTIVE_PROFILE;
}

function buildInteractiveDevTicketData(
  initialContext: string,
  existing?: RunCreateParams['ticketData'],
): NonNullable<RunCreateParams['ticketData']> {
  return {
    title: existing?.title?.trim() || initialContext.trim(),
    description: existing?.description?.trim() || initialContext.trim(),
    acceptanceCriteria: existing?.acceptanceCriteria ?? [],
    affectedArea: existing?.affectedArea ?? '',
    stepsToReproduce: existing?.stepsToReproduce ?? [],
    screenshots: existing?.screenshots ?? [],
    labels: existing?.labels ?? [],
    comments: existing?.comments ?? [],
    linkedTickets: existing?.linkedTickets ?? [],
    source: existing?.source ?? 'manual',
  };
}

interface RunCreateInternalOptions {
  expectedExecutionTemplate?: ExecutionTemplateReference;
  /**
   * Called synchronously immediately before durable store createRun.
   * Used by the dispatch queue claim protocol to re-validate exclusive
   * ownership after runCreate's own awaits (config/ticket/template work).
   */
  beforeCreate?: () => void;
  /**
   * When true, await the run JSON write before returning so queue handoff can
   * drop the row only after create is on disk (crash-safe claim protocol).
   */
  awaitPersist?: boolean;
  /**
   * Called synchronously immediately after in-memory createRun, before any
   * awaitPersist. Queue dispatch stamps runId on the claim row here so concurrent
   * cancel/replay cannot treat the row as reclaimable mid-persist.
   */
  afterCreateSync?: (run: import('@farmslot/protocol').Run) => void;
  /**
   * Optional async barrier after afterCreateSync and before persistRunNow when
   * awaitPersist is set. Queue handoff uses this to await a durable queue stamp
   * so a crash mid-run-persist still leaves a stamped row for restart reconcile.
   */
  durableStamp?: (run: import('@farmslot/protocol').Run) => void | Promise<void>;
}

export function assertExpectedExecutionTemplate(
  current: ExecutionTemplateReference | undefined,
  expected: ExecutionTemplateReference | undefined,
): void {
  if (!expected) return;
  if (
    !current ||
    current.id !== expected.id ||
    current.sourceId !== expected.sourceId ||
    current.sha256 !== expected.sha256
  ) {
    const actual = current
      ? `${current.id} from ${current.sourceId} at ${current.sha256}`
      : 'no configured execution template';
    throw new Error(
      `Execution template changed while queued: expected ${expected.id} from ${expected.sourceId} at ${expected.sha256}, got ${actual}. Queue the dispatch again.`,
    );
  }
}

export async function runCreate(
  params: RunCreateParams,
  emit: Emit,
  options: RunCreateInternalOptions = {},
): Promise<RunCreateResult> {
  // Gateway-internal — clients must not forge HEAD verification.
  delete params.startRefSkipPrepareVerified;

  // Normalize ticketOrPr: extract key from Jira/GitHub URLs, then validate the
  // shape fits the requested flow so we fail fast before slot allocation instead
  // of crashing deep in the write-task step with a cryptic "Invalid PR ref".
  if (!params.project) throw new Error('Missing required field: project');
  params.ticketOrPr = normalizeTicketRef(params.ticketOrPr);

  // Load project config once — used for PR-ref resolution and safety-tier default.
  const projectConfig = await loadProjectConfig(params.project);
  const initialContext = params.ticketOrPr;
  const devInteractiveProfile = interactiveDevProfileFor(params);
  if (devInteractiveProfile) params.devInteractiveProfile = devInteractiveProfile;

  // For PR flows, resolve bare numbers and branch names to owner/repo#number
  const PR_FLOWS = ['review-pr', 'pr-complete', 'update-branch'];
  if (PR_FLOWS.includes(params.flowType)) {
    if (projectConfig?.ci?.repo) {
      params.ticketOrPr = await resolvePrRef(params.ticketOrPr, projectConfig.ci.repo);
    }
  }

  // Safety-tier resolution (ADR-023 §3): explicit dispatch param > project
  // policy > runner intrinsic fallback. Applied before createRun so the run
  // persists the resolved tier and chained runs inherit it.
  params.safetyTier = resolveCreateSafetyTier(params.safetyTier, projectConfig?.defaultSafetyTier);

  await normalizeRunCreateMode(params, projectConfig);
  if (!projectConfig?.executionTemplates && params.executionTemplateId) {
    throw new Error(
      'executionTemplateId is only valid for a project with execution_templates configured.',
    );
  }
  if (projectConfig?.executionTemplates && params.taskTemplate) {
    throw new Error(
      'Configured execution-template projects require executionTemplateId, not taskTemplate.',
    );
  }
  let executionTemplateSnapshot: Run['executionTemplate'];
  if (projectConfig?.executionTemplates && params.slotId) {
    const [projectVars, slotVars] = await Promise.all([
      loadProjectVars(params.project),
      loadSlotVars(params.slotId),
    ]);
    if (!params.mode) {
      throw new Error('Configured execution-template selection requires an explicit run mode.');
    }
    executionTemplateSnapshot = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: params.flowType,
      platform: slotVars.platform,
      runMode: params.mode,
      ...(params.domain ? { explicitDomain: params.domain } : {}),
      ...(slotVars.domain ? { slotDomain: slotVars.domain } : {}),
      ...(params.executionTemplateId ? { explicitId: params.executionTemplateId } : {}),
    }).reference;
  }
  assertExpectedExecutionTemplate(executionTemplateSnapshot, options.expectedExecutionTemplate);

  const { lane, variant } = normalizeRunClassification(params);
  params.lane = lane;
  params.variant = variant ?? undefined;

  let normalizedTaskTemplate: RunCreateParams['taskTemplate'];
  const shouldResolveImplicitInteractiveTemplate =
    params.mode === 'interactive' &&
    (params.flowType === 'dev' || params.flowType === 'pr-complete');
  if (
    !projectConfig?.executionTemplates &&
    (params.taskTemplate || shouldResolveImplicitInteractiveTemplate)
  ) {
    const projectVars = await loadProjectVars(params.project);
    const selectedTemplate = await resolveWorkerTemplateSelectionForRun(
      projectVars,
      params.flowType,
      params.mode,
      params.taskTemplate,
      params.domain,
    ).catch((err) => {
      if (
        !params.taskTemplate &&
        params.flowType === 'pr-complete' &&
        params.mode === 'interactive' &&
        /Worker template not found/.test((err as Error).message)
      ) {
        return null;
      }
      throw err;
    });
    if (
      selectedTemplate &&
      (params.taskTemplate ||
        selectedTemplate.selectionSource === 'implicit-interactive-dev' ||
        selectedTemplate.selectionSource === 'implicit-interactive-pr-complete')
    ) {
      normalizedTaskTemplate = {
        fileName: selectedTemplate.fileName,
        variant: selectedTemplate.variant,
      };
    }
  }

  if (!isInternalArtifactOnlyEvalTicket(params)) {
    if (
      params.flowType === 'dev' &&
      params.mode === 'interactive' &&
      !isValidTicketForFlow(params.ticketOrPr, params.flowType)
    ) {
      params.initialContext = params.initialContext || initialContext;
      params.ticketData = buildInteractiveDevTicketData(initialContext, params.ticketData);
      params.ticketOrPr = buildLocalDevRef(initialContext);
      params.familyRootTicketOrPr = params.familyRootTicketOrPr ?? params.ticketOrPr;
    } else if (
      params.ticketData?.source === 'manual' &&
      isManualBacklogRef(params.ticketOrPr) &&
      !PR_BOUND_FLOW_TYPES.has(params.flowType) &&
      isValidManualBacklogRunHandoff(
        (params as RunCreateParams & { backlogItemId?: string }).backlogItemId,
        params.ticketOrPr,
        params.project,
      )
    ) {
      params.familyRootTicketOrPr = params.familyRootTicketOrPr ?? params.ticketOrPr;
    } else {
      validateTicketRef(params.ticketOrPr, params.flowType);
      assertTicketRefMatchesProjectRepo(params.ticketOrPr, params.project, projectConfig?.ci?.repo);
    }
  }

  assertSupportedRunnerSpelling(params.runner);
  const normalizedRunner = params.runner ? normalizeRunner(params.runner) : undefined;
  assertScriptedRunnerConfig({
    runner: normalizedRunner,
    scripted: params.scripted,
    projectName: params.project,
    projectConfig,
  });

  // Runner+model compat. Codex on a ChatGPT account rejects Anthropic model
  // names with HTTP 400; the symmetric mismatch will bite Claude eventually
  // too. Throwing here means the caller (UI dispatch wizard, CLI, replay)
  // gets a clear synchronous error instead of a worker that fails on first
  // request. We deliberately do NOT auto-rewrite the model — silent rewrites
  // mask the bug class where the picker UI sends a bad combo.
  if (params.runner && params.model && !runnerSupportsModel(params.runner, params.model)) {
    throw new Error(
      `runner '${params.runner}' does not support model '${params.model}' — ` +
        `pick a compatible model in the dispatch UI or fix the call site.`,
    );
  }
  // Auto-link follow-up flows to the prior fix-bug/dev/feature run on the same
  // PR/ticket so materializeInheritedContext can copy artifacts (notably
  // recipe.json — see family-context.ts FAMILY_ARTIFACT_SPECS). UI dispatches
  // never set parentRunId explicitly; without this lookup, every UI-dispatched
  // pr-complete starts an orphan family with HAS_RECIPE=no and the worker
  // falls back to the perps smoke fallback even when a tested recipe exists.
  // Only lineage fields are inherited — lane/variant stay as the caller set
  // them so explicit comparison-lane dispatches keep their classification.
  if (isFollowUpFlow(params.flowType) && !params.parentRunId) {
    const prMatch = params.ticketOrPr.match(/#(\d+)$/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
    const fleet = params.branch ? null : await loadFleetStatus();
    const resolvedFollowUpBranch =
      params.branch ??
      (await resolveDispatchTargetBranch(
        {
          project: params.project,
          flowType: params.flowType,
          ticketOrPr: params.ticketOrPr,
          targetBranch: params.branch,
        },
        { fleetSlots: fleet?.slots, logPrefix: 'run-create' },
      ));
    if (!params.branch && resolvedFollowUpBranch) params.branch = resolvedFollowUpBranch;
    const parent = findFollowUpParentRun(getAllRuns(), {
      ticketOrPr: params.ticketOrPr,
      prNumber,
      branch: resolvedFollowUpBranch,
      project: params.project,
    });
    if (parent) {
      Object.assign(params, buildFollowUpLineage(parent));
      console.log(
        `[run-create] auto-linked ${params.flowType} to parent ${parent.id.slice(0, 8)} (${parent.flowType}) on ${params.ticketOrPr}`,
      );
    }
  }

  applyComparisonBranchPolicy(params);

  let startRefSkipPrepareVerified = false;
  if (params.startRef?.trim() && params.skipPrepare) {
    await assertStartRefSkipPrepareEligible(params);
    startRefSkipPrepareVerified = true;
  }

  // Guard: reject if there's already an active run for the same ticket
  const { runs: existing } = listRuns({ active: true });
  assertDuplicateRunAllowed(params, existing);

  // Branch-affinity nudge guardrail: nudgeReuse only makes sense when the operator already
  // picked the busy slot in the dispatch wizard. Without slotId the engine has nothing to
  // bind and would silently fall through to fresh-slot scoring — surface the misuse loudly
  // so the wizard / CLI can fix the call site instead of producing a confusing run record.
  if (params.nudgeReuse && !params.slotId) {
    throw new Error(
      'nudgeReuse requires slotId — pick the busy branch-matched slot in the wizard before requesting a nudge',
    );
  }
  if (params.nudgeReuse && !PR_FLOWS.includes(params.flowType)) {
    throw new Error(
      `nudgeReuse only supports PR-bound flows (${PR_FLOWS.join(', ')}); got ${params.flowType}`,
    );
  }
  // Same guardrails for freshReuse — operator's authorization to claim a busy slot for
  // kill+prepare requires the explicit slot pin, just like nudge.
  if (params.freshReuse && !params.slotId) {
    throw new Error(
      'freshReuse requires slotId — pick the busy branch-matched slot in the wizard before requesting fresh dispatch',
    );
  }
  if (params.freshReuse && !PR_FLOWS.includes(params.flowType)) {
    throw new Error(
      `freshReuse only supports PR-bound flows (${PR_FLOWS.join(', ')}); got ${params.flowType}`,
    );
  }
  if (params.nudgeReuse && params.freshReuse) {
    throw new Error('nudgeReuse and freshReuse are mutually exclusive — pick one mode');
  }

  const createParams = {
    ...(normalizedTaskTemplate ? { ...params, taskTemplate: normalizedTaskTemplate } : params),
    ...(startRefSkipPrepareVerified ? { startRefSkipPrepareVerified: true as const } : {}),
  };
  // Last ownership check at the durable create boundary (after all awaits above).
  options.beforeCreate?.();
  let run = createRun(createParams);
  // Stamp runId / handoff marker before any await so concurrent reclaim sees
  // that create already succeeded (claim re-validation alone is not enough).
  options.afterCreateSync?.(run);
  if (options.awaitPersist) {
    // Durable queue stamp before run file: crash between these two still leaves
    // a stamped row that restart drops against the Run (live or terminal).
    await options.durableStamp?.(run);
    // Queue claim handoff: ensure the run file is on disk before the caller
    // drops the queue row (otherwise a crash requeues and can double-create).
    await persistRunNow(run, 'create-queue-handoff');
  }
  if (executionTemplateSnapshot) {
    run = updateRun(run.id, { executionTemplate: executionTemplateSnapshot });
    if (options.awaitPersist) {
      await persistRunNow(run, 'create-queue-handoff-template');
    }
  }
  // Set runtime flags (not persisted)
  if (params.skipPrepare) {
    setRunFlags(run.id, { skipPrepare: true });
  }
  if (params.nudgeReuse) {
    // nudgeReuse implies skipPrepare — the worker is mid-task with deps + branch already
    // loaded. Setting both flags keeps the run-engine's existing skipPrepare branch in
    // PREPARE happy and lets DISPATCH route through nudgeDispatch instead of dispatchExecute.
    setRunFlags(run.id, { nudgeReuse: true, skipPrepare: true });
  }
  if (params.freshReuse) {
    // freshReuse does NOT imply skipPrepare — the whole point is "kill the prior worker,
    // then run a normal PREPARE". FIND_SLOT honors the flag by tearing down the prior
    // worker (terminalize prior Run + kill the runner process) BEFORE PREPARE runs, so the
    // worktree is quiescent when git reset / dependency install begin.
    setRunFlags(run.id, { freshReuse: true });
  }
  emit(Events.RUN_CREATED, { run });
  if (
    process.env.NODE_TEST_CONTEXT === '1' &&
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START === '1'
  ) {
    return { run };
  }
  // Fire-and-forget: engine drives the run through its lifecycle
  startRun(run.id).catch((err) => {
    console.error(`[run-engine] run ${run.id.slice(0, 8)} failed: ${(err as Error).message}`);
  });
  return { run };
}

function appendInteractiveDevAction(
  runId: string,
  params: RunInteractiveDevResolveParams,
  fallbackRun?: Run,
): Run['engineState'] {
  const run = getRun(runId) ?? fallbackRun;
  if (!run) throw new Error(`Run not found: ${runId}`);
  const record: DevInteractiveActionRecord = {
    action: params.action,
    source: 'operator',
    timestamp: new Date().toISOString(),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.prRef ? { prRef: params.prRef } : {}),
  };
  return {
    ...run.engineState,
    interactiveDev: {
      ...run.engineState?.interactiveDev,
      profile:
        run.devInteractiveProfile ??
        run.engineState?.interactiveDev?.profile ??
        DEFAULT_DEV_INTERACTIVE_PROFILE,
      terminalActions: [...(run.engineState?.interactiveDev?.terminalActions ?? []), record],
    },
  };
}

function completeStepAsOperator(
  runId: string,
  stepName: string,
  detail: string,
  outputs: Record<string, unknown>,
): void {
  const run = getRun(runId);
  const step = run?.steps.find((s) => s.name === stepName);
  if (!step || step.status === 'done') return;
  updateRunStep(runId, stepName, {
    status: 'done',
    completedAt: new Date().toISOString(),
    detail,
    outputs,
  });
}

function skipStepAsOperator(runId: string, stepName: string, reason: string): void {
  const run = getRun(runId);
  const step = run?.steps.find((s) => s.name === stepName);
  if (!step || step.status === 'done' || step.status === 'skipped') return;
  updateRunStep(runId, stepName, {
    status: 'skipped',
    completedAt: new Date().toISOString(),
    detail: `Skipped: ${reason}`,
    outputs: { skipped: true, reason, source: 'operator' },
  });
}

async function releaseInteractiveDevSlot(run: Run): Promise<string> {
  if (!run.slotId) return 'none';
  const { slotRelease } = await import('./slot.js');
  const noopEmit = () => {};
  await slotRelease({ slotId: run.slotId, keepWork: true, expectedRunId: run.id }, noopEmit);
  return 'released-keep-work';
}

async function holdInteractiveDevSlotForCiHandoff(run: Run): Promise<string> {
  if (!run.slotId) return 'none';
  const { markSlotHeld } = await import('../core/index.js');
  await markSlotHeld(run.slotId, 'ci-watch');
  return 'held-for-ci-watch';
}

async function markInteractiveDevDoneWithoutPr(
  run: Run,
  params: RunInteractiveDevResolveParams,
  emit: Emit,
  handoff?: 'ci-watch' | 'pr-complete',
  options: { emitDone?: boolean } = {},
): Promise<RunInteractiveDevResolveResult> {
  cancelRunEngine(run.id);
  bumpRunGeneration(run.id);
  const reason = params.reason?.trim() || 'operator marked interactive dev done without PR';
  completeStepAsOperator(run.id, 'monitor', reason, { operatorAction: params.action, reason });
  if (handoff) {
    const handoffSteps =
      handoff === 'pr-complete'
        ? ['self-review', 'human-gate', 'finalize', 'ci-watch']
        : ['self-review', 'human-gate', 'finalize'];
    for (const stepName of handoffSteps) {
      completeStepAsOperator(run.id, stepName, reason, {
        operatorAction: params.action,
        reason,
        source: 'operator',
        handoff,
      });
    }
  } else {
    for (const stepName of ['self-review', 'human-gate', 'finalize', 'ci-watch']) {
      skipStepAsOperator(run.id, stepName, 'operator-completed-without-pr');
    }
  }
  const slotDisposition =
    handoff === 'ci-watch'
      ? await holdInteractiveDevSlotForCiHandoff(run)
      : await releaseInteractiveDevSlot(run);
  const current = getRun(run.id) ?? run;
  const updated = updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    error: undefined,
    metrics: { ...current.metrics, outcome: 'success' },
    agentContexts: [],
    engineState: appendInteractiveDevAction(run.id, params, current),
  });
  completeStepAsOperator(run.id, 'complete', reason, {
    operatorAction: params.action,
    prNumber: getRun(run.id)?.prNumber ?? current.prNumber ?? null,
    source: 'operator',
    slotDisposition,
    handoff: handoff ?? 'none',
  });
  const finalRun = getRun(run.id) ?? updated;
  if (options.emitDone ?? true) emit(Events.RUN_UPDATED, { run: finalRun });
  return { ok: true, run: finalRun };
}

async function resolveInteractiveDevPrRef(
  run: Run,
  prRef: string,
): Promise<{ ref: string; number: number }> {
  const ciRepo = await loadProjectCiRepo(run.project);
  if (!ciRepo) throw new Error('no ci.repo configured');
  const ref = await resolvePrRef(prRef, ciRepo);
  const parsed = parseGitHubRef(ref);
  if (!parsed || !Number.isFinite(parsed.number)) {
    throw new Error(`invalid PR ref: ${prRef}`);
  }
  return { ref, number: parsed.number };
}

async function loadProjectCiRepo(project: string): Promise<string | null> {
  const pv = await loadProjectVars(project).catch(() => null);
  return pv ? getProjectField(pv.projectJson, 'ci.repo') || null : null;
}

async function linkInteractiveDevPrAndStartCiWatch(
  run: Run,
  params: RunInteractiveDevResolveParams & { prRef: string },
  emit: Emit,
): Promise<RunInteractiveDevResolveResult> {
  const pr = await resolveInteractiveDevPrRef(run, params.prRef);
  await markInteractiveDevDoneWithoutPr(
    run,
    { ...params, reason: params.reason ?? `Linked PR ${pr.ref} and started CI watch` },
    emit,
    'ci-watch',
    { emitDone: false },
  );
  const replay = await runRehydratePrNumber({ runId: run.id, prRef: pr.ref }, emit);
  if (!replay.ok)
    return { ok: true, run: getRun(run.id)!, prNumber: pr.number, reason: replay.reason };
  return { ok: true, run: replay.run, prNumber: replay.prNumber, reason: replay.reason };
}

export async function runInteractiveDevResolve(
  params: RunInteractiveDevResolveParams,
  emit: Emit,
): Promise<RunInteractiveDevResolveResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  if (!isInteractiveDevRun(run)) {
    return { ok: false, run, reason: 'run is not an interactive dev run' };
  }
  if (isTerminalRunStatus(run.status)) {
    return { ok: false, run, reason: `run already terminal (${run.status})` };
  }

  if (params.action === 'abort') {
    updateRun(run.id, { engineState: appendInteractiveDevAction(run.id, params, run) });
    return {
      ok: true,
      ...(await runCancel(
        { runId: run.id, reason: params.reason ?? 'Interactive dev aborted by operator' },
        emit,
      )),
    };
  }

  if (params.action === 'done-no-pr') {
    return markInteractiveDevDoneWithoutPr(run, params, emit);
  }

  if (params.action === 'blocked' || params.action === 'failed') {
    cancelRunEngine(run.id);
    bumpRunGeneration(run.id);
    const isBlocked = params.action === 'blocked';
    const reason =
      params.reason?.trim() ||
      (isBlocked ? 'Interactive dev blocked by operator' : 'Interactive dev failed by operator');
    completeStepAsOperator(run.id, 'monitor', reason, { operatorAction: params.action, reason });
    const slotDisposition = isBlocked ? 'kept' : await releaseInteractiveDevSlot(run);
    const current = getRun(run.id) ?? run;
    const updated = updateRun(run.id, {
      status: isBlocked ? 'blocked' : 'failed',
      completedAt: isBlocked ? undefined : new Date().toISOString(),
      error: reason,
      metrics: { ...current.metrics, outcome: isBlocked ? 'partial' : 'failure' },
      ...(isBlocked ? {} : { agentContexts: [] }),
      engineState: appendInteractiveDevAction(run.id, params, current),
    });
    emit(Events.RUN_UPDATED, { run: updated });
    return { ok: true, run: updated, reason: slotDisposition };
  }

  if (params.action === 'run-self-review') {
    const engineState = appendInteractiveDevAction(run.id, params, run);
    const updated = updateRun(run.id, {
      devInteractiveProfile: 'reviewed',
      engineState: {
        ...engineState,
        interactiveDev: {
          ...engineState?.interactiveDev,
          profile: 'reviewed',
        },
      },
    });
    await runReplayStep({ runId: run.id, stepName: 'self-review', triggeredBy: 'operator' }, emit);
    return { ok: true, run: getRun(run.id) ?? updated };
  }

  if (params.action === 'detect-pr-and-ci-watch') {
    const ciRepo = await loadProjectCiRepo(run.project);
    if (!ciRepo) return { ok: false, run, reason: 'no ci.repo configured', needsPr: true };
    const { findPRNumber } = await import('../integrations/pr-linkage.js');
    const prNumber = await findPRNumber(run, ciRepo);
    if (!prNumber) {
      return {
        ok: false,
        run: getRun(run.id) ?? run,
        reason: 'no PR found on branch',
        needsPr: true,
      };
    }
    return linkInteractiveDevPrAndStartCiWatch(
      run,
      { ...params, action: 'link-pr-and-ci-watch', prRef: String(prNumber) },
      emit,
    );
  }

  if (params.action === 'link-pr-and-ci-watch') {
    if (!params.prRef?.trim())
      return { ok: false, run, reason: 'prRef is required', needsPr: true };
    return linkInteractiveDevPrAndStartCiWatch(run, { ...params, prRef: params.prRef }, emit);
  }

  if (params.action === 'link-pr-and-pr-complete') {
    if (!params.prRef?.trim())
      return { ok: false, run, reason: 'prRef is required', needsPr: true };
    const pr = await resolveInteractiveDevPrRef(run, params.prRef);
    const { persistRunPrNumber } = await import('../integrations/pr-linkage.js');
    await persistRunPrNumber(run.id, pr.number);
    await markInteractiveDevDoneWithoutPr(
      run,
      { ...params, reason: params.reason ?? `Linked PR ${pr.ref} and chained PR complete` },
      emit,
      'pr-complete',
    );
    const child = await runCreate(
      {
        project: run.project,
        flowType: 'pr-complete',
        ticketOrPr: pr.ref,
        mode: 'interactive',
        runner: run.metrics.runner ?? undefined,
        model: run.metrics.model ?? undefined,
        effort: run.effort,
        safetyTier: run.safetyTier,
        app: run.app,
        branch: run.branch ?? undefined,
        parentRunId: run.id,
        familyId: run.familyId,
        familyRootTicketOrPr: run.familyRootTicketOrPr ?? run.ticketOrPr,
        prNumber: pr.number,
      },
      emit,
    );
    return { ok: true, run: getRun(run.id)!, prNumber: pr.number, chainedRunId: child.run.id };
  }

  return { ok: false, run, reason: `unsupported action: ${params.action}` };
}

export async function runRehydratePrNumber(
  params: RunRehydratePrNumberParams,
  emit: Emit,
): Promise<RunRehydratePrNumberResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  if (isArtifactOnlyRun(run)) {
    return { ok: false, reason: 'artifact-only runs never link or rehydrate PR numbers' };
  }
  if (requiresPublicationApproval(run) && !isPublishedStatus(publicationStatusForRun(run))) {
    return {
      ok: false,
      reason: `publication status is ${publicationStatusForRun(run)}; human-approved publication is required before PR rehydrate`,
    };
  }
  if (run.prNumber && !params.prRef) {
    return { ok: false, reason: `already linked to PR #${run.prNumber}` };
  }
  const pv = await loadProjectVars(run.project).catch(() => null);
  const ciRepo: string | null = (pv?.projectJson as any)?.ci?.repo ?? null;
  if (!ciRepo) return { ok: false, reason: 'no ci.repo configured' };

  const { findPRNumber, persistRunPrNumber } = await import('../integrations/pr-linkage.js');
  let prNumber: number | null;
  if (params.prRef) {
    const resolved = await resolvePrRef(params.prRef, ciRepo);
    const parsed = parseGitHubRef(resolved);
    if (!parsed || !Number.isFinite(parsed.number)) {
      return { ok: false, reason: `invalid PR ref: ${params.prRef}` };
    }
    prNumber = parsed.number;
  } else {
    prNumber = await findPRNumber(run, ciRepo);
  }
  if (!prNumber) return { ok: false, reason: 'still no PR on branch' };

  // persistRunPrNumber already broadcasts RUN_UPDATED via the gateway's
  // shared broadcaster; no need to emit again from this handler.
  await persistRunPrNumber(params.runId, prNumber);

  // Replay CI_WATCH when the slot is either still ours OR free. Completion
  // calls resetSlot() which clears current_run_id even when keepWork=true, so
  // the common post-completion state is "slot free, no owner" — we must reclaim
  // it before replay. Skip replay only when another run has actually taken the
  // slot or the slot is actively busy with work.
  if (!run.slotId) {
    return {
      ok: true,
      prNumber,
      run: getRun(params.runId)!,
      reason: 'linked; no slotId to replay ci-watch',
    };
  }
  // Force-refresh: cachedFleet can lag the just-written .farm-status.json
  // when the operator clicks rescue seconds after completion. A stale
  // snapshot would report the slot as busy/owned even though resetSlot()
  // already flipped it to ready — the reclaim allowlist would then skip
  // ci-watch replay in the exact timing window this feature targets.
  const { loadFleetStatus } = await import('../fleet/state.js');
  const fleet = await loadFleetStatus(true);
  const slotStatus = fleet.slots.find((s) => s.slot === run.slotId);
  if (!slotStatus) {
    return {
      ok: true,
      prNumber,
      run: getRun(params.runId)!,
      reason: `linked; slot ${run.slotId} not found in fleet, skipping ci-watch replay`,
    };
  }
  // Reclaim allowlist: only replay ci-watch when the slot is in a state we
  // can safely take over. Replay path calls runReplayStep('ci-watch') which
  // flips lifecycle→preparing; doing that to a human-held (`manual`),
  // operator-excluded (`disabled`), actively-busy (`busy`), or
  // held-by-another-run slot would steal or revive it. Safe states:
  //   - `ready`  — completion's resetSlot left it idle and free.
  //   - `held`   — our own slot still in ci-watch/pr-watch (re-entry).
  const ownedByOther = slotStatus.currentRunId && slotStatus.currentRunId !== params.runId;
  const lifecycleReclaimable =
    slotStatus.lifecycle === 'ready' || (slotStatus.lifecycle === 'held' && !ownedByOther);
  if (!lifecycleReclaimable || ownedByOther) {
    return {
      ok: true,
      prNumber,
      run: getRun(params.runId)!,
      reason: `linked; slot ${run.slotId} not reclaimable (lifecycle=${slotStatus.lifecycle}, current_run_id=${slotStatus.currentRunId?.slice(0, 8) ?? '-'}), skipping ci-watch replay`,
    };
  }
  // Skip ci-watch replay for flows that don't include that step. review-pr's
  // FLOW_STEPS omits ci-watch entirely, so runReplayStep would throw
  // "Step not found: ci-watch" — the caller would still see ok:true but
  // monitoring never starts. Surface this as an explicit partial-success
  // reason instead.
  const { FLOW_STEPS, PipelineSteps: PS } = await import('@farmslot/protocol');
  const flowSteps = FLOW_STEPS[run.flowType] ?? [];
  if (!flowSteps.includes(PS.CI_WATCH)) {
    return {
      ok: true,
      prNumber,
      run: getRun(params.runId)!,
      reason: `linked; flow '${run.flowType}' has no ci-watch step, nothing to replay`,
    };
  }
  // Reclaim: restore full slot identity so S.CI_WATCH's markSlotHeld writes a
  // coherent record AND any chained follow-up dispatch (pr-complete,
  // update-branch) passes evaluateSlotIdentityPolicy. Completion's resetSlot
  // clears family_id/lane/variant alongside current_run_id, so replaying
  // without them would break same-family reuse checks in dispatch.ts:480-483.
  if (slotStatus.currentRunId !== params.runId) {
    const { claimSlotStatusIf } = await import('../core/index.js');
    const {
      SLOT_CLAIM_REFUSED_CODE,
      slotClaimBlockedByHandoff,
      slotClaimBlockedByRelease,
      slotClaimBlockedByLiveOwner,
    } = await import('./dispatch/slot-scoring.js');
    const reclaim = await claimSlotStatusIf(
      run.slotId,
      // Exclusivity decided INSIDE the CAS — the fleet snapshot consulted
      // above can be stale by the time this write runs.
      (slot) =>
        slotClaimBlockedByRelease(slot) === null &&
        slotClaimBlockedByHandoff(slot, params.runId) === null &&
        slotClaimBlockedByLiveOwner(slot, params.runId, getRun) === null,
      {
        current_run_id: params.runId,
        current_flow_type: run.flowType || null,
        current_ticket_or_pr: run.ticketOrPr,
        current_family_id: run.familyId ?? null,
        current_lane: run.lane ?? null,
        current_variant: run.variant ?? null,
      },
    );
    if (!reclaim.claimed) {
      throw Object.assign(
        new Error(`Slot ${run.slotId} is mid-release; ci-watch replay cannot reclaim it`),
        { code: SLOT_CLAIM_REFUSED_CODE },
      );
    }
  }
  try {
    await runReplayStep({ runId: params.runId, stepName: 'ci-watch' }, emit);
  } catch (err) {
    console.warn(
      `[run] rehydrate prNumber succeeded but ci-watch replay failed: ${(err as Error).message}`,
    );
    return {
      ok: true,
      prNumber,
      run: getRun(params.runId)!,
      reason: `linked; ci-watch replay failed: ${(err as Error).message}`,
    };
  }
  return { ok: true, prNumber, run: getRun(params.runId)! };
}

async function assertReadyPublishResolveIsFresh(
  run: Run,
  decision: Run['decisions'][number],
  params: RunResolveDecisionParams,
): Promise<void> {
  if (!isPublishApprovalAction(params.actionId)) return;
  const payload = decision.payload as ReadyGatePayload | undefined;
  const prPackage: ReadyGatePrPackage | undefined =
    payload?.kind === 'ready' ? payload.prPackage : undefined;
  if (!prPackage) return;

  const currentPackage = await readReadyGatePreparedPackage(run);
  if (!currentPackage) {
    throw new Error(
      'Package changed; refresh package and re-review before publishing (prepared package snapshot missing)',
    );
  }
  if (currentPackage.packageHash !== prPackage.packageHash) {
    throw new Error(
      `Package changed; refresh package and re-review before publishing (visible package ${prPackage.packageHash} but current package is ${currentPackage.packageHash})`,
    );
  }
  const decisionWithSelection = { ...decision, selectionData: params.selectionData };
  verifyReadyGatePackageHash(currentPackage);
  validatePackageApprovalSelection(currentPackage, decisionWithSelection);
  if (params.actionId === APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION) {
    // The override restamps stale reviews later in executeReadyGate, so the
    // policy is not yet satisfied here. Gate the resolve on the override's
    // precondition instead: staleness must be evidence-only (HEAD unchanged).
    const reviewDepth = currentPackage.reviewDepth ?? publicationReviewPolicyForRun(run);
    assertEvidenceRefreshOverrideAvailable(
      run.engineState?.publishGate?.independentReviews ?? [],
      currentPackage,
      reviewDepth,
    );
  } else {
    assertPublicationReviewPolicySatisfied(run, currentPackage);
  }
  await verifyReadyGateSelectedEvidenceFiles(
    run,
    currentPackage,
    currentPackage.selectedEvidenceKeys ?? [],
  );
  await assertReadyGatePackageInputsCurrent(run, currentPackage);
  if (!currentPackage.headSha || !run.slotId) return;

  const vars = await loadSlotVars(run.slotId);
  const liveHead = (
    await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`, {
      timeout: 15_000,
    })
  ).stdout.trim();
  if (!liveHead || liveHead !== currentPackage.headSha) {
    throw new Error(
      `Package changed; refresh package and re-review before publishing (approved HEAD ${currentPackage.headSha.slice(0, 12)} but live HEAD is ${liveHead ? liveHead.slice(0, 12) : 'unknown'})`,
    );
  }
}

export async function runProbeWorkerSignal(
  params: RunProbeWorkerSignalParams,
): Promise<RunProbeWorkerSignalResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const ctx = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  return probeWorkerSignalForRun(params.runId, run.slotId, ctx);
}

/**
 * Guards the write in runResolveDecision after its awaits: whoever resolved
 * the decision during that window wins (notably an operator abort racing the
 * re-armed handoff auto-recovery). Reads the store fresh rather than trusting
 * the caller's reference. Exported for tests.
 */
export function assertDecisionStillUnresolved(runId: string, decisionId: string): void {
  const fresh = getRun(runId)?.decisions.find((d) => d.id === decisionId);
  if (!fresh || fresh.resolvedAt) throw new Error(`Decision already resolved`);
}

export async function runResolveDecision(
  params: RunResolveDecisionParams,
  emit: Emit,
): Promise<RunResolveDecisionResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  const decision = existing.decisions.find((d) => d.id === params.decisionId);
  if (!decision) throw new Error(`Decision not found: ${params.decisionId}`);
  if (decision.resolvedAt) throw new Error(`Decision already resolved`);
  if (!decision.actions.some((action) => action.id === params.actionId)) {
    throw new Error(`Action not found for decision ${params.decisionId}: ${params.actionId}`);
  }
  if (decision.type === 'monitor_interactive_handoff' && params.actionId !== 'abort') {
    const signal = await readFreshTerminalSignalForRun(existing.id, existing.slotId);
    if (!signal) {
      throw new Error(
        'Interactive PR-complete handoff can resume only after a fresh terminal SIGNAL.json is written on the slot.',
      );
    }
  }
  await assertReadyPublishResolveIsFresh(existing, decision, params);
  // The probes above await; a concurrent resolver (operator abort vs re-armed
  // auto-recovery) may have resolved this decision during that window. Re-read
  // from the store so the first resolution wins instead of being overwritten.
  assertDecisionStillUnresolved(params.runId, params.decisionId);

  // Store selectionData on decision so engine steps can use it
  if (params.selectionData) {
    decision.selectionData = params.selectionData;
  }

  // Mark decision as resolved
  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = params.actionId;
  updateRun(params.runId, { decisions: existing.decisions });

  // Unblock whichever resolver owns this decision
  resolveMonitorDecision(params.decisionId, params.actionId);
  resolveEngineDecision(params.decisionId, params.actionId);
  resolveCIDecision(params.decisionId, params.actionId);

  // If run is still blocked after all resolvers fired (engine loop was lost on gateway restart),
  // clean up stale running steps and kick startRun to resume the pipeline.
  // Delay check to let the engine's promise resolver update status first (microtask ordering).
  setTimeout(() => {
    void (async () => {
      const afterResolve = getRun(params.runId);
      if (!afterResolve || afterResolve.status !== 'blocked') return;
      const stillUnresolved = afterResolve.decisions.filter((d) => !d.resolvedAt);
      if (stillUnresolved.length === 0) {
        console.log(
          `[run] run ${params.runId.slice(0, 8)} — all decisions resolved but still blocked, resuming engine`,
        );
        const runningStep = afterResolve.steps.find((s) => s.status === 'running');
        if (
          runningStep?.name === 'ci-watch' &&
          (params.actionId === 'dispatch-update-branch' ||
            params.actionId === 'dispatch-pr-complete') &&
          afterResolve.slotId
        ) {
          // Resolve ci.repo for the chained PR-bound flow. Do NOT swallow a
          // project-config failure: if ciRepo is missing, buildCIWatchChainedRunParams
          // falls back to the parent's MANUAL-*/PROJ-* ref, and createRun below skips
          // runCreate's validateTicketRef — the follow-up would then wedge downstream.
          // Let the load error surface via the outer .catch so the run stays blocked.
          const ciRepo = (await loadProjectVars(afterResolve.project))?.projectJson?.ci?.repo as
            | string
            | undefined;
          const chainSpec = buildCIWatchChainedRunParams(afterResolve, params.actionId, ciRepo);
          if (chainSpec) {
            // createRun bypasses runCreate's entry validation, so guard the chained
            // ref here: a PR-bound flow still carrying an inherited MANUAL-*/PROJ-*
            // ref (unresolved ciRepo) fails hard now instead of at write-task.
            validateTicketRef(chainSpec.createParams.ticketOrPr, chainSpec.flowType);
            console.log(
              `[run] run ${params.runId.slice(0, 8)} — chaining ${chainSpec.flowType} after resolved CI decision`,
            );
            const chainRun = createRun(chainSpec.createParams);
            applyChainedRunEngineFlags(chainRun.id, chainSpec.engineFlags);
            if (Object.keys(chainSpec.updateFields).length)
              updateRun(chainRun.id, chainSpec.updateFields);
            updateRunStep(params.runId, runningStep.name, {
              status: 'done',
              completedAt: new Date().toISOString(),
              outputs: {
                ...((runningStep.outputs ?? {}) as Record<string, unknown>),
                result: 'failed',
                dispatchAction: params.actionId,
                chainedRunId: chainRun.id,
              },
            });
            const done = updateRun(params.runId, {
              status: 'done',
              completedAt: new Date().toISOString(),
            });
            emit(Events.RUN_UPDATED, { run: done });
            emit(Events.RUN_UPDATED, { run: getRun(chainRun.id) ?? chainRun });
            startRun(chainRun.id).catch((err) => {
              console.error(
                `[run] chained ${chainSpec.flowType} run failed after decision resolve: ${(err as Error).message}`,
              );
            });
            return;
          }
        }
        // Stale 'running' steps must be re-executed. Substep telemetry (e.g. WRITE_TASK
        // emits fetch-pr-data/recipe-strategy progress) lives in step.outputs but does NOT
        // prove the step persisted its side-effects (e.g. run.taskFile). The previous
        // "outputs present = done" heuristic skipped re-execution and left the run with
        // taskFile=null, then DISPATCH failed with "No task file specified". Always reset
        // to pending; startRun clears partial outputs and reruns the case body.
        for (const step of afterResolve.steps.filter((s) => s.status === 'running')) {
          updateRunStep(params.runId, step.name, {
            status: 'pending',
            startedAt: undefined,
            completedAt: undefined,
            durationMs: undefined,
            inputs: undefined,
            outputs: undefined,
            detail: undefined,
          });
        }
        const hasRunningStep = afterResolve.steps.some((s) => s.status === 'running');
        if (!hasRunningStep) {
          const nextStep = FLOW_STEPS[afterResolve.flowType]?.find((stepName) => {
            const step = afterResolve.steps.find((candidate) => candidate.name === stepName);
            return !step || step.status !== 'done';
          });
          if (nextStep) {
            updateRun(params.runId, { status: 'created' });
          } else {
            const done = updateRun(params.runId, { status: 'done' });
            emit(Events.RUN_UPDATED, { run: done });
            return;
          }
        }
        startRun(params.runId).catch((err) => {
          console.error(
            `[run] resume after decision resolve failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
      }
    })().catch((err) => {
      console.error(
        `[run] resume after decision resolve failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    });
  }, 0);

  // Broadcast update so UI reflects resolved state
  const updated = getRun(params.runId) ?? existing;
  emit(Events.RUN_UPDATED, { run: updated });
  // Match the typed RunDecisionResolvedPayload contract (runId + decisionId +
  // actionId). The legacy `{id}` shape is still tolerated by the UI handler
  // via `p.id ?? p.decisionId`, but emitting the canonical shape here lets
  // run-scoped subscribers consume runId without falling back to context.
  emit(Events.RUN_DECISION_RESOLVED, {
    runId: params.runId,
    decisionId: params.decisionId,
    actionId: params.actionId,
  });

  // Trigger improvement analysis on retrospective accept (fire-and-forget)
  if (decision.type === 'retrospective' && params.actionId === 'accept') {
    void triggerImprovementAnalysis(params.runId, existing).catch((err) => {
      console.warn(
        `[run] improvement analysis kickoff failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    });
  }

  return { run: updated };
}
