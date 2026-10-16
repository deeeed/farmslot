import type {
  EvidenceReviewClaim,
  EvidenceReviewJudgmentRow,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceCriterionId,
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  evidenceAttestationAvailable,
  isPublishApprovalAction,
  isValidEvidenceAttestationReason,
  type ReadyGatePayload,
  type RunGateReadiness,
} from '@farmslot/protocol';

export interface PublicationGateAction extends DecisionAction {
  disabledReason?: string | null;
}

export interface PublicationGateClaim extends AcceptanceCriterionView {
  reviewLabels?: readonly string[];
  proofKinds?: EvidenceReviewClaim['proofKinds'];
  evidenceLinked?: boolean;
}

export interface PublicationGateInput {
  actions: readonly PublicationGateAction[];
  claims?: readonly PublicationGateClaim[];
  judgmentRows?: readonly EvidenceReviewJudgmentRow[];
  pendingVisualClaimIds?: readonly string[];
  readiness?: RunGateReadiness;
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
    row.tone =
      row.state === 'Issue'
        ? 'issue'
        : row.state === 'Checked'
          ? 'checked'
          : row.state === 'Verified by agent'
            ? 'verified'
            : row.state === 'Proven'
              ? 'proven'
              : row.state === 'untestable'
                ? 'untestable'
                : 'pending';
    if (row.tone === 'untestable') row.state = 'Untestable';
    row.detail = [row.source?.reviewLabels?.join(' · '), row.judgment?.prevalidation?.reason]
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

/** Presentation only: action availability and evidence judgments remain gateway-owned. */
export function publicationGateView(input: PublicationGateInput) {
  const pending = new Set(input.pendingVisualClaimIds ?? []);
  const claims = acceptanceClaimRows(input);
  const reviewBlock = input.readiness?.reasons.find(
    (reason) => reason.code === 'review-fix-required',
  );
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
  const attestation =
    !input.resolved &&
    !pending.size &&
    offeredAttestation &&
    !offeredAttestation.disabledReason &&
    evidenceAttestationAvailable(input.readiness)
      ? offeredAttestation
      : null;
  const approval =
    normal && !normal.disabledReason
      ? normal
      : ((input.attesting ? attestation : null) ?? normal ?? null);
  const refreshRequired =
    input.readiness?.reasons.some(
      (reason) => reason.code === 'evidence-override-refresh-required',
    ) ?? false;
  const blockedReason = input.resolved
    ? 'This decision is resolved.'
    : reviewBlock
      ? reviewBlock.message
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
    claims,
    status:
      blockedReason || (attestation ? 'Evidence attestation is available.' : 'Ready to publish'),
    blockedReason:
      blockedReason ||
      (reasonRequired && !isValidEvidenceAttestationReason(input.attestationReason)
        ? 'Enter an attestation reason before approving.'
        : ''),
    approval,
    attestation,
    refreshRequired,
    secondaryActions: actions.filter(
      (action) => action.id !== normal?.id && action.id !== offeredAttestation?.id,
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
