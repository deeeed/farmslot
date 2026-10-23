import type {
  RunGatePrerequisiteReason,
  RunGateReadiness,
} from '../contracts/run-gate-readiness.js';
import type { DecisionAction } from '../contracts/runs.js';
import type { RunResolveDecisionParams } from '../rpc/run.js';

import { APPROVE_PUBLISH_UNRESOLVED_ACTION } from './review-retries.js';

/** Approve publication of a package whose reviews satisfy the gate's policy. */
export const APPROVE_PUBLISH_ACTION = 'approve-publish';

export const APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION = 'approve-publish-evidence-attested';

export const EVIDENCE_ATTESTATION_ACTION: DecisionAction = {
  id: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  label: 'Attest evidence and approve',
  style: 'danger',
  description:
    'Your reason and approver identity will appear in the PR. Integrity, source, CI and review checks remain required.',
};

/** Presentation of the existing findings approval when it also attests evidence. */
export const COMBINED_FINDINGS_EVIDENCE_APPROVAL_ACTION: DecisionAction = {
  id: APPROVE_PUBLISH_UNRESOLVED_ACTION,
  label: 'Accept findings, attest evidence and publish',
  style: 'danger',
  description:
    'Accept the listed findings and evidence-policy gaps. Both decisions, your reason and identity appear in the PR.',
};

export function isEvidencePolicyReason(reason: RunGatePrerequisiteReason): boolean {
  return (
    reason.prerequisite === 'evidence' &&
    reason.code === 'evidence-policy-unsatisfied' &&
    ['execution-verdict', 'claim-verdict', 'criterion-binding'].includes(
      reason.evidencePolicy ?? '',
    )
  );
}

function combinedFindingsEvidenceAvailable(readiness?: RunGateReadiness): boolean {
  if (
    !readiness ||
    readiness.state !== 'not-ready' ||
    !readiness.findings?.length ||
    !readiness.findingsDigest
  )
    return false;
  const reviewReason = (reason: RunGatePrerequisiteReason) =>
    reason.prerequisite === 'review' &&
    reason.code === 'review-fix-required' &&
    reason.allowedReviewOverrides?.includes(APPROVE_PUBLISH_UNRESOLVED_ACTION);
  return (
    readiness.reasons.some(reviewReason) &&
    readiness.reasons.some(isEvidencePolicyReason) &&
    readiness.reasons.every((reason) => reviewReason(reason) || isEvidencePolicyReason(reason))
  );
}

export function evidenceAttestationAvailable(
  readiness?: RunGateReadiness,
  actionId: string = APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
): boolean {
  if (actionId === APPROVE_PUBLISH_UNRESOLVED_ACTION)
    return combinedFindingsEvidenceAvailable(readiness);
  return (
    actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
    !!readiness &&
    readiness.state === 'not-ready' &&
    readiness.reasons.length > 0 &&
    readiness.reasons.every(isEvidencePolicyReason)
  );
}

/** Checked findings may combine only with the explicitly attestable evidence-policy reasons. */
export function acceptReviewFindingsAvailable(readiness?: RunGateReadiness): boolean {
  return (
    !!readiness &&
    readiness.state === 'not-ready' &&
    !!readiness.findings?.length &&
    !!readiness.findingsDigest &&
    gateReasonsForAction(readiness, APPROVE_PUBLISH_UNRESOLVED_ACTION).length === 0
  );
}

/** Actions that move the run past a gate and so require its prerequisites. */
export function advancingGateAction(actionId: string): boolean {
  return (
    actionId === 'ready' ||
    isPublishApprovalAction(actionId) ||
    actionId === 'post' ||
    actionId === 'accept-no-change'
  );
}

/**
 * The one availability rule for gate actions: the gateway lists and resolves with it, and
 * clients list with it, so a listed action is one resolve accepts.
 */
export function gateActionsForReadiness<Action extends { id: string }>(
  actions: Action[],
  readiness: RunGateReadiness,
): Action[] {
  return actions.filter((action) =>
    action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION
      ? evidenceAttestationAvailable(readiness)
      : action.id === APPROVE_PUBLISH_UNRESOLVED_ACTION
        ? acceptReviewFindingsAvailable(readiness)
        : !advancingGateAction(action.id) ||
          gateReasonsForAction(readiness, action.id).length === 0,
  );
}

/** The reasons that still block an action once its own overrides are applied. */
export function gateReasonsForAction(
  readiness: RunGateReadiness,
  actionId?: string,
): RunGatePrerequisiteReason[] {
  const reviewOverride = [
    APPROVE_PUBLISH_UNRESOLVED_ACTION,
    APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
    APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  ].some((id) => id === actionId);
  const evidenceOverride =
    actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION ||
    (actionId === APPROVE_PUBLISH_UNRESOLVED_ACTION &&
      combinedFindingsEvidenceAvailable(readiness));
  return readiness.reasons.filter(
    (reason) =>
      !(
        reviewOverride &&
        reason.prerequisite === 'review' &&
        reason.allowedReviewOverrides?.includes(actionId!)
      ) && !(evidenceOverride && isEvidencePolicyReason(reason)),
  );
}

export function evidenceAttestationReason(actionId: string, reason?: string): string | undefined {
  if (
    actionId !== APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
    !(actionId === APPROVE_PUBLISH_UNRESOLVED_ACTION && reason !== undefined)
  ) {
    if (reason !== undefined)
      throw new Error('An evidence reason requires attested evidence approval.');
    return undefined;
  }
  if (!isValidEvidenceAttestationReason(reason))
    throw new Error('Attested evidence approval requires a written reason.');
  return reason.trim();
}

/** One written reason, with explicit consent to include its evidence-attestation field. */
export function publicationApprovalReasonFields(
  actionId: string,
  text: string,
  attestEvidence = false,
): Pick<RunResolveDecisionParams, 'reason' | 'evidenceAttestationReason'> {
  if (actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION)
    return { evidenceAttestationReason: text };
  if (actionId === APPROVE_PUBLISH_UNRESOLVED_ACTION)
    return { reason: text, ...(attestEvidence ? { evidenceAttestationReason: text } : {}) };
  if (attestEvidence)
    throw new Error('Evidence attestation requires a publication approval action.');
  return {};
}

export function isValidEvidenceAttestationReason(reason: unknown): reason is string {
  return typeof reason === 'string' && reason.trim().length > 0;
}

/**
 * Human override action surfaced on the publish gate when staleness is caused
 * purely by evidence/subject drift while the reviewed HEAD still matches the
 * prepared package. Carries the prior pass verdict forward instead of forcing a
 * needless re-review. Never offered when the reviewed code actually changed.
 */
export const APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION = 'approve-publish-evidence-refresh';

/** Explicit human escape when the slot disappeared before its diff snapshot could be recaptured. */
export const APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION = 'approve-publish-snapshot-unavailable';

/**
 * Action ids that approve a local-first publication at the human ready/publish
 * gate. Shared so the engine loop exit, finalize guard, decision replay, the
 * resolve freshness check and every client guard recognize the same set rather
 * than scattering string literals that drift apart.
 */
export const PUBLISH_APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  APPROVE_PUBLISH_ACTION,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  'ready',
]);

export function isPublishApprovalAction(actionId: string | null | undefined): boolean {
  return PUBLISH_APPROVAL_ACTIONS.has(actionId ?? '');
}
