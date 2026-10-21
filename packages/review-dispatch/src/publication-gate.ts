import type {
  EvidenceReviewClaim,
  EvidenceReviewJudgmentRow,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceCriterionId,
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  acceptanceVerdictLabel,
  acceptReviewFindingsAvailable,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type DecisionAction,
  evidenceAttestationAvailable,
  type GateDecisionFields,
  gateDisplayReasons,
  gateWaitReason,
  isPublishApprovalAction,
  isValidEvidenceAttestationReason,
  latestReview,
  openHumanGateDecision,
  openReviewFindingCount,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewAttempt,
  reviewFindingsSatisfied,
  type ReviewIssue,
  type ReviewLineageOption,
  type ReviewRoundBudget,
  type ReviewStatus,
  type ReviewSummary,
  type Run,
  type RunExtendReviewBudgetParams,
  type RunGateReadiness,
  SEND_BACK_TO_AGENT_ACTION,
} from '@farmslot/protocol';

export interface PublicationGateAction extends DecisionAction {
  disabledReason?: string | null;
}

export interface PublicationGateClaim extends AcceptanceCriterionView {
  reviewLabels?: readonly string[];
  proofKinds?: EvidenceReviewClaim['proofKinds'];
  evidenceLinked?: boolean;
  retained?: EvidenceReviewClaim['retained'];
}

export interface PublicationGateInput {
  run?: Pick<Run, 'status' | 'agentContexts' | 'engineState'> | null;
  /** The open human gate: its actionable reason is what the view shows as blocking. */
  gate?: GateDecisionFields | null;

  actions: readonly PublicationGateAction[];
  claims?: readonly PublicationGateClaim[];
  judgmentRows?: readonly EvidenceReviewJudgmentRow[];
  pendingVisualClaimIds?: readonly string[];
  readiness?: RunGateReadiness;
  reviewSummary?: ReviewSummary;
  blockedReason?: string;
  /** The written reason for evidence attestation or for accepting review findings. */
  attestationReason?: string;
  resolved?: boolean;
  attesting?: boolean;
  /** The person chose to accept the open review findings (ADR-065 Amendment 8). */
  acceptingFindings?: boolean;
}

/** Declared labels size both clients; older gates retain their recorded criterion rows. */
export function publicationGateCriteria(
  payload: Pick<ReadyGatePayload, 'acceptanceCriteria' | 'acceptanceStatus'> | undefined,
): readonly AcceptanceCriterionRef[] {
  if (payload?.acceptanceCriteria?.length)
    return payload.acceptanceCriteria.map((text, index) => ({
      id: acceptanceCriterionId(index),
      text,
    }));
  return payload?.acceptanceStatus?.criteria ?? [];
}

export type AcceptanceClaimTone =
  | 'proven'
  | 'verified'
  | 'checked'
  | 'issue'
  | 'pending'
  | 'untestable';
export interface VisualJudgmentFeedback {
  claimId: string;
  phase: 'saving' | 'refreshing' | 'error';
  message?: string;
}

export interface AcceptanceClaimRow {
  id: string;
  text: string;
  state: string;
  tone: AcceptanceClaimTone;
  detail: string;
  pending: boolean;
  source?: PublicationGateClaim;
  judgment?: EvidenceReviewJudgmentRow;
}

/** One AC presentation for publication gates, previews and evidence panels. */
export function acceptanceClaimRows(
  input: Pick<PublicationGateInput, 'claims' | 'judgmentRows' | 'pendingVisualClaimIds'>,
): AcceptanceClaimRow[] {
  const pending = new Set(input.pendingVisualClaimIds ?? []);
  const claims: AcceptanceClaimRow[] = (
    input.claims ??
    input.judgmentRows?.map((row) => row.claim) ??
    []
  ).map((claim) => ({
    source: claim,
    judgment: input.judgmentRows?.find((row) => row.claim.id === claim.id),
    id: claim.id,
    text: claim.text,
    state:
      claim.status?.verdict === 'failed'
        ? 'Issue'
        : pending.has(claim.id) || claim.status?.verdict === 'awaiting-review'
          ? 'Needs a check'
          : claim.status?.verdict === 'proven'
            ? claim.proofKinds?.includes('person-reviewed')
              ? 'Checked'
              : claim.proofKinds?.includes('agent-reviewed')
                ? 'Verified by agent'
                : 'Proven'
            : (claim.status?.verdict ??
              ('evidenceLinked' in claim && claim.evidenceLinked
                ? 'Evidence linked'
                : 'Not assessed')),
    tone: 'pending',
    detail: '',
    pending: pending.has(claim.id),
  }));
  for (const row of claims) {
    // The code review checks a `review` claim (ADR-062 Amendment 18).
    const status = row.source?.status;
    if (status?.proofMode === 'review' && !['failed', 'untestable'].includes(status.verdict))
      row.state = acceptanceVerdictLabel(status);
    row.tone =
      row.state === 'Issue'
        ? 'issue'
        : row.state === 'Checked' || row.state === 'Checked in review'
          ? 'checked'
          : row.state === 'Verified by agent'
            ? 'verified'
            : row.state === 'Proven'
              ? 'proven'
              : row.state === 'untestable'
                ? 'untestable'
                : 'pending';
    if (row.tone === 'untestable') row.state = 'Untestable';
    const retained = row.source?.retained ?? row.judgment?.claim.retained;
    row.detail = [
      retained
        ? `Earlier proof${retained.revision ? ` · ${retained.revision.slice(0, 7)}` : ''}`
        : undefined,
      row.source?.reviewLabels?.join(' · '),
      row.judgment?.prevalidation?.reason,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  for (const id of pending) {
    if (!claims.some((claim) => claim.id === id))
      claims.push({
        id,
        source: undefined,
        judgment: undefined,
        text: 'Review the recorded criterion.',
        state: 'Needs a check',
        tone: 'pending',
        detail: '',
        pending: true,
      });
  }
  return claims;
}

/** A review row or one of its attempts that reported findings, with the head it reviewed. */
export interface ReviewFindingEntry {
  review: ReviewStatus;
  entry: ReviewStatus | ReviewAttempt;
  findings: number;
  head?: string | null;
}

/**
 * Every entry that reported findings. The publication block counts them at the head, and
 * accepting findings accepts exactly theirs (ADR-065 Amendment 8).
 */
export function reviewFindingEntries(reviews: readonly ReviewStatus[]): ReviewFindingEntry[] {
  return reviews.flatMap((review) =>
    [...(review.attempts ?? []), review].flatMap((entry) => {
      const findings = openReviewFindingCount(review, entry);
      return entry.verdict === 'issues' && findings > 0
        ? [
            {
              review,
              entry,
              findings,
              head:
                entry === review
                  ? (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha)
                  : entry.reviewSnapshot?.headSha,
            },
          ]
        : [];
    }),
  );
}

export function reviewFixInProgress(run: Pick<Run, 'status' | 'agentContexts'>): boolean {
  return (
    run.status === 'fixing' ||
    !!run.agentContexts?.some(
      (context) =>
        context.role === 'review-fix' &&
        ['launching', 'working', 'waiting'].includes(context.status),
    )
  );
}

/** An optional review policy never waives findings from a review that actually ran. */
export function publicationReviewBlockingReason(
  run: Pick<Run, 'status' | 'agentContexts' | 'engineState'>,
  prepared?: Pick<ReadyGatePrPackage, 'headSha'> | null,
): string | undefined {
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  // Continuations replace the same row. Its attempts retain the findings even
  // when a blocked fix changes the aggregate verdict to failed.
  const latest = latestReview(reviews);
  const head = prepared?.headSha ?? latest?.reviewedHeadSha ?? latest?.reviewSnapshot?.headSha;
  let currentHeadFindings = 0;
  let count = 0;
  for (const review of reviews) {
    for (const { findings, head: issueHead } of reviewFindingEntries([review])) {
      count = findings;
      if (head && issueHead === head) currentHeadFindings = Math.max(currentHeadFindings, findings);
    }
    if (
      reviewFindingsSatisfied(review) &&
      (!prepared || (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha) === prepared.headSha)
    )
      count = 0;
  }
  // A different verdict on unchanged code does not prove the reported fix.
  count = Math.max(count, currentHeadFindings);
  if (reviewFixInProgress(run))
    return count
      ? `Review found ${count} issue${count === 1 ? '' : 's'}, fix in progress.`
      : 'Review fix in progress.';
  if (count)
    return `Review found ${count} issue${count === 1 ? '' : 's'}. Fix and pass review before publishing.`;
  return undefined;
}

/**
 * The review findings that block a run's publication, worded by its open human gate's
 * actionable reason (the lifecycle view's rule). Presentation only; publish guards keep
 * using publicationReviewBlockingReason.
 */
export function humanGateBlockingReason(
  run: Pick<Run, 'status' | 'agentContexts' | 'engineState' | 'decisions'>,
): string | undefined {
  return gateReviewBlockingReason(publicationReviewBlockingReason(run), openHumanGateDecision(run));
}

/** Review findings block publication; an open gate words them as the reason a person can act on. */
function gateReviewBlockingReason(
  reviewBlock: string | undefined,
  gate: GateDecisionFields | null | undefined,
): string | undefined {
  return reviewBlock && ((gate ? gateWaitReason(gate) : undefined) ?? reviewBlock);
}

/** Presentation only: action availability and evidence judgments remain gateway-owned. */
export function publicationGateView(input: PublicationGateInput) {
  const pending = new Set(input.pendingVisualClaimIds ?? []);
  const claims = acceptanceClaimRows(input);
  const reviewBlock =
    (input.run && publicationReviewBlockingReason(input.run)) ||
    input.readiness?.reasons.find((reason) => reason.code === 'review-fix-required')?.message;
  // Findings block every publish approval except accepting them, under the shared rule.
  const offeredAccept =
    !input.resolved && acceptReviewFindingsAvailable(input.readiness)
      ? input.actions.find(
          (action) => action.id === APPROVE_PUBLISH_UNRESOLVED_ACTION && !action.disabledReason,
        )
      : undefined;
  const actions = (
    reviewBlock || input.resolved
      ? input.actions.filter((action) => !isPublishApprovalAction(action.id))
      : input.actions
  ).filter((action) => action.id !== APPROVE_PUBLISH_UNRESOLVED_ACTION || !offeredAccept);
  const acceptFindings = offeredAccept ?? null;
  const offeredNormal = actions.find((action) =>
    ['approve-publish', 'approve-publish-evidence-refresh', 'ready'].includes(action.id),
  );
  const normal =
    offeredNormal &&
    input.readiness?.state === 'not-ready' &&
    offeredNormal.id !== 'approve-publish-evidence-refresh'
      ? {
          ...offeredNormal,
          disabledReason:
            offeredNormal.disabledReason ||
            input.blockedReason ||
            input.readiness.reasons[0]?.message ||
            'Publication prerequisites are not satisfied.',
        }
      : offeredNormal;
  const offeredAttestation = actions.find(
    (action) => action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  );
  // An Issue blocks publication; returning it to the agent is the gate's one primary action.
  const sendBack = input.resolved
    ? undefined
    : actions.find((action) => action.id === SEND_BACK_TO_AGENT_ACTION);
  const repair = input.run?.engineState?.publishGate?.visualRepairs?.at(-1);
  const sendBackRecovery =
    sendBack && repair && repair.status !== 'completed' ? repair.reason : undefined;
  const attestation =
    !input.resolved &&
    !pending.size &&
    offeredAttestation &&
    !offeredAttestation.disabledReason &&
    evidenceAttestationAvailable(input.readiness)
      ? offeredAttestation
      : null;
  const approval = sendBack
    ? null
    : normal && !normal.disabledReason
      ? normal
      : ((input.attesting ? attestation : null) ??
        (input.acceptingFindings ? acceptFindings : null) ??
        normal ??
        null);
  const accepting = !!acceptFindings && approval?.id === acceptFindings.id;
  const refreshRequired =
    input.readiness?.reasons.some(
      (reason) => reason.code === 'evidence-override-refresh-required',
    ) ?? false;
  const blockedReason = input.resolved
    ? 'This decision is resolved.'
    : accepting
      ? ''
      : reviewBlock
        ? gateReviewBlockingReason(reviewBlock, input.gate)
        : refreshRequired
          ? 'Refresh package'
          : pending.size
            ? `${pending.size} ${pending.size === 1 ? 'criterion needs' : 'criteria need'} a check`
            : approval?.disabledReason ||
              (!approval
                ? attestation
                  ? 'Choose evidence attestation.'
                  : input.blockedReason || 'Publication prerequisites are not satisfied.'
                : '');
  const reasonRequired = approval?.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION || accepting;
  const primaryActionIds = new Set(['request-review', 'send-feedback']);
  const remainingActions = actions.filter(
    (action) =>
      action.id !== normal?.id &&
      action.id !== offeredAttestation?.id &&
      action.id !== sendBack?.id,
  );
  const reviewIssues: readonly ReviewIssue[] =
    input.readiness?.findings ??
    input.run?.engineState?.publishGate?.reviews?.flatMap((review) =>
      review.verdict === 'issues' ? (review.issues ?? []) : [],
    ) ??
    [];
  return {
    warnings: input.reviewSummary?.noCodeReview ? ['No code review ran'] : [],
    claims,
    status: sendBack
      ? (sendBackRecovery ?? 'Issues found')
      : blockedReason ||
        (accepting
          ? 'Publishing accepts the open review findings.'
          : attestation
            ? 'Evidence attestation is available.'
            : 'Ready to publish'),
    blockedReason:
      blockedReason ||
      (reasonRequired && !isValidEvidenceAttestationReason(input.attestationReason)
        ? accepting
          ? 'Enter a reason before accepting the findings.'
          : 'Enter an attestation reason before approving.'
        : ''),
    approval,
    sendBack: sendBack ?? null,
    attestation,
    acceptFindings,
    findings: acceptFindings ? (input.readiness?.findings ?? []) : [],
    refreshRequired,
    reviewIssues,
    blockerActionIds:
      input.readiness?.reasons.flatMap((reason) =>
        reason.code === 'review-fix-required'
          ? [APPROVE_PUBLISH_UNRESOLVED_ACTION]
          : reason.code === 'review-result-required'
            ? ['request-review']
            : [],
      ) ?? [],
    primaryActions: remainingActions.filter((action) => primaryActionIds.has(action.id)),
    secondaryActions: remainingActions.filter((action) => !primaryActionIds.has(action.id)),
  };
}

export type PublicationGateView = ReturnType<typeof publicationGateView>;

export function visualPrevalidationLabel(
  row?: Pick<EvidenceReviewJudgmentRow, 'prevalidation'>,
): string {
  return `Agent review · ${row?.prevalidation ? (row.prevalidation.verdict === 'confirmed' ? 'Looks right' : 'Issue') : 'Not recorded'}`;
}

/**
 * How desktop and Companion skip a criterion: the untestable override (ADR-062
 * Amendment 4) with its required written reason. The protocol action stays
 * `mark-untestable`.
 */
export interface UntestableOverrideView {
  /** Opens the reason sheet. */
  action: string;
  title: string;
  hint: string;
  reasonLabel: string;
  placeholder: string;
  confirm: string;
  cancel: string;
  /** The override needs a written reason. */
  canConfirm: boolean;
}

export function untestableOverrideView(claimId: string, reason: string): UntestableOverrideView {
  return {
    action: 'Skip this criterion…',
    title: `Skip ${claimId}`,
    hint: 'It is recorded as untestable, never as proven. Reviewers see your reason.',
    reasonLabel: 'Why it cannot be tested',
    placeholder: 'What blocks a real proof of this criterion',
    confirm: `Skip ${claimId}`,
    cancel: 'Cancel',
    canConfirm: reason.trim().length > 0,
  };
}

/** How desktop and Companion grant one more review round (`run.extendReviewBudget`). */
export interface AnotherReviewRoundView {
  action: string;
  title: string;
  hint: string;
  reasonLabel: string;
  placeholder: string;
  confirm: string;
  cancel: string;
  /** The extension needs a written scope for the next round. */
  canConfirm: boolean;
}

export function anotherReviewRoundView(
  budget: Pick<ReviewRoundBudget, 'used' | 'limit'>,
  brief: string,
): AnotherReviewRoundView {
  return {
    action: 'Give it another round',
    title: 'Give it another review round',
    hint: `${budget.used} of ${budget.limit} rounds used. One more lets the agent fix the findings and review again.`,
    reasonLabel: 'What the next round should check',
    placeholder: 'For example: the open findings, and nothing else',
    confirm: 'Give it another round',
    cancel: 'Cancel',
    canConfirm: brief.trim().length > 0,
  };
}

/**
 * The `run.extendReviewBudget` request for one more round on this gate. The request id
 * names the gate and the limit it raises, so a retried press cannot grant two rounds.
 */
export function anotherReviewRoundParams(input: {
  runId: string;
  decisionId: string;
  budget: Pick<ReviewRoundBudget, 'limit'>;
  headSha: string;
  brief: string;
}): RunExtendReviewBudgetParams {
  return {
    runId: input.runId,
    requestId: `extend-review-budget:${input.decisionId}:${input.budget.limit}`,
    expectedLimit: input.budget.limit,
    limit: input.budget.limit + 1,
    headSha: input.headSha,
    scopeBrief: input.brief.trim(),
  };
}

export type PublicationBlockerAction =
  | { kind: 'skip-criterion'; claimId: string; label: string }
  | { kind: 'accept-findings'; label: string }
  | { kind: 'see-findings'; label: string }
  | { kind: 'request-review'; label: string }
  | { kind: 'review-evidence'; claimId: string; label: string }
  | { kind: 'another-round'; label: string };

export interface PublicationBlockerFinding extends ReviewIssue {
  summary: string;
}
/** One reason the gate cannot publish, with the one plain action that clears it, if any. */
export interface PublicationBlocker {
  key: string;
  message: string;
  findings: readonly PublicationBlockerFinding[];
  actions: readonly PublicationBlockerAction[];
}

/**
 * A criterion that blocks publish: its verdict is missing, weak or failed. One that
 * waits for a person's check has its own Looks right / Issue; a code-review criterion
 * blocks only when the review failed it.
 */
function blocksPublish(claim: AcceptanceClaimRow): boolean {
  const status = claim.source?.status;
  if (claim.pending || status?.verdict === 'proven' || status?.verdict === 'untestable')
    return false;
  if (status?.verdict === 'awaiting-review') return false;
  if (status?.proofMode === 'review') return status.verdict === 'failed';
  return true;
}

/**
 * What blocks publish, for the top of the gate on desktop and Companion. A criterion
 * the gate lets a person skip, open review findings the gate lets them accept, and
 * spent review rounds each get one action; any other readiness reason is listed as the
 * gate words it. Presentation only: the gateway still owns every action.
 */
export function publicationGateBlockers(input: {
  view: Pick<PublicationGateView, 'acceptFindings' | 'claims' | 'reviewIssues' | 'primaryActions'>;
  readiness?: RunGateReadiness;
  gate?: GateDecisionFields | null;
  resolved?: boolean;
  /** The criteria the gate lets a person skip: the evidence model's override candidates. */
  canSkip: (claimId: string) => boolean;
  budget?: Pick<ReviewRoundBudget, 'remaining' | 'used' | 'limit'>;
}): PublicationBlocker[] {
  const readiness = input.readiness;
  if (input.resolved || !readiness || readiness.state === 'ready') return [];
  const skippable = input.view.claims.filter(
    (claim) => blocksPublish(claim) && input.canSkip(claim.id),
  );
  const blockers: PublicationBlocker[] = skippable.map((claim) => ({
    key: `criterion:${claim.id}`,
    message: `${claim.id} · ${claim.state}: ${claim.text}`,
    findings: [],
    actions: [
      {
        kind: 'skip-criterion',
        claimId: claim.id,
        label: untestableOverrideView(claim.id, '').action,
      },
    ],
  }));
  const skipped = new Set(skippable.map((claim) => claim.id));
  const reasons = input.gate ? gateDisplayReasons(input.gate) : readiness.reasons;
  for (const reason of reasons) {
    // The criteria rows above say which criteria, and how to clear each one.
    if (reason.code === 'acceptance-incomplete' && skipped.size) continue;
    if (reason.reference && skipped.has(reason.reference)) continue;
    if (blockers.some((blocker) => blocker.message === reason.message)) continue;
    const findings =
      reason.code === 'review-fix-required'
        ? input.view.reviewIssues.map((finding) => {
            const firstLine = finding.description.trim().split(/\r?\n/)[0] ?? '';
            return {
              ...finding,
              summary: firstLine.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? firstLine,
            };
          })
        : [];
    const actions: PublicationBlockerAction[] = [];
    if (findings.length)
      actions.push({
        kind: 'see-findings',
        label: findings.length === 1 ? 'See finding' : 'See findings',
      });
    if (reason.code === 'review-fix-required' && input.view.acceptFindings)
      actions.push({
        kind: 'accept-findings',
        label: findings.length === 1 ? 'Accept finding…' : 'Accept findings…',
      });
    const request = input.view.primaryActions.find(
      (action) => action.id === 'request-review' && !action.disabledReason,
    );
    if (reason.code === 'review-result-required' && request && input.budget?.remaining !== 0)
      actions.push({
        kind: 'request-review',
        label: input.budget
          ? `Request review (round ${input.budget.used + 1} of ${input.budget.limit})`
          : 'Request review',
      });
    if (reason.code === 'evidence-policy-unsatisfied') {
      const claim = input.view.claims.find((entry) => entry.pending || entry.judgment?.reviewKind);
      if (claim)
        actions.push({
          kind: 'review-evidence',
          claimId: claim.id,
          label: `Review ${claim.id} evidence`,
        });
    }
    blockers.push({
      key: `reason:${reason.code}:${reason.reference ?? blockers.length}`,
      message:
        reason.code === 'review-result-required'
          ? 'The current version needs a review'
          : reason.code === 'review-fix-required' && findings.length
            ? `Review found ${findings.length} issue${findings.length === 1 ? '' : 's'}`
            : reason.message,
      findings,
      actions,
    });
  }
  if (input.budget?.remaining === 0)
    blockers.push({
      key: 'budget',
      message: `No review rounds left (${input.budget.used} of ${input.budget.limit} used).`,
      findings: [],
      actions: [
        {
          kind: 'another-round',
          label: anotherReviewRoundView(input.budget, '').action,
        },
      ],
    });
  return blockers;
}

/** The same evidence-first navigation on desktop and Companion. */
export const PUBLICATION_GATE_TABS = [
  { id: 'evidence', label: 'Evidence' },
  { id: 'criteria', label: 'Criteria' },
  { id: 'pr-preview', label: 'Package' },
  { id: 'quality', label: 'Checks & history' },
] as const;

/** The lineages a ready gate's Request Review can continue, as the gateway listed them. */
export function gateReviewLineageOptions(
  run: Pick<Run, 'decisions'> | null | undefined,
  decisionId?: string | null,
): readonly ReviewLineageOption[] | undefined {
  const decision = [...(run?.decisions ?? [])]
    .reverse()
    .find((entry) =>
      decisionId ? entry.id === decisionId : !entry.resolvedAt && entry.payload?.kind === 'ready',
    );
  return decision?.payload?.kind === 'ready' ? decision.payload.reviewLineageOptions : undefined;
}

/**
 * Why a review ran COLD in a fresh session and the ranges it compared, shown with that
 * review at the gate (ADR-063 Amendment 5). Null when it never fell back.
 */
export function reviewFallbackLine(
  review: Pick<ReviewStatus, 'session' | 'attempts'>,
): string | null {
  const attempt = [...(review.attempts ?? [])].reverse().find((entry) => entry.session?.fallback);
  const fallback = review.session?.fallback ?? attempt?.session?.fallback;
  if (!fallback) return null;
  const ranges = fallback.comparedRanges.map((range) =>
    range.replace(/[0-9a-f]{40}/gi, (sha) => sha.slice(0, 12)),
  );
  const loop = review.session?.fallback || !attempt ? '' : `Round ${attempt.loopNumber} `;
  return `${loop}Ran COLD in a fresh session: ${fallback.detail}. Compared ${ranges.join(' with ') || 'no recorded range'}.`;
}
