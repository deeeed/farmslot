import {
  deriveReviewedRecipeClaims,
  recordedClaimSources,
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AgentContext,
  contextIdFor,
  digestRecipeDocument,
  type EvidenceMomentRef,
  isRecipeRepairScope,
  isRecord,
  normalizeRecipeClaimId,
  PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
  type PipelineVisualReviewResult,
  primaryRoleForFlow,
  type ProjectVisualClaimReviewPolicy,
  type ReadyGatePrPackage,
  RECIPE_CLAIM_KINDS,
  RECIPE_REPAIR_SCOPE_TASK_PATH,
  type RecipeClaimDeclaration,
  type RecipeClaimProofMode,
  recipeRepairId,
  type RecipeRepairScope,
  recipeRepairScopeDigest,
  type RecipeRepairSource,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type ReviewIssue,
  reviewRetryCount,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  validateRecipeClaimDeclarations,
  validateRecipeRepairScope,
  type VisualRepairRecord,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import { runReviewRoundBudget } from '../review/review-round-budget.js';
import { nativeReviewerResultSchema } from '../runners/native/review-owner.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import {
  appliedVisualJudgmentReceiptIds,
  readVisualReviewPolicy,
  selectedSourceInputs,
  visualReviewAuthority,
} from './claim-reviews.js';
import { certifyingPublicationReviews } from './gate-policy.js';
import {
  readGateRecordedEvidenceSources,
  type RecordedEvidenceSource,
} from './recorded-evidence-sources.js';

/** A qualified Issue: the effective receipt for a selected claim is a rejection. */
export interface VisualRepairIssue {
  claimId: string;
  proofMode: RecipeClaimProofMode;
  receiptId: string;
  reason: string;
  reviewer?: string;
  recipeRunId: string;
  closureIdentity: string;
  reviewedFiles: { path: string; digest: string }[];
  moments: EvidenceMomentRef[];
}

export interface VisualRepairPlan {
  scope: RecipeRepairScope;
  review: ReviewStatus;
  issues: VisualRepairIssue[];
}

export interface VisualRepairAdmission extends VisualRepairPlan {
  /** An earlier identical request whose single reservation this retry reuses. */
  reuse?: VisualRepairRecord;
}

function refuse(
  message: string,
  userAction = 'Refresh the gate and check the evidence again.',
): never {
  throw new GatewayMethodError('VISUAL_REPAIR_REFUSED', message, { userAction });
}

/** The repair still owed delivery or completion; at most one is active per run. */
export function activeVisualRepair(run: Run): VisualRepairRecord | undefined {
  const last = run.engineState?.publishGate?.visualRepairs?.at(-1);
  return last && last.status !== 'completed' ? last : undefined;
}

/** Issues come from gateway receipts qualified against each claim's selected source. */
export function qualifiedVisualIssues(
  run: Run,
  input: RecordedEvidencePackageInput,
  policy?: ProjectVisualClaimReviewPolicy,
  capturedIds?: readonly string[],
): VisualRepairIssue[] {
  const reviewed = deriveReviewedRecipeClaims(
    input,
    visualReviewAuthority(run, input, capturedIds, policy),
  );
  const raw = selectedRecipeClaims(input);
  return selectedSourceInputs(input).flatMap((source) => {
    const judgments = recordedVisualJudgments(
      source.input,
      visualReviewAuthority(run, source.input, capturedIds, policy),
    );
    return [...source.claimIds].flatMap((claimId): VisualRepairIssue[] => {
      const effective = judgments
        .filter((judgment) => normalizeRecipeClaimId(judgment.claimId) === claimId)
        .at(-1);
      const receipt = run.visualJudgmentReceipts?.find(({ id }) => id === effective?.receiptId);
      const claim = raw.find(({ id }) => id === claimId);
      if (
        !effective ||
        !receipt ||
        !claim ||
        effective.verdict !== 'rejected' ||
        !effective.reason?.trim() ||
        reviewed.find(({ id }) => id === claimId)?.verdict !== 'failed'
      )
        return [];
      return [
        {
          claimId,
          proofMode: claim.proofMode,
          receiptId: effective.receiptId,
          reason: effective.reason.trim(),
          reviewer: effective.reviewer.displayName,
          recipeRunId: source.input.claims!.recipeRunId,
          closureIdentity: recordedEvidenceClosureIdentity(source.input),
          reviewedFiles: receipt.reviewedFiles ?? [],
          moments: effective.moments,
        },
      ];
    });
  });
}

/** The newest live review loop owns the worker-fix budget this repair spends. */
export function visualRepairReviewLoop(run: Run): ReviewStatus | undefined {
  return [...(run.engineState?.publishGate?.reviews ?? [])]
    .reverse()
    .find((review) => !review.stale && typeof review.maxRetries === 'number');
}

function registeredClaims(input: RecordedEvidencePackageInput): RecipeClaimDeclaration[] {
  const claims = isRecord(input.invocation) ? input.invocation.claims : undefined;
  if (!Array.isArray(claims) || validateRecipeClaimDeclarations(claims).status !== 'valid')
    refuse('The package has no valid task registration.');
  return claims.filter(isRecord).map((claim) => ({
    id: String(claim.id),
    claim: String(claim.claim),
    ...(RECIPE_CLAIM_KINDS.some((kind) => kind === claim.kind)
      ? { kind: RECIPE_CLAIM_KINDS.find((kind) => kind === claim.kind) }
      : {}),
    ...(typeof claim.parentId === 'string' ? { parentId: claim.parentId } : {}),
    ...(claim.proofMode === 'state' || claim.proofMode === 'visual' || claim.proofMode === 'mixed'
      ? { proofMode: claim.proofMode }
      : {}),
  }));
}

/** Derive the frozen scope from the gate package and its captured receipts, never the client. */
export async function planVisualRepair(run: Run, decision: RunDecision): Promise<VisualRepairPlan> {
  const pkg: ReadyGatePrPackage | undefined =
    decision.type === 'engine_human_gate' && decision.payload?.kind === 'ready'
      ? decision.payload.prPackage
      : undefined;
  if (!pkg) refuse('Send back needs a pending publication gate package.');
  const baseSha = pkg.reviewSnapshot?.baseSha;
  if (!pkg.headSha || !baseSha) refuse('The gate package has no immutable review range.');
  const sources = await readGateRecordedEvidenceSources(run, pkg);
  if (sources.length !== 1) refuse('Send back needs exactly one selected recorded execution.');
  const { input, artifactPrefix } = sources[0]!;
  if (!input.claims || validateRecordedEvidencePackage(input).status !== 'valid')
    refuse('The selected recorded evidence failed integrity validation.');
  const policy = await readVisualReviewPolicy(run);
  const captured = [...(pkg.visualJudgmentReceiptIds ?? [])].sort();
  if (
    digestRecipeDocument(appliedVisualJudgmentReceiptIds(run, [input], policy)) !==
    digestRecipeDocument(captured)
  )
    refuse('Visual review changed after this package was prepared.');
  const issues = qualifiedVisualIssues(run, input, policy, captured);
  if (!issues.length) refuse('There is no qualified Issue to send back.');
  const claims = registeredClaims(input);
  if (claims.some((claim) => claim.parentId !== undefined))
    refuse(
      'Send back cannot re-prove nested criteria.',
      'Re-run the full task recipe for nested criteria.',
    );
  const priorScope =
    input.repair && isRecipeRepairScope(input.repair.scope) ? input.repair.scope : undefined;
  const claimSources = recordedClaimSources(input);
  const repairSources = new Map<string, RecipeRepairSource>();
  for (const source of claimSources) {
    const recipeRunId = source.input.claims!.recipeRunId;
    if (repairSources.has(recipeRunId)) continue;
    // A retained original keeps the revision it was recorded at, across repeated repairs.
    const headSha = source.artifactRoot
      ? priorScope?.sources.find((entry) => entry.recipeRunId === recipeRunId)?.headSha
      : pkg.headSha;
    if (!headSha) refuse('A retained source has no recorded revision.');
    repairSources.set(recipeRunId, {
      recipeRunId,
      closureIdentity: recordedEvidenceClosureIdentity(source.input),
      artifactRoot: `${artifactPrefix}${source.artifactRoot ?? ''}`.replace(/\/+$/u, ''),
      headSha,
    });
  }
  const review = visualRepairReviewLoop(run);
  if (!review) refuse('No retained review loop owns a worker-fix budget.');
  const workerContextId = contextIdFor(primaryRoleForFlow(run.flowType));
  if (!run.agentContexts?.some(({ id }) => id === workerContextId))
    refuse('The run has no retained worker to send the Issues to.');
  const repairId = recipeRepairId({
    runId: run.id,
    packageHash: pkg.packageHash,
    receiptIds: issues.map(({ receiptId }) => receiptId),
  });
  const rejected = new Set(issues.map(({ claimId }) => claimId));
  const scope: RecipeRepairScope = {
    schemaVersion: 1,
    repairId,
    runId: run.id,
    generation: run.engineState?.generation ?? 0,
    decisionId: decision.id,
    packageHash: pkg.packageHash,
    packageHeadSha: pkg.headSha,
    reviewBaseSha: baseSha,
    reviewId: review.id,
    workerContextId,
    repairRecipe: `recipes/${repairId}.json`,
    claims,
    sources: [...repairSources.values()],
    retained: claimSources
      .filter(({ claimId }) => !rejected.has(claimId))
      .map(({ claimId, input: source }) => ({ claimId, recipeRunId: source.claims!.recipeRunId })),
    rejected: issues.map(({ reviewer: _reviewer, ...issue }) => issue),
  };
  const validation = validateRecipeRepairScope(scope);
  if (validation.status !== 'valid')
    refuse(
      `The repair scope is invalid: ${validation.findings.map(({ message }) => message).join(' ')}`,
    );
  return { scope, review, issues };
}

/** Every refusal happens before the decision is consumed or any budget is charged. */
export async function admitVisualRepair(
  run: Run,
  decision: RunDecision,
): Promise<VisualRepairAdmission> {
  const plan = await planVisualRepair(run, decision);
  const repairs = run.engineState?.publishGate?.visualRepairs ?? [];
  const reuse = repairs.find(({ repairId }) => repairId === plan.scope.repairId);
  const active = activeVisualRepair(run);
  if (active && active.repairId !== plan.scope.repairId)
    refuse('Another Send back is still in progress.', 'Wait for the agent repair to finish.');
  if (reuse?.status === 'completed') refuse('These Issues were already sent back.');
  if (
    run.agentContexts?.some(
      ({ role, status }) =>
        ['review', 'review-fix'].includes(role) &&
        ['launching', 'working', 'waiting'].includes(status),
    )
  )
    refuse('A worker fix or review is still running.', 'Wait for it to finish.');
  if (!reuse && reviewRetryCount(plan.review) >= (plan.review.maxRetries ?? 0))
    refuse(
      'The review loop has no worker-fix round left.',
      'Request another review or close the gate.',
    );
  if ((await runReviewRoundBudget(run)).remaining === 0)
    refuse('No review round remains to verify the repair.', 'Close or restart the work.');
  if (!run.slotId) refuse('Send back needs the run slot.', 'Restore the run slot first.');
  const vars = await loadSlotVars(run.slotId);
  if (
    !plan.review.runner ||
    !nativeReviewerResultSchema(vars, plan.review.runner, PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA)
  )
    refuse(
      'The required reviewer cannot classify retained proof.',
      'Request a review with a native reviewer that supports repair results.',
    );
  return { ...plan, ...(reuse ? { reuse } : {}) };
}

/** One persisted increment of the named loop's retryCount is the repair's only charge. */
export function reserveVisualRepair(
  run: Run,
  admission: VisualRepairAdmission,
  now = new Date().toISOString(),
): NonNullable<Run['engineState']> {
  const engineState = run.engineState ?? {};
  const publishGate = engineState.publishGate ?? {};
  if (admission.reuse) return engineState;
  const reviews = publishGate.reviews ?? [];
  const review = reviews.find(({ id }) => id === admission.scope.reviewId);
  if (!review) refuse('The retained review loop changed before Send back.');
  const reservedRetryCount = reviewRetryCount(review) + 1;
  const record: VisualRepairRecord = {
    repairId: admission.scope.repairId,
    scope: admission.scope,
    scopeDigest: recipeRepairScopeDigest(admission.scope),
    decisionId: admission.scope.decisionId,
    packageHash: admission.scope.packageHash,
    reviewId: review.id,
    status: 'reserved',
    reservedRetryCount,
    reservedAt: now,
    rejected: admission.issues.map(({ claimId, receiptId, reason, reviewer }) => ({
      claimId,
      receiptId,
      reason,
      ...(reviewer ? { reviewer } : {}),
    })),
  };
  return {
    ...engineState,
    publishGate: {
      ...publishGate,
      reviews: reviews.map((entry) =>
        entry.id === review.id ? { ...entry, retryCount: reservedRetryCount } : entry,
      ),
      visualRepairs: [...(publishGate.visualRepairs ?? []), record],
    },
  };
}

export function updateVisualRepair(
  runId: string,
  repairId: string,
  patch: Partial<Pick<VisualRepairRecord, 'status' | 'deliveredAt' | 'completedAt' | 'reason'>>,
): Run {
  const current = getRun(runId);
  if (!current) throw new Error(`Run not found: ${runId}`);
  return updateRun(runId, {
    engineState: {
      ...current.engineState,
      publishGate: {
        ...current.engineState?.publishGate,
        visualRepairs: (current.engineState?.publishGate?.visualRepairs ?? []).map((record) =>
          record.repairId === repairId ? { ...record, ...patch } : record,
        ),
      },
    },
  });
}

/** Offer Send back only when admission can succeed; resolve repeats the authoritative check. */
export async function visualRepairOffered(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null | undefined,
): Promise<boolean> {
  if (!preparedPackage || activeVisualRepair(run)) return false;
  const review = visualRepairReviewLoop(run);
  if (!review || reviewRetryCount(review) >= (review.maxRetries ?? 0)) return false;
  let sources: RecordedEvidenceSource[];
  try {
    sources = await readGateRecordedEvidenceSources(run, preparedPackage);
  } catch (error) {
    // The evidence prerequisite already reports an unreadable package; it simply has no Issue to send.
    console.warn(
      `[visual-repair] run ${run.id.slice(0, 8)} — no Send back offer: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (sources.length !== 1 || validateRecordedEvidencePackage(sources[0]!.input).status !== 'valid')
    return false;
  return (
    qualifiedVisualIssues(
      run,
      sources[0]!.input,
      await readVisualReviewPolicy(run),
      preparedPackage.visualJudgmentReceiptIds ?? [],
    ).length > 0
  );
}

/** Rendered through the existing REVIEW-FIX task; no second sender or template. */
export function visualRepairIssues(scope: RecipeRepairScope): ReviewIssue[] {
  const roots = new Map(scope.sources.map((source) => [source.recipeRunId, source.artifactRoot]));
  return [
    {
      file: RECIPE_REPAIR_SCOPE_TASK_PATH,
      description:
        `Send back to agent: re-prove only ${scope.rejected.map(({ claimId }) => claimId).join(', ')}. ` +
        `Fix the cause, then write a complete standalone repair recipe at ${scope.repairRecipe} ` +
        'with normal composition, explicit prerequisites, its own workflow.entry and normal teardown. ' +
        'Leave the main task recipe unchanged. Do not skip nodes or stop early. ' +
        `Run it with \`farmslot recipe run ${scope.repairRecipe}\` until it passes; ` +
        'the engine keeps the unchanged criteria from the original evidence.',
    },
    ...scope.rejected.map((rejection) => ({
      file: rejection.reviewedFiles[0]
        ? `${roots.get(rejection.recipeRunId)}/${rejection.reviewedFiles[0].path}`
        : `${roots.get(rejection.recipeRunId)}/acceptance-status.json`,
      description:
        `${rejection.claimId} Issue (${rejection.proofMode} proof required): ${rejection.reason}` +
        (rejection.moments.length
          ? ` Rejected moments: ${rejection.moments.map(({ traceIndex }) => `trace ${traceIndex}`).join(', ')}.`
          : ''),
    })),
  ];
}

function contextReviewId(run: Run, contextId: string): string | undefined {
  return run.agentContexts?.find(({ id }) => id === contextId)?.reviewId ?? undefined;
}

/** A repair package needs its authorised scope and unanimous current-head applicability. */
export function visualRepairEvidenceReasons(
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
  preparedPackage: ReadyGatePrPackage | null,
): RunGatePrerequisiteReason[] {
  const reasons: RunGatePrerequisiteReason[] = [];
  for (const input of inputs) {
    if (!input.repair || !isRecipeRepairScope(input.repair.scope)) continue;
    const scope = input.repair.scope;
    const record = run.engineState?.publishGate?.visualRepairs?.find(
      ({ repairId, scopeDigest }) =>
        repairId === scope.repairId && scopeDigest === recipeRepairScopeDigest(scope),
    );
    if (!record) {
      reasons.push({
        code: 'evidence-repair-unbound',
        prerequisite: 'evidence',
        message: 'This repair evidence is not bound to an authorised Send back.',
        actionId: 'hold',
      });
      continue;
    }
    if (!preparedPackage) continue;
    if (preparedPackage.reviewSnapshot?.baseSha !== scope.reviewBaseSha) {
      reasons.push({
        code: 'evidence-repair-scope-changed',
        prerequisite: 'evidence',
        message: 'The review base changed after Send back. Retained proof needs a new scope.',
        actionId: 'hold',
      });
      continue;
    }
    const retained = recordedClaimSources(input).filter(({ artifactRoot }) => artifactRoot);
    if (!retained.length) continue;
    const reviewers = certifyingPublicationReviews(run, preparedPackage);
    const rows = (record.applicability ?? []).filter(
      ({ headSha }) => headSha === preparedPackage.headSha,
    );
    const missing = retained
      .filter(({ claimId, input: source }) => {
        const matching = rows.filter(
          (row) =>
            row.claimId === claimId &&
            row.recipeRunId === source.claims!.recipeRunId &&
            row.closureIdentity === recordedEvidenceClosureIdentity(source),
        );
        return (
          !reviewers.length ||
          matching.some(({ unaffected }) => !unaffected) ||
          !reviewers.every((review) =>
            matching.some(
              (row) => row.unaffected && contextReviewId(run, row.reviewContextId) === review.id,
            ),
          )
        );
      })
      .map(({ claimId }) => claimId);
    if (missing.length)
      reasons.push({
        code: 'evidence-repair-applicability-missing',
        prerequisite: 'evidence',
        message: `${missing.join(', ')} kept older proof without every required reviewer confirming it is unaffected. Re-prove ${missing.length === 1 ? 'it' : 'them'}.`,
        reference: missing[0],
        actionId: 'hold',
      });
  }
  return reasons;
}

/** Package preparation retains a qualified reviewer's retained-claim classification on its repair. */
export async function recordVisualRepairApplicability(
  run: Run,
  context: AgentContext,
  verified: PipelineVisualReviewResult,
  sources: readonly RecordedEvidenceSource[],
  headSha: string,
): Promise<void> {
  if (!('retained' in verified.result)) return;
  const result = verified.result;
  const record = run.engineState?.publishGate?.visualRepairs?.find(
    ({ scopeDigest }) => scopeDigest === result.scopeDigest,
  );
  const input = sources.find(
    ({ input: candidate }) =>
      candidate.repair &&
      isRecipeRepairScope(candidate.repair.scope) &&
      recipeRepairScopeDigest(candidate.repair.scope) === result.scopeDigest,
  )?.input;
  if (!record || !input || validateRecordedEvidencePackage(input, { headSha }).status !== 'valid')
    return;
  const retained = recordedClaimSources(input).filter(({ artifactRoot }) => artifactRoot);
  const rows = result.retained.filter((row) =>
    retained.some(
      ({ claimId, input: source }) =>
        claimId === row.claimId &&
        source.claims!.recipeRunId === row.recipeRunId &&
        recordedEvidenceClosureIdentity(source) === row.closureIdentity,
    ),
  );
  if (!rows.length) return;
  const current = getRun(run.id);
  const latest = current?.agentContexts?.find(({ id }) => id === context.id);
  if (
    !current ||
    current.readOnly ||
    latest?.status !== 'complete' ||
    digestRecipeDocument(latest.pipelineVisualReviewResult) !== digestRecipeDocument(verified)
  )
    throw new Error('The qualified repair review changed before its classification was retained');
  const repairs = current.engineState?.publishGate?.visualRepairs ?? [];
  updateRun(run.id, {
    engineState: {
      ...current.engineState,
      publishGate: {
        ...current.engineState?.publishGate,
        visualRepairs: repairs.map((entry) =>
          entry.repairId === record.repairId
            ? {
                ...entry,
                applicability: [
                  ...(entry.applicability ?? []).filter(
                    (row) => row.reviewContextId !== context.id || row.headSha !== headSha,
                  ),
                  ...rows.map((row) => ({
                    ...row,
                    headSha,
                    reviewContextId: context.id,
                    binding: verified.binding,
                    recordedAt: verified.completedAt,
                  })),
                ],
              }
            : entry,
        ),
      },
    },
  });
  await persistRunNow(getRun(run.id)!, 'repair applicability retained');
}
