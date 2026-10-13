import { type EvidenceAttestationApprover, Methods } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import type { GatewayAuthRuntime, GatewayAuthSession } from './auth.js';
import { authorizeGatewayMethod } from './authorization.js';

/** Re-resolve active credentials/roles each time; virtual loopback identity is insufficient. */
export function authorizeEvidenceAttestation(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): EvidenceAttestationApprover {
  const principal = authorizeGatewayMethod(runtime, session, Methods.RUN_RESOLVE_DECISION);
  if (session.authentication?.kind !== 'credential' || principal.subject.type !== 'person') {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Evidence attestation requires a credential-backed person with publish authority.',
      {
        userAction: 'Authenticate with an active person admin credential before attesting.',
      },
    );
  }
  return {
    principalId: principal.id,
    displayName: principal.subject.displayName,
    credentialId: session.authentication.credentialId,
  };
}
