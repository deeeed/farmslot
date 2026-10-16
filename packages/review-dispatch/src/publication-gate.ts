import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionView,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  evidenceAttestationAvailable,
  isValidEvidenceAttestationReason,
  type RunGateReadiness,
} from '@farmslot/protocol';

export interface PublicationGateAction extends DecisionAction {
  disabledReason?: string | null;
}

export interface PublicationGateClaim extends AcceptanceCriterionView {
  reviewLabels?: readonly string[];
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

/** Presentation only: action availability and evidence judgments remain gateway-owned. */
export function publicationGateView(input: PublicationGateInput) {
  const pending = new Set(input.pendingVisualClaimIds ?? []);
  const claims = (input.claims ?? input.judgmentRows?.map((row) => row.claim) ?? []).map(
    (claim) => ({
      judgment: input.judgmentRows?.find((row) => row.claim.id === claim.id),
      id: claim.id,
      text: claim.text,
      state:
        claim.status?.verdict === 'failed' && claim.reviewLabels?.length
          ? 'Issue'
          : pending.has(claim.id)
            ? 'Needs judgment'
            : claim.reviewLabels?.length
              ? 'Judged'
              : claim.status?.verdict === 'proven'
                ? 'Proven'
                : (claim.status?.verdict ?? 'Not assessed'),
      pending: pending.has(claim.id),
    }),
  );
  for (const id of pending) {
    if (!claims.some((claim) => claim.id === id))
      claims.push({
        id,
        judgment: undefined,
        text: 'Review the recorded criterion.',
        state: 'Needs judgment',
        pending: true,
      });
  }
  const offeredNormal = input.actions.find((action) =>
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
  const offeredAttestation = input.actions.find(
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
    : refreshRequired
      ? 'Refresh package'
      : pending.size
        ? `${pending.size} ${pending.size === 1 ? 'criterion needs' : 'criteria need'} your visual judgment`
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
    secondaryActions: input.actions.filter(
      (action) => action.id !== normal?.id && action.id !== offeredAttestation?.id,
    ),
  };
}

export type PublicationGateView = ReturnType<typeof publicationGateView>;
