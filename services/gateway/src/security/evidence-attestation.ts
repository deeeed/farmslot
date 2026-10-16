import {
  type EvidenceAttestationApprover,
  type EvidenceAttestationAuthority,
  Methods,
  type ProjectVisualClaimReviewPolicy,
  type RecipeVisualJudgmentKind,
  type RecipeVisualReviewer,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import type { GatewayAuthRuntime, GatewayAuthSession } from './auth.js';
import { authorizeGatewayMethod } from './authorization.js';

/** Re-resolve active credentials/roles each time; virtual loopback identity is insufficient. */
export function authorizeEvidenceAttestation(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): EvidenceAttestationApprover {
  const principal = authorizeGatewayMethod(runtime, session, Methods.RUN_RESOLVE_DECISION);
  if (session.authentication?.kind !== 'person-session' || principal.subject.type !== 'person') {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Evidence attestation requires an active person device session with publish authority.',
      {
        userAction: 'Sign in with a current client as a person admin before attesting.',
      },
    );
  }
  return {
    principalId: principal.id,
    displayName: principal.subject.displayName,
    ...receiptAuthority(session.authentication),
  };
}

/** Visual delegation uses its own principal; publication attestation remains person-only. */
export function authorizeVisualClaimReview(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
  kind: RecipeVisualJudgmentKind,
  policy?: ProjectVisualClaimReviewPolicy,
): RecipeVisualReviewer {
  const principal = authorizeGatewayMethod(runtime, session, Methods.RUN_REVIEW_VISUAL_CLAIM);
  const delegated = kind === 'lead-agent-reviewed';
  if (
    session.authentication?.kind !== (delegated ? 'credential' : 'person-session') ||
    principal.id === 'legacy-env' ||
    principal.subject.type !== (delegated ? 'service' : 'person') ||
    kind === 'pipeline-reviewed' ||
    (delegated && !policy?.delegatedReviewerPrincipalIds?.includes(principal.id))
  )
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      "Visual review requires the authorized reviewer's own active credential.",
    );
  const delegator =
    delegated && policy?.delegatorPrincipalId
      ? runtime.store.findPrincipal(policy.delegatorPrincipalId)
      : undefined;
  if (delegated && (!delegator || delegator.subject.type !== 'person'))
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Delegated visual review requires an identified person delegator.',
    );
  return {
    principalId: principal.id,
    displayName: principal.subject.displayName,
    ...receiptAuthority(session.authentication),
    subjectKind: delegated ? 'service' : 'person',
    ...(delegator
      ? { delegator: { principalId: delegator.id, displayName: delegator.subject.displayName } }
      : {}),
  };
}

function receiptAuthority(
  authentication: NonNullable<GatewayAuthSession['authentication']>,
): EvidenceAttestationAuthority {
  return authentication.kind === 'credential'
    ? { credentialId: authentication.credentialId }
    : { personSessionId: authentication.sessionId };
}
