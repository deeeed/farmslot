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
  const claims = (input.claims ?? []).map((claim) => ({
    id: claim.id,
    text: claim.text,
    state: pending.has(claim.id)
      ? 'Needs judgment'
      : claim.reviewLabels?.length
        ? 'Judged'
        : claim.status?.verdict === 'proven'
          ? 'Proven'
          : (claim.status?.verdict ?? 'Not assessed'),
    pending: pending.has(claim.id),
  }));
  for (const id of pending) {
    if (!claims.some((claim) => claim.id === id))
      claims.push({
        id,
        text: 'Review the recorded criterion.',
        state: 'Needs judgment',
        pending: true,
      });
  }
  const offeredNormal = input.actions.find((action) =>
    ['approve-publish', 'ready'].includes(action.id),
  );
  const normal =
    offeredNormal && input.readiness?.state === 'not-ready'
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
  const blockedReason = input.resolved
    ? 'This decision is resolved.'
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
    secondaryActions: input.actions.filter(
      (action) => action.id !== normal?.id && action.id !== offeredAttestation?.id,
    ),
  };
}

export type PublicationGateView = ReturnType<typeof publicationGateView>;
