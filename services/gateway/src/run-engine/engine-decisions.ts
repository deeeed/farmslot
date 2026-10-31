// engine-decisions.ts — Engine-level decisions, auto-resolution, and collision redirects
import { randomUUID } from 'node:crypto';

import {
  type AgentContext,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  Events,
  type EvidenceManifestEntry,
  isPrerequisiteGatePayload,
  isTerminalRunStatus,
  PipelineSteps,
  type PRReviewOptions,
  prReviewWorkflow,
  type RepeatReviewContext,
  type ReviewChainEntry,
  reviewChainForRun,
  reviewResultForRun,
  type Run,
  type RunCreateParams,
  type RunDecision,
  type RunDecisionPayload,
  type RunGateReadiness,
  type RunReviewResult,
  type RunStatus,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { isGitHubAncestor } from '../external/github.js';
import { runReviewRoundBudget } from '../review/review-round-budget.js';
import { assertEvidenceAttestationReceipt } from '../run-completion/evidence-attestation.js';
import {
  readRunProgress,
  runDecisionWaitingStatus,
  type RunProgressObservation,
} from '../runners/run-progress.js';
import { getRun, getRunWithArchived, listRuns, updateRun, updateRunStep } from '../runs/store.js';
import { samePrincipalOwner } from '../security/work-originator.js';

import { pendingDecisionForRun } from './decision-projection.js';
import {
  canReplayCollisionDecision,
  findLatestResolvedDecision,
  isReplayableResolvedHumanGateDecision,
  latestResolvedHumanGateDecision,
} from './decision-replay.js';
import { hasValidPrNumber, supersedeStaleHumanGateDecisions } from './gate-policy.js';
import {
  assertAcceptedFindingsCurrent,
  collectRunGateReadiness,
  projectRunGateActions,
} from './gate-prerequisites.js';
import { assertPrimaryReviewContext } from './review-plan.js';
import { runSupersededSince } from './run-generation.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};
let stepToStatus: Record<string, RunStatus> = {};

export function setEngineDecisionRuntime(runtime: {
  broadcast: BroadcastFn;
  stepToStatus: Record<string, RunStatus>;
}): void {
  broadcastFn = runtime.broadcast;
  stepToStatus = runtime.stepToStatus;
}

/**
 * Thrown by the WRITE_TASK collision → comparison-lane redirect path. Signals to
 * the outer step catch that the current run is intentionally cancelled (forked
 * into a successor run), not failed. The catch checks `instanceof` and skips
 * the failure-marking branch so the run shows as `cancelled` with a
 * `redirectedToRunId` link instead of a misleading `error`.
 */
export class RedirectedError extends Error {
  readonly successorRunId: string;
  constructor(successorRunId: string, message: string) {
    super(message);
    this.name = 'RedirectedError';
    this.successorRunId = successorRunId;
  }
}

// ─── Decision creation + wait (for engine-level decisions like collision) ───

const engineDecisionResolvers = new Map<string, (actionId: string) => void>();

/** Recovery can retain a live gate continuation instead of starting another driver. */
export function hasEngineDecisionWaiter(decisionId: string): boolean {
  return engineDecisionResolvers.has(decisionId);
}

/**
 * Records a stored decision's resolution and persists it. Callers record it before waking the
 * decision's waiter, so a resolved card never stays pending in the run.
 */
export function recordDecisionResolution(
  runId: string,
  decisionId: string,
  actionId: string,
): void {
  const decision = getRun(runId)?.decisions.find((entry) => entry.id === decisionId);
  if (!decision) return;
  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = actionId;
  updateRun(runId, { decisions: getRun(runId)!.decisions });
}

export function resolveEngineDecision(decisionId: string, actionId: string): boolean {
  const resolver = engineDecisionResolvers.get(decisionId);
  if (resolver) {
    resolver(actionId);
    engineDecisionResolvers.delete(decisionId);
    return true;
  }
  return false;
}

export function collisionAutoResolveAction(run: Run): 'create-new' | null {
  // Comparison-lane runs already file as siblings — collision means reuse the task
  // dir basename with a timestamp suffix, not fork again into comparison.
  if (run.lane === 'comparison') return 'create-new';
  if (run.mode === 'validation' || run.mode === 'autonomous') return 'create-new';
  return null;
}

/** Collision card actions; omit start-comparison when the run is already comparison-lane. */
export function collisionDecisionActions(current: Pick<Run, 'lane'>): DecisionAction[] {
  const actions: DecisionAction[] = [
    {
      id: 'create-new',
      label: 'Create new (append timestamp)',
      style: 'primary',
      description:
        'Creates a fresh task dir with a timestamp suffix and dispatches as a new production-lane root run. Use when the prior dirs are stale/abandoned and you just want to retry from scratch — does not link to existing runs.',
    },
  ];
  if (current.lane !== 'comparison') {
    actions.push({
      id: 'start-comparison',
      label: 'Start comparison lane',
      style: 'secondary',
      description:
        'Files this run as a comparison-lane sibling of the existing family (same ticket, same family ID, new variant tag). Use when you want to A/B compare runner/model/template changes against a prior run for the same bug.',
    });
  }
  actions.push({
    id: 'abort',
    label: 'Abort run',
    style: 'danger',
    description:
      'Cancels the current dispatch without touching existing task dirs. Use when the collision was unexpected and you need to investigate the prior runs before re-dispatching.',
  });
  return actions;
}

interface CanonicalReviewIdentity {
  project: string;
  repository: string;
  prNumber: number;
}

interface CurrentReviewSubject extends CanonicalReviewIdentity {
  headSha: string;
  baseRef?: string;
}

function canonicalReviewIdentity(
  run: Pick<Run, 'project' | 'ticketOrPr' | 'flowType'>,
): CanonicalReviewIdentity | null {
  if (run.flowType !== 'review-pr') return null;
  const match = run.ticketOrPr.trim().match(/^([^#]+)#(\d+)$/);
  if (!match) return null;
  return {
    project: run.project,
    repository: match[1].toLowerCase(),
    prNumber: Number(match[2]),
  };
}

function terminalReviewTimestamp(run: Run): string {
  return run.completedAt ?? run.updatedAt ?? run.createdAt;
}

export function findLatestPriorReviewRun(
  current: Pick<Run, 'id' | 'project' | 'ticketOrPr' | 'flowType' | 'prWork' | 'reviewContext'>,
  allRuns: readonly Run[],
): Run | null {
  const identity = canonicalReviewIdentity(current);
  const requestedLineages =
    current.reviewContext?.reviewLineages ??
    current.prWork?.review?.options.reviewContext?.reviewLineages;
  const lineageIds = [
    ...new Set(requestedLineages?.flatMap((lineage) => (lineage ? [lineage.reviewId] : [])) ?? []),
  ];
  if (lineageIds.length > 1) return null;
  if (!identity) return null;
  return (
    allRuns
      .filter((candidate) => {
        // A review blocked at posting (stale head) still finished its review;
        // it is the round to resume from, not something to ignore.
        if (
          candidate.id === current.id ||
          !(isTerminalRunStatus(candidate.status) || candidate.status === 'blocked') ||
          !reviewResultForRun(candidate)
        )
          return false;
        // An intake-owned round only chains onto intake rounds of the same
        // owner and profile; a manual review (no prWork) of the same PR is a
        // valid predecessor for either.
        const requested = current.prWork?.review;
        if (
          requested &&
          candidate.prWork?.kind === 'review' &&
          (!candidate.prWork.review ||
            !samePrincipalOwner(candidate.prWork.review, requested) ||
            candidate.prWork.review.profile !== requested.profile)
        )
          return false;
        if (
          lineageIds.length &&
          !candidate.agentContexts?.some(
            (context) => context.role === 'review' && context.reviewId === lineageIds[0],
          )
        )
          return false;
        const candidateIdentity = canonicalReviewIdentity(candidate);
        return (
          candidateIdentity?.project === identity.project &&
          candidateIdentity.repository === identity.repository &&
          candidateIdentity.prNumber === identity.prNumber
        );
      })
      .sort((left, right) => {
        const completionOrder = terminalReviewTimestamp(right).localeCompare(
          terminalReviewTimestamp(left),
        );
        if (completionOrder !== 0) return completionOrder;
        const creationOrder = right.createdAt.localeCompare(left.createdAt);
        return creationOrder !== 0 ? creationOrder : right.id.localeCompare(left.id);
      })[0] ?? null
  );
}

function uniqueArtifactRefs(refs: readonly EvidenceManifestEntry[]): EvidenceManifestEntry[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!ref.path || seen.has(ref.path)) return false;
    seen.add(ref.path);
    return true;
  });
}

function farmslotOriginForReview(
  prior: Run,
  allRuns: readonly Run[],
): { runId?: string; refs: EvidenceManifestEntry[] } {
  const candidates = allRuns
    .filter(
      (candidate) =>
        candidate.familyId === prior.familyId &&
        candidate.flowType !== 'review-pr' &&
        candidate.id !== prior.id,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const candidate of candidates) {
    const refs = candidate.decisions.flatMap((decision) => {
      const payload = decision.payload as
        | { artifactManifest?: EvidenceManifestEntry[] }
        | undefined;
      return payload?.artifactManifest ?? [];
    });
    const evidence = uniqueArtifactRefs(
      refs.filter((ref) => /recipe|evidence|screenshot|recording|video/i.test(ref.purpose)),
    );
    if (evidence.length > 0) return { runId: candidate.id, refs: evidence };
  }
  return { refs: [] };
}

function priorReviewChain(
  prior: Run,
  subject: CurrentReviewSubject,
  payload: RunReviewResult | null,
  artifactRefs: EvidenceManifestEntry[],
): ReviewChainEntry[] {
  const existing = reviewChainForRun(prior);
  if (existing.length > 0) return existing;
  return [
    {
      chainId: prior.id,
      generation: 1,
      runId: prior.id,
      familyId: prior.familyId,
      repository: subject.repository,
      prNumber: subject.prNumber,
      ...(payload?.reviewSnapshot?.baseSha ? { baseSha: payload.reviewSnapshot.baseSha } : {}),
      ...(payload?.reviewSnapshot?.headSha ? { headSha: payload.reviewSnapshot.headSha } : {}),
      mode: resolveReviewMode({ run: prior }),
      validationDepth: prior.reviewValidationDepth ?? 'static-code',
      verdict: payload?.recommendation?.trim() || 'pending',
      unresolvedCount: payload ? payload.lineComments.length : null,
      artifactRefs,
      runner: prior.metrics.runner ?? null,
      model: prior.metrics.actualModel ?? prior.metrics.model ?? null,
      createdAt: prior.createdAt,
      ...(prior.completedAt ? { completedAt: prior.completedAt } : {}),
    },
  ];
}

export function buildRepeatReviewContext(
  current: Pick<Run, 'id' | 'project' | 'ticketOrPr' | 'flowType' | 'prWork' | 'reviewContext'>,
  prior: Run,
  subject: CurrentReviewSubject,
  allRuns: readonly Run[],
): RepeatReviewContext {
  const payload = reviewResultForRun(prior);
  const priorHead = payload?.reviewSnapshot?.headSha?.trim() || undefined;
  const artifactRefs = uniqueArtifactRefs([
    ...(payload?.artifactManifest ?? []),
    ...(payload?.reviewInputArtifactPaths ?? []).map((artifactPath) => ({
      path: artifactPath,
      purpose: 'review-input',
    })),
  ]);
  const origin = farmslotOriginForReview(prior, allRuns);
  const priorGeneration = prior.repeatReviewContext?.generation ?? 1;
  const priorReviewers = (prior.agentContexts ?? []).filter(
    (context) => context.role === 'review' && context.status === 'complete' && context.reviewId,
  );
  const requestedLineages =
    current.reviewContext?.reviewLineages ??
    current.prWork?.review?.options.reviewContext?.reviewLineages;
  const requestedIds = [
    ...new Set(requestedLineages?.flatMap((lineage) => (lineage ? [lineage.reviewId] : [])) ?? []),
  ];
  const priorReviewId =
    requestedIds.length === 1
      ? requestedIds[0]
      : priorReviewers.length === 1
        ? priorReviewers[0].reviewId
        : undefined;
  return {
    version: 1,
    chainId: prior.repeatReviewContext?.chainId ?? prior.id,
    generation: priorGeneration + 1,
    priorRunId: prior.id,
    priorFamilyId: prior.familyId,
    repository: subject.repository,
    prNumber: subject.prNumber,
    ...(priorHead ? { priorReviewedHeadSha: priorHead } : {}),
    currentHeadSha: subject.headSha,
    ...(subject.baseRef ? { baseRef: subject.baseRef } : {}),
    verdict: payload?.recommendation?.trim() || 'unknown',
    unresolvedFindings: (payload?.lineComments ?? []).map((comment) => ({
      file: comment.path,
      line: comment.line,
      description: comment.body,
    })),
    artifactRefs,
    farmslotEvidenceRefs: origin.refs,
    ...(origin.runId ? { originatingRunId: origin.runId } : {}),
    mode: priorHead ? 'warm' : 'cold',
    validationDepth: 'static-code',
    ...(!priorHead
      ? { warmUnavailableReason: 'Prior review did not record a reviewed head SHA.' }
      : {}),
    session: {
      mode: priorHead ? 'warm' : 'cold',
      continuity: 'resume-unconfirmed',
      priorRunId: prior.id,
      reviewId: priorReviewId,
    },
    priorGenerations: priorReviewChain(prior, subject, payload, artifactRefs),
  };
}

/** Incremental scope needs a recorded prior head that is still part of the current history. */
export function incrementalReviewAvailable(
  context: Pick<RepeatReviewContext, 'priorReviewedHeadSha' | 'warmUnavailableReason'>,
): boolean {
  return Boolean(context.priorReviewedHeadSha) && !context.warmUnavailableReason;
}

/**
 * After a rebase or force-push, `prior..current` contains every base-branch change,
 * not the PR's delta. Fall back to a full review that still rechecks prior findings.
 */
export async function confirmIncrementalAncestry(
  context: RepeatReviewContext,
  isAncestor: typeof isGitHubAncestor = isGitHubAncestor,
): Promise<RepeatReviewContext> {
  const priorHead = context.priorReviewedHeadSha;
  if (!priorHead || !incrementalReviewAvailable(context)) return context;
  let reason: string | undefined;
  try {
    const ancestor = await isAncestor(context.repository, priorHead, context.currentHeadSha);
    if (!ancestor)
      reason = `Prior reviewed head ${priorHead.slice(0, 12)} is not an ancestor of ${context.currentHeadSha.slice(0, 12)} (rebase or force-push).`;
  } catch (error) {
    // A full review is always a valid scope; an unproven delta is not. A vanished
    // force-pushed commit must not block the re-review, so record why and continue.
    reason = `Could not confirm prior reviewed head ${priorHead.slice(0, 12)} is an ancestor: ${(error as Error).message}`;
  }
  if (!reason) return context;
  return {
    ...context,
    warmUnavailableReason: reason,
  };
}

export function repeatReviewDecisionActions(context: RepeatReviewContext): DecisionAction[] {
  return [
    ...(incrementalReviewAvailable(context)
      ? [
          {
            id: 'warm',
            label: 'WARM review',
            style: 'primary' as const,
            description:
              'Reuse the verified reviewer session and review the changes since its last reviewed head.',
          },
        ]
      : []),
    {
      id: 'cold',
      label: 'COLD review',
      style: 'secondary',
      description: 'Create a fresh reviewer session and review the complete captured PR diff.',
    },
  ];
}

export function applyRepeatReviewSelection(
  context: RepeatReviewContext,
  actionId: string,
): RepeatReviewContext {
  if (actionId !== 'warm' && actionId !== 'cold')
    throw new Error(`Unknown review mode: ${actionId}`);
  if (actionId === 'warm' && !incrementalReviewAvailable(context))
    throw new Error(
      `WARM review unavailable: ${context.warmUnavailableReason ?? 'missing prior reviewed head'}`,
    );
  return {
    ...context,
    mode: actionId,
    validationDepth: 'static-code',
    ...(actionId === 'cold' ? { unresolvedFindings: [], artifactRefs: [] } : {}),
  };
}

export async function handleRepeatReviewDecision(
  runId: string,
  current: Run,
  subject: Omit<CurrentReviewSubject, 'project'>,
): Promise<RepeatReviewContext | null> {
  if (current.flowType !== 'review-pr') return null;
  assertPrimaryReviewContext(current);
  const requestedMode = resolveReviewMode({ run: current });
  const requestContext = current.reviewContext ?? current.prWork?.review?.options.reviewContext;
  if (
    requestedMode === 'warm' &&
    !requestContext?.reviewLineages.some((lineage) => lineage?.reviewId)
  )
    throw new Error('WARM review unavailable: explicit reviewId lineage context is required');
  if (
    current.repeatReviewContext?.currentHeadSha === subject.headSha &&
    current.repeatReviewContext.repository === subject.repository.toLowerCase() &&
    current.repeatReviewContext.prNumber === subject.prNumber
  ) {
    return current.repeatReviewContext;
  }
  const allRuns = listRuns({}).runs;
  const prior = findLatestPriorReviewRun(current, allRuns);
  if (!prior) {
    if (requestedMode === 'warm')
      throw new Error('WARM review unavailable: no previous review session for this repository/PR');
    updateRun(runId, {
      reviewMode: requestedMode,
      reviewValidationDepth: current.reviewValidationDepth ?? 'static-code',
    });
    return null;
  }
  const generation = getRun(runId)?.engineState?.generation ?? 0;
  const context = await confirmIncrementalAncestry(
    buildRepeatReviewContext(
      current,
      prior,
      { ...subject, project: current.project, repository: subject.repository.toLowerCase() },
      allRuns,
    ),
  );
  // A cancel, pause or replay during the GitHub lookup owns the run now; opening
  // a decision would revive it as blocked. The engine keeps the operator state.
  if (runSupersededSince(getRun(runId), generation))
    throw new Error(`Run ${runId.slice(0, 8)} changed during the review ancestry lookup`);
  const options = current.prWork?.review?.options ?? { mode: requestedMode };
  const selected = automatedRepeatReviewSelection(context, { ...options, mode: requestedMode });
  updateRun(runId, {
    repeatReviewContext: selected,
    reviewMode: selected.mode,
    reviewValidationDepth: selected.validationDepth,
  });
  return selected;
}

/** Apply the already-authorized intake policy through the existing review chain. */
export function automatedRepeatReviewSelection(
  context: RepeatReviewContext,
  options: PRReviewOptions,
): RepeatReviewContext {
  if (options.mode === 'warm' && !incrementalReviewAvailable(context))
    throw new Error(
      `WARM review unavailable: ${context.warmUnavailableReason ?? 'missing prior reviewed head'}`,
    );
  return {
    ...context,
    mode: options.mode,
    validationDepth: prReviewWorkflow(options) === 'qa' ? 'full-live' : 'static-code',
    ...(options.mode === 'cold' ? { unresolvedFindings: [], artifactRefs: [] } : {}),
  };
}

export function autoResolveEngineDecision(
  run: Run,
  reason: string,
  actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }>,
): string | null {
  const ids = new Set(actions.map((a) => a.id));
  if (reason === 'collision' && ids.has('create-new')) {
    return collisionAutoResolveAction(run);
  }
  if (run.mode !== 'validation' && run.mode !== 'autonomous') return null;
  if (reason === 'review_posting') return null;
  if (reason === 'human_gate') {
    return null;
  }
  if (reason === 'review_complete') {
    if (ids.has('skip')) return 'skip';
    if (ids.has('send_feedback')) return 'send_feedback';
  }
  // Auto-resolve recipe strategy in autonomous mode (checked by caller setting mode on Run)
  if (reason === 'recipe_strategy' && ids.has('accept')) return 'accept';
  return null;
}

export function buildCollisionSuccessorParams(
  current: Run,
  familyId: string,
  variant: string,
): RunCreateParams {
  return {
    project: current.project,
    flowType: current.flowType,
    ticketOrPr: current.ticketOrPr,
    ticketData: current.ticketData,
    mode: current.mode,
    familyId,
    lane: 'comparison',
    variant,
    runner: current.metrics?.runner ?? undefined,
    model: current.metrics?.model ?? undefined,
    effort: current.effort,
    safetyTier: current.safetyTier,
    app: current.app,
    prNumber: hasValidPrNumber(current) ? current.prNumber : undefined,
    parentRunId: current.id,
    backlogItemId: current.backlogItemId,
    workGraphId: current.workGraphId,
    workNodeId: current.workNodeId,
    allowedSlots:
      current.allowedSlots && current.allowedSlots.length > 0
        ? [...current.allowedSlots]
        : undefined,
  };
}

/** A worker context that ever launched; a native restart keeps only its session history. */
function contextLaunched(context: AgentContext): boolean {
  return Boolean(
    context.startedAt ||
    context.runnerSessionId ||
    context.runnerSessionArchive ||
    context.nativeSession ||
    context.nativeSessionHistory?.length,
  );
}

/**
 * A run that failed or was cancelled before any worker launched. Replay resets the dispatch
 * step's timing, so the records a dispatch leaves on the run also count as having reached it.
 */
function endedBeforeDispatch(run: Run): boolean {
  if (run.status !== 'failed' && run.status !== 'cancelled') return false;
  const dispatch = run.steps.find((step) => step.name === PipelineSteps.DISPATCH);
  if (!dispatch || dispatch.startedAt) return false;
  if (dispatch.status !== 'pending' && dispatch.status !== 'skipped') return false;
  return !(
    run.engineState?.taskExecution ||
    run.engineState?.workspaceReviewDispatchGeneration !== undefined ||
    run.worktreeHeadAtDispatch ||
    run.metrics?.runnerSessionId ||
    run.agentContexts?.some(contextLaunched)
  );
}

/**
 * Every colliding dir was written by an earlier attempt of this project that ended before
 * dispatch, so none holds work and a new dir needs no operator choice. An unstamped dir,
 * an owner that is still live or one that reached dispatch keeps the decision.
 */
async function collisionOnlyFromAttemptsBeforeDispatch(
  runId: string,
  current: Run,
  existingDirs: string[],
): Promise<boolean> {
  try {
    // Lazy import keeps the task writer out of this module's load cycle.
    const { readTaskDirOwners } = await import('../tasks/writer.js');
    const owners = await readTaskDirOwners(current, existingDirs);
    for (const owner of owners) {
      if (!owner || owner === current.id) return false;
      const prior = await getRunWithArchived(owner);
      if (!prior || prior.project !== current.project || !endedBeforeDispatch(prior)) return false;
    }
    return owners.length > 0;
  } catch (err) {
    // Unproven ownership keeps today's behaviour: the operator chooses.
    console.warn(
      `[run-engine] collision owner check failed for run ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Shared collision-decision handler. Emits engine_collision with a list of prior runs
 * that own the colliding task dirs, and processes the operator's chosen action:
 *
 *   - 'abort': throws (run fails with "Aborted: task dir collision").
 *   - 'start-comparison': cancels current run, forks a comparison-lane sibling into
 *      the prior family, throws RedirectedError. The UI's prior-runs panel offers
 *      per-row deep-links for operators who want to retry on a specific prior run.
 *   - 'create-new': returns 'create-new' so the caller can retry the task write
 *      with `skipCollisionCheck: true`.
 *
 * Called from both the pre-FIND_SLOT precheck (to avoid LLM cost when collision is
 * already certain) and the WRITE_TASK error path (defense-in-depth + race window).
 * createEngineDecision replays a resolved decision only when canReplayCollisionDecision
 * says the set of colliding dirs is unchanged; a new dir between precheck and WRITE_TASK
 * forces a fresh prompt so the operator sees the updated state.
 *
 * Dirs left only by attempts that ended before dispatch need no choice: this returns
 * 'create-new' without a decision. Ownership is proven again at each call, never replayed.
 */
export async function handleCollisionDecision(
  runId: string,
  current: Run,
  existingDirs: string[],
  ticketSlug: string,
): Promise<'create-new'> {
  if (await collisionOnlyFromAttemptsBeforeDispatch(runId, current, existingDirs)) {
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)}: ${existingDirs.join(', ')} came only from attempts that ended before dispatch; creating a new task dir`,
    );
    return 'create-new';
  }

  // Project-scoped lookup — two different projects can legitimately produce
  // task dir basenames with the same prefix (same slug schema, different repos).
  // Without the project filter a same-named dir in another project becomes the
  // owning run, and start-comparison would fork into the wrong family.
  const { runs: allRuns } = listRuns({});
  const candidates = allRuns
    .filter(
      (r) =>
        r.project === current.project &&
        r.taskFile != null &&
        existingDirs.some((dir) => r.taskFile!.includes(`/${dir}/`)),
    )
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // First match per dir wins (already newest-first by sort) so dirOwners stays
  // deterministic and the UI's chip link is stable across renders. Early-exit
  // once every dir has an owner to avoid walking the long tail of candidates.
  const dirOwners: Record<string, string> = {};
  for (const r of candidates) {
    for (const dir of existingDirs) {
      if (dirOwners[dir]) continue;
      if (r.taskFile!.includes(`/${dir}/`)) dirOwners[dir] = r.id;
    }
    if (Object.keys(dirOwners).length === existingDirs.length) break;
  }
  // `candidates` is already sourced from `allRuns.filter(...)` (each id appears
  // at most once) and sorted newest-first; no dedup pass required.
  const priorRuns = candidates;
  const priorRunIds = priorRuns.map((r) => r.id);

  // Bulk actions only — to retry on a specific prior run the operator clicks the
  // per-row deep link in the UI panel. A bulk "continue-existing" button would be
  // ambiguous when multiple prior runs collide; the panel makes the choice explicit.
  const actions = collisionDecisionActions(current);

  const actionId = await createEngineDecision(
    runId,
    'collision',
    `Task dir collision for ${ticketSlug}: ${existingDirs.join(', ')}`,
    actions,
    { kind: 'collision', ticketSlug, existingDirs, priorRunIds, dirOwners },
    { canReplay: (prior) => canReplayCollisionDecision(prior, existingDirs) },
  );

  if (actionId === 'abort') throw new Error('Aborted: task dir collision');

  if (actionId === 'start-comparison') {
    const owningRun = priorRuns[0];
    const familyId = owningRun?.familyId ?? current.familyId;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const variant = current.variant
      ? `${current.variant}-collision-${hhmmss}`
      : `collision-${hhmmss}`;
    const priorStatus = getRun(runId)?.status ?? current.status;
    // Cancel first so assertDuplicateRunAllowed does not see an active production run.
    updateRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    // Lazy import breaks the run-engine ↔ methods/run circular dep.
    const { runCreate } = await import('../methods/run.js');
    // Omit branch so applyComparisonBranchPolicy derives one for the collision-suffixed
    // variant. Carrying current.branch breaks when the variant gains a -collision- suffix.
    let successor;
    try {
      successor = await runCreate(
        buildCollisionSuccessorParams(current, familyId, variant),
        broadcastFn,
      );
    } catch (err) {
      updateRun(runId, { status: priorStatus, completedAt: undefined });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      throw err;
    }
    updateRun(runId, { redirectedToRunId: successor.run.id });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    throw new RedirectedError(
      successor.run.id,
      `Redirected to comparison lane (successor: ${successor.run.id})`,
    );
  }

  return 'create-new';
}

function adoptedHumanGateAction(reason: string, run: Run): Promise<string> | null {
  if (reason !== 'human_gate' || !run.engineState?.publishGate?.humanPublicationAdoption)
    return null;
  return import('../run-completion/human-publication.js').then(
    async ({ assertAdoptedPublicationContinuation }) => {
      await assertAdoptedPublicationContinuation(run);
      return 'superseded-by-publication-adoption';
    },
  );
}

export async function createEngineDecision(
  runId: string,
  reason: string,
  description: string,
  actions: DecisionAction[],
  payload?: RunDecisionPayload,
  options?: {
    /** Optional payload-aware dedup predicate. When provided, an existing resolved
     * decision of this reason is only replayed if `canReplay(existing)` is true.
     * Used by callers whose payload contents materially change the operator's
     * choice (e.g. engine_collision must re-prompt if a new colliding dir appeared
     * between precheck and WRITE_TASK). Without this hook, dedup keys on
     * reason+resolvedAt only and silently replays the prior action against new data. */
    canReplay?: (existing: RunDecision) => boolean;
    readProgress?: (run: Run) => Promise<RunProgressObservation>;
  },
): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');
  const adopted = adoptedHumanGateAction(reason, run);
  if (adopted) return adopted;

  const generation = run.engineState?.generation ?? 0;
  if (runSupersededSince(run, generation) || isTerminalRunStatus(run.status))
    throw new Error(`Run ${runId.slice(0, 8)} no longer owns this decision`);

  // All ready/review decisions, including workspace reviews, share this guard.
  // Replay also revalidates current inputs instead of inheriting an old ready label.
  const gateDefinitions = actions;
  if (payload?.kind === 'ready') {
    payload = { ...payload, reviewRoundBudget: await runReviewRoundBudget(run) };
  }
  let readiness: RunGateReadiness | undefined;
  if (isPrerequisiteGatePayload(payload)) {
    const assessment = await collectRunGateReadiness(
      run,
      payload.kind === 'ready' ? (payload.prPackage ?? null) : null,
    );
    const projection = projectRunGateActions(actions, assessment);
    readiness = projection.readiness;
    actions = projection.actions;
    payload = { ...payload, gateReadiness: readiness };
    if (runSupersededSince(getRun(runId), generation))
      throw new Error(`Run ${runId.slice(0, 8)} changed during gate evaluation`);
  }

  // Dedup: if a resolved decision matching `engine_${reason}` exists, return its
  // action instead of re-prompting. findLatestResolvedDecision walks newest-first
  // so a new decision appended after a canReplay-rejected prior one drives replay
  // semantics. Callers that need payload-aware dedup pass `canReplay`.
  const existing =
    reason === 'human_gate'
      ? latestResolvedHumanGateDecision(run.decisions)
      : findLatestResolvedDecision(run.decisions, reason);
  if (existing) {
    const replayableHumanGateDecision =
      reason === 'human_gate' && isReplayableResolvedHumanGateDecision(existing, actions);
    const replayAllowed = options?.canReplay ? options.canReplay(existing) : true;
    const resolvedAction = existing.resolvedAction;
    const actionStillOffered =
      !!resolvedAction && actions.some((action) => action.id === resolvedAction);
    if (
      replayAllowed &&
      actionStillOffered &&
      (reason !== 'human_gate' || replayableHumanGateDecision)
    ) {
      if (resolvedAction === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION) {
        if (payload?.kind !== 'ready' || !payload.prPackage)
          throw new Error('Attested approval replay requires its publication package.');
      }
      if (payload?.kind === 'ready' && payload.prPackage)
        assertEvidenceAttestationReceipt(run, existing, payload.prPackage);
      assertAcceptedFindingsCurrent(existing, readiness);
      return resolvedAction!;
    }
  }

  const progress = await (options?.readProgress ?? readRunProgress)(run);
  const current = getRun(runId);
  if (runSupersededSince(current, generation) || isTerminalRunStatus(current!.status))
    throw new Error(`Run ${runId.slice(0, 8)} changed during the progress observation`);
  // No await separates an absent receipt from appending this decision.
  const adoptedAfterRead = adoptedHumanGateAction(reason, current!);
  if (adoptedAfterRead) return adoptedAfterRead;

  const decision: RunDecision = {
    id: randomUUID(),
    type: `engine_${reason}`,
    title: `${run.ticketOrPr || `Run ${runId.slice(0, 8)}`} — ${reason.replace(/_/g, ' ')}`,
    description,
    actions,
    createdAt: new Date().toISOString(),
    ...(payload ? { payload } : {}),
    ...(isPrerequisiteGatePayload(payload) ? { context: { gateActions: gateDefinitions } } : {}),
  };

  // Exactly one live gate decision: a gate that opens a new one supersedes any predecessor
  // still open, e.g. one a second driver of the same gate left behind. Same tick as the append.
  if (decision.type === 'engine_human_gate' || decision.type === 'engine_review_posting')
    supersedeStaleHumanGateDecisions(current!.decisions, decision.createdAt, decision.id);
  updateRun(runId, {
    status: runDecisionWaitingStatus(
      current!,
      progress,
      reason,
      isPrerequisiteGatePayload(payload) ? payload.gateReadiness : undefined,
    ),
    decisions: [...current!.decisions, decision],
  });
  if (current!.steps.some((step) => step.name === 'human-gate' && step.status === 'running'))
    updateRunStep(runId, 'human-gate', { detail: 'Waiting for operator decision' });
  broadcastFn(Events.RUN_DECISION_NEW, {
    runId,
    decision: pendingDecisionForRun(getRun(runId)!, decision),
    slotId: run.slotId,
  });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  const autoAction = autoResolveEngineDecision(run, reason, actions);
  if (autoAction) {
    console.warn(
      `[run-engine] validation mode auto-resolved ${reason} for run ${runId.slice(0, 8)} -> ${autoAction}`,
    );
  }
  const actionId =
    autoAction ??
    (await new Promise<string>((resolve) => {
      engineDecisionResolvers.set(decision.id, resolve);
    }));

  const resolvedRun = getRun(runId);
  if (runSupersededSince(resolvedRun, generation) || isTerminalRunStatus(resolvedRun!.status))
    return 'abort';
  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = actionId;
  // Restore the pre-blocked status based on current step
  const currentStep = resolvedRun!.steps.find((s) => s.status === 'running');
  const restoredStatus = currentStep ? (stepToStatus[currentStep.name] ?? 'created') : 'created';
  updateRun(runId, { status: restoredStatus, decisions: resolvedRun!.decisions });
  broadcastFn(Events.RUN_DECISION_RESOLVED, { runId, decisionId: decision.id, actionId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  return actionId;
}
