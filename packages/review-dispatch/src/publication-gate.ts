import type {
  EvidenceReviewClaim,
  EvidenceReviewJudgmentRow,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceCriterionId,
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  acceptanceVerdictLabel,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  evidenceAttestationAvailable,
  type GateDecisionFields,
  gateWaitReason,
  isPublishApprovalAction,
  isValidEvidenceAttestationReason,
  latestReview,
  openHumanGateDecision,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewSummary,
  type Run,
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
  attestationReason?: string;
  resolved?: boolean;
  attesting?: boolean;
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
    for (const entry of [...(review.attempts ?? []), review]) {
      const findings = Math.max(entry.unresolvedCount ?? 0, entry.issues?.length ?? 0);
      if (entry.verdict === 'issues' && findings > 0) {
        count = findings;
        const issueHead =
          entry === review
            ? (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha)
            : entry.reviewSnapshot?.headSha;
        if (head && issueHead === head)
          currentHeadFindings = Math.max(currentHeadFindings, findings);
      }
    }
    if (
      review.verdict === 'pass' &&
      (!prepared || (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha) === prepared.headSha)
    )
      count = 0;
  }
  // A different verdict on unchanged code does not prove the reported fix.
  count = Math.max(count, currentHeadFindings);
  const fixing =
    run.status === 'fixing' ||
    run.agentContexts?.some(
      (context) =>
        context.role === 'review-fix' &&
        ['launching', 'working', 'waiting'].includes(context.status),
    );
  if (fixing)
    return count
      ? `Review found ${count} issue${count === 1 ? '' : 's'}, fix in progress.`
      : 'Review fix in progress.';
  if (count)
    return `Review found ${count} issue${count === 1 ? '' : 's'}. Fix and pass review before publishing.`;
  return undefined;
}

/**
 * What a run's open human gate waits on, as one line a person can act on: the gate's
 * reason whose action it offers (the lifecycle view's rule), else the review findings.
 * Presentation only; publish guards keep using publicationReviewBlockingReason.
 */
export function humanGateBlockingReason(
  run: Pick<Run, 'status' | 'agentContexts' | 'engineState' | 'decisions'>,
): string | undefined {
  const gate = openHumanGateDecision(run);
  return (gate ? gateWaitReason(gate) : undefined) ?? publicationReviewBlockingReason(run);
}

/** Presentation only: action availability and evidence judgments remain gateway-owned. */
export function publicationGateView(input: PublicationGateInput) {
  const pending = new Set(input.pendingVisualClaimIds ?? []);
  const claims = acceptanceClaimRows(input);
  const reviewBlock =
    (input.run && publicationReviewBlockingReason(input.run)) ||
    input.readiness?.reasons.find((reason) => reason.code === 'review-fix-required')?.message;
  const actions =
    reviewBlock || input.resolved
      ? input.actions.filter((action) => !isPublishApprovalAction(action.id))
      : input.actions;
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
      : ((input.attesting ? attestation : null) ?? normal ?? null);
  const refreshRequired =
    input.readiness?.reasons.some(
      (reason) => reason.code === 'evidence-override-refresh-required',
    ) ?? false;
  const blockedReason = input.resolved
    ? 'This decision is resolved.'
    : reviewBlock
      ? ((input.gate ? gateWaitReason(input.gate) : undefined) ?? reviewBlock)
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
  const reasonRequired = approval?.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION;
  return {
    warnings: input.reviewSummary?.noCodeReview ? ['No code review ran'] : [],
    claims,
    status: sendBack
      ? (sendBackRecovery ?? 'Issues found')
      : blockedReason || (attestation ? 'Evidence attestation is available.' : 'Ready to publish'),
    blockedReason:
      blockedReason ||
      (reasonRequired && !isValidEvidenceAttestationReason(input.attestationReason)
        ? 'Enter an attestation reason before approving.'
        : ''),
    approval,
    sendBack: sendBack ?? null,
    attestation,
    refreshRequired,
    secondaryActions: actions.filter(
      (action) =>
        action.id !== normal?.id &&
        action.id !== offeredAttestation?.id &&
        action.id !== sendBack?.id,
    ),
  };
}

export type PublicationGateView = ReturnType<typeof publicationGateView>;

export function visualPrevalidationLabel(
  row?: Pick<EvidenceReviewJudgmentRow, 'prevalidation'>,
): string {
  return `Agent review · ${row?.prevalidation ? (row.prevalidation.verdict === 'confirmed' ? 'Looks right' : 'Issue') : 'Not recorded'}`;
}

/** The same evidence-first navigation on desktop and Companion. */
export const PUBLICATION_GATE_TABS = [
  { id: 'evidence', label: 'Evidence' },
  { id: 'criteria', label: 'Criteria' },
  { id: 'pr-preview', label: 'Package' },
  { id: 'quality', label: 'Checks & history' },
] as const;
