import {
  type AgentContext,
  type AgentRole,
  deriveRunLifecycleView,
  isBlockedAtOpenHumanGate,
  isTerminalRunStatus,
  primaryRoleForFlow,
  resolveRunSlotId,
  type Run,
  type RunStep,
  type RunStepDisplayStatus,
  runStepDisplayStatus,
  type SlotAgentTargetParams,
} from '@farmslot/protocol';

/** An open blocked gate waits for a person; its recorded running step is not a running actor. */
export function runActivityStepStatus(run: Run, step: RunStep): RunStepDisplayStatus {
  return step.name === 'human-gate' && isBlockedAtOpenHumanGate(run)
    ? 'blocked'
    : runStepDisplayStatus(run, step);
}

/** These flows render publication review rounds separately from their engine steps. */
export function runUsesPublicationReviewNodes(run: Pick<Run, 'flowType'>): boolean {
  return run.flowType === 'fix-bug' || run.flowType === 'dev';
}

/** The current activity and the steps both clients show while it runs. */
export interface RunActivityView {
  kind: 'worker-fix' | 'review' | 'step';
  nodeId: string;
  ownerStepName: string;
  nodeLabel: string;
  label: string;
  detail: string;
  startedAt?: string;
  phase?: 'pre-gate' | 'post-gate';
  step: RunStep;
  steps: RunStep[];
}

export function runReviewActivityContext(
  run: Run,
  roles: readonly AgentRole[] = ['review', 'review-fix'],
): AgentContext | undefined {
  return (run.agentContexts ?? [])
    .filter(
      (context) =>
        roles.includes(context.role) && ['working', 'launching'].includes(context.status),
    )
    .sort((left, right) =>
      (right.attemptStartedAt ?? right.startedAt ?? '').localeCompare(
        left.attemptStartedAt ?? left.startedAt ?? '',
      ),
    )[0];
}

/** Both run views open the same current actor; the gateway resolves its exact node and pane. */
export function runTerminalView(run: Run, contextId?: string) {
  const contexts = run.agentContexts ?? [];
  if (contextId && !contexts.some((entry) => entry.id === contextId))
    return {
      label: 'Open terminal',
      disabledReason: 'This session is no longer available.',
      target: null,
      context: null,
    };
  let context =
    (contextId ? contexts.find((entry) => entry.id === contextId) : undefined) ??
    runReviewActivityContext(run, ['review', 'review-fix', 'ci-fix']) ??
    contexts.find((entry) => entry.role === primaryRoleForFlow(run.flowType)) ??
    contexts.find((entry) => entry.role === 'primary');
  const owner = context?.nativeSessionOwner;
  if (owner)
    context =
      contexts.find(
        (entry) =>
          entry.id === owner.contextId &&
          entry.nativeSession?.sessionId === owner.sessionId &&
          entry.nativeSession.leaseId === owner.leaseId,
      ) ?? context;
  const slotId = context?.slotId ?? resolveRunSlotId(run);
  const target: ReturnType<typeof runTerminalTargetParams> | null = slotId
    ? runTerminalTargetParams({
        slotId,
        runId: run.id,
        role: context?.role ?? primaryRoleForFlow(run.flowType),
        ...(context ? { contextId: context.id } : {}),
      })
    : run.reviewWorkspace && !run.reviewWorkspace.cleanedAt
      ? { slotId: '', runId: run.id }
      : null;
  const disabledReason = isTerminalRunStatus(run.status)
    ? 'This run is finished.'
    : context?.nativeSessionOwner && !context.nativeSession
      ? 'No conversation is bound to this run.'
      : !target && !context?.nativeSession
        ? 'No terminal is bound to this run.'
        : null;
  return {
    label: context?.nativeSession ? 'Open conversation' : 'Open terminal',
    disabledReason,
    target,
    context: context ?? null,
  };
}

/** A gate follows up with its latest reviewer, even while that reviewer is waiting. */
export function runReviewerView(run: Run) {
  const context = [...(run.agentContexts ?? [])]
    .filter((candidate) => candidate.role === 'review')
    .sort((left, right) =>
      (right.attemptStartedAt ?? right.startedAt ?? '').localeCompare(
        left.attemptStartedAt ?? left.startedAt ?? '',
      ),
    )[0];
  if (!context)
    return {
      label: 'Ask reviewer',
      disabledReason: 'No reviewer session is recorded.',
      target: null,
      context: null,
    };
  return { ...runTerminalView(run, context.id), label: 'Ask reviewer' };
}

/** Keep the same actor binding for subscription, input, resize and snapshots on both clients. */
export function runTerminalTargetParams({
  slotId,
  runId,
  role,
  contextId,
}: SlotAgentTargetParams): Pick<SlotAgentTargetParams, 'slotId' | 'runId' | 'role' | 'contextId'> {
  return {
    slotId,
    ...(runId ? { runId } : {}),
    ...(role ? { role } : {}),
    ...(contextId ? { contextId } : {}),
  };
}

export function runTerminalTargetMatches(
  target: SlotAgentTargetParams,
  payload: Partial<Pick<SlotAgentTargetParams, 'slotId' | 'runId' | 'role' | 'contextId'>>,
): boolean {
  if (!target.slotId)
    return Boolean(target.runId && !payload.slotId && payload.runId === target.runId);
  if (payload.slotId !== target.slotId) return false;
  if (target.runId && payload.runId !== target.runId) return false;
  if (target.contextId && payload.contextId && payload.contextId !== target.contextId) return false;
  if (target.role && payload.role && payload.role !== target.role) return false;
  return true;
}

/** Presentation only: the gateway's run status and actor records determine what is running. */
export function runActivityView(run: Run): RunActivityView | null {
  if (
    isTerminalRunStatus(run.status) ||
    ['blocked', 'paused', 'needs-decision', 'review-failed'].includes(run.status) ||
    run.waitingForOperator
  )
    return null;
  const owner = [...run.steps].reverse().find((step) => step.status === 'running');
  if (!owner) return null;
  const actor =
    ['review', 'human-gate'].includes(owner.name) || ['fixing', 'reviewing'].includes(run.status)
      ? runReviewActivityContext(run)
      : undefined;
  const kind = actor
    ? actor.role === 'review-fix'
      ? 'worker-fix'
      : 'review'
    : run.status === 'fixing'
      ? 'worker-fix'
      : run.status === 'reviewing'
        ? 'review'
        : 'step';
  const phase =
    runUsesPublicationReviewNodes(run) &&
    kind !== 'step' &&
    ['review', 'human-gate'].includes(owner.name)
      ? owner.name === 'human-gate'
        ? 'post-gate'
        : 'pre-gate'
      : undefined;
  const used = Math.max(
    new Set(run.reviewRoundAdmissions ?? []).size,
    ...run.decisions.map((decision) =>
      decision.payload?.kind === 'ready' ? (decision.payload.reviewRoundBudget?.used ?? 0) : 0,
    ),
  );
  // A fix prepares the next review round; a reviewer is in the round already admitted.
  const round = used ? used + (kind === 'worker-fix' ? 1 : 0) : undefined;
  // This gateway progress field supplies the current count before the result is archived.
  // It never determines actor state, which comes from the structured fields above.
  const count = owner.detail?.match(/Reviewer found (\d+) issue/i)?.[1];
  const latestReview = run.engineState?.publishGate?.reviews?.at(-1);
  const findings = count === undefined ? latestReview?.unresolvedCount : Number(count);
  const findingLabel =
    findings === undefined
      ? 'review findings'
      : `${findings} review finding${findings === 1 ? '' : 's'}`;
  const roundLabel = round ? ` · round ${round}` : '';
  const label =
    kind === 'worker-fix'
      ? `Worker fixing ${findingLabel}${roundLabel}`
      : kind === 'review'
        ? `Reviewer checking changes${roundLabel}`
        : (deriveRunLifecycleView(run).activityLabel ?? deriveRunLifecycleView(run).label);
  const nodeLabel =
    kind === 'worker-fix' ? 'worker fix' : kind === 'review' ? 'reviewer' : owner.name;
  const detail =
    kind === 'worker-fix'
      ? `${findings === undefined ? 'Fixing findings' : `${findings} finding${findings === 1 ? '' : 's'}`}${roundLabel}`
      : kind === 'review'
        ? `Reviewing${roundLabel}`
        : (owner.detail ?? '');
  const nodeId = phase
    ? `${phase}-publication-review-${kind === 'worker-fix' ? 'fix' : 'active'}`
    : owner.name;
  const startedAt = phase
    ? (actor?.attemptStartedAt ?? run.statusChangedAt ?? actor?.startedAt ?? owner.startedAt)
    : owner.startedAt;
  const step: RunStep = phase
    ? { name: nodeId, status: 'running', startedAt, detail, outputs: { ownerStepName: owner.name } }
    : owner;
  const steps = run.steps.flatMap((candidate) => {
    const visible =
      candidate.status === 'running' && candidate.name !== nodeId
        ? { ...candidate, status: 'pending' as const }
        : candidate;
    return phase && candidate === owner ? [visible, step] : [visible];
  });
  return {
    kind,
    nodeId,
    ownerStepName: owner.name,
    nodeLabel,
    label,
    detail,
    startedAt,
    phase,
    step,
    steps,
  };
}
