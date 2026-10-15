import { activePersonAccess, parsePersonSessionToken } from '@farmslot/credential-store';
import type { AuthenticationRef, GatewayAuthClientKind, Principal } from '@farmslot/protocol';

import type { GatewayAuthSession } from './auth.js';
import { parseCredentialWire, verifySecret } from './credential-secret.js';
import type { CredentialStoreRuntime } from './credential-store.js';
import { VerificationCache } from './verification-cache.js';

export type PrincipalResolution =
  | { ok: true; principal: Principal; authentication?: AuthenticationRef }
  | {
      ok: false;
      reason:
        | 'no_credential'
        | 'revoked'
        | 'missing_principal'
        | 'secret_mismatch'
        | 'generation_mismatch'
        | 'person_session_required'
        | 'session_ended';
    };

export interface PrincipalResolverFacts {
  bindIsLoopbackOnly: boolean;
  trustProxyHeaders: boolean;
  machine: string;
}

export class PrincipalResolver {
  readonly verificationCache = new VerificationCache<AuthenticationRef>();

  constructor(
    readonly store: CredentialStoreRuntime,
    private facts: PrincipalResolverFacts,
    private readonly now = Date.now,
  ) {
    store.onChange(() => this.verificationCache.clear());
  }

  setFacts(facts: PrincipalResolverFacts): void {
    this.facts = facts;
  }

  isSoloMode(): boolean {
    return (
      !this.store.isActivated() && this.facts.bindIsLoopbackOnly && !this.facts.trustProxyHeaders
    );
  }

  resolveSecret(presented: string, transport: 'token' | 'password'): PrincipalResolution {
    this.store.ensureFresh();
    if (transport !== 'token') return { ok: false, reason: 'secret_mismatch' };
    const cached = this.verificationCache.get(presented);
    if (cached) return this.resolveAuthenticationReference(cached);
    const store = this.store.snapshot();
    const credentialWire = parseCredentialWire(presented);
    const accessWire = parsePersonSessionToken(presented, 'fsa');
    let reference: AuthenticationRef;
    if (credentialWire) {
      const credential = store.credentials.find(
        (record) => record.id === credentialWire.credentialId,
      );
      if (!credential) return { ok: false, reason: 'secret_mismatch' };
      if (credential.revokedAt !== null) return { ok: false, reason: 'revoked' };
      if (!verifySecret(credentialWire.secret, credential.secret))
        return { ok: false, reason: 'secret_mismatch' };
      reference = { kind: 'credential', credentialId: credential.id };
    } else if (accessWire) {
      const active = activePersonAccess(store, accessWire.id, this.now());
      if (!active) return { ok: false, reason: 'session_ended' };
      if (!verifySecret(accessWire.secret, active.access.secret))
        return { ok: false, reason: 'secret_mismatch' };
      reference = {
        kind: 'person-session',
        sessionId: active.session.id,
        accessId: active.access.id,
      };
    } else return { ok: false, reason: 'secret_mismatch' };
    const resolved = this.resolveAuthenticationReference(reference);
    if (resolved.ok) this.verificationCache.set(presented, reference);
    return resolved;
  }

  resolveSessionPrincipal(session: GatewayAuthSession): PrincipalResolution {
    this.store.ensureFresh();
    if (session.authentication) return this.resolveAuthenticationReference(session.authentication);
    if (this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal(session.clientKind ?? 'ui') };
    }
    return { ok: false, reason: 'no_credential' };
  }

  resolvePrincipalId(principalId: string, generation = 0): PrincipalResolution {
    this.store.ensureFresh();
    if (principalId === 'local-admin' && this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal('ui') };
    }
    if (principalId === 'local-node' && this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal('node') };
    }
    const principal = this.store.findPrincipal(principalId);
    // An id-only stored reference belongs to the original identity. It must
    // not adopt replacement authority after an explicit retired-id reuse.
    if (principal && (principal.generation ?? 0) !== generation)
      return { ok: false, reason: 'generation_mismatch' };
    return principal ? { ok: true, principal } : { ok: false, reason: 'missing_principal' };
  }

  private resolveAuthenticationReference(reference: AuthenticationRef): PrincipalResolution {
    // Resolve identity and authority from one projection, including across id reuse.
    const store = this.store.snapshot();
    if (reference.kind === 'person-session') {
      const active = activePersonAccess(store, reference.accessId, this.now());
      if (!active || active.session.id !== reference.sessionId)
        return { ok: false, reason: 'session_ended' };
      const principal = store.principals.find((record) => record.id === active.session.principalId);
      return principal
        ? { ok: true, principal, authentication: reference }
        : { ok: false, reason: 'missing_principal' };
    }
    const credential = store.credentials.find((record) => record.id === reference.credentialId);
    if (!credential) return { ok: false, reason: 'secret_mismatch' };
    if (credential.revokedAt !== null) return { ok: false, reason: 'revoked' };
    const principal = store.principals.find((record) => record.id === credential.principalId);
    if (!principal) return { ok: false, reason: 'missing_principal' };
    if (principal.subject.type === 'person')
      return { ok: false, reason: 'person_session_required' };
    return { ok: true, principal, authentication: reference };
  }

  private virtualPrincipal(clientKind: GatewayAuthClientKind): Principal {
    if (clientKind === 'node') {
      return {
        id: 'local-node',
        subject: {
          type: 'node',
          displayName: this.facts.machine,
          machine: this.facts.machine,
        },
        roles: [],
      };
    }
    return {
      id: 'local-admin',
      subject: { type: 'person', displayName: 'local' },
      roles: [{ role: 'admin', scope: { kind: 'global' } }],
    };
  }
}

export function systemWorkPrincipal(): Principal {
  return {
    id: 'system',
    subject: { type: 'service', displayName: 'system' },
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  };
}
