import { activePersonAccess, parsePersonSessionToken } from '@farmslot/credential-store';
import type { AuthenticationRef, GatewayAuthClientKind, Principal } from '@farmslot/protocol';

import type { GatewayAuthSession } from './auth.js';
import { parseCredentialWire, sameStoredSecret, verifySecretAsync } from './credential-secret.js';
import type { CredentialStoreRuntime, StoredSecret } from './credential-store.js';
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

/**
 * A record bound to an identity that an explicit id reuse replaced. Distinct
 * from revocation: the record still belongs to that identity, and the named
 * action re-creates it for the replacement.
 */
export function generationMismatchMessage(principalId: string, action: string): string {
  return `${principalId} has been replaced by a newer identity at the same id; ${action}`;
}

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

  /**
   * scrypt runs off the event loop, so the store can change while it derives. The reference is
   * then resolved from the store as it is afterwards, and only while the verified hash is still
   * the stored one, so a revocation or a reused id during the wait is not missed.
   */
  async resolveSecret(
    presented: string,
    transport: 'token' | 'password',
  ): Promise<PrincipalResolution> {
    this.store.ensureFresh();
    if (transport !== 'token') return { ok: false, reason: 'secret_mismatch' };
    const cached = this.verificationCache.get(presented);
    if (cached) return this.resolveAuthenticationReference(cached);
    const store = this.store.snapshot();
    const credentialWire = parseCredentialWire(presented);
    const accessWire = parsePersonSessionToken(presented, 'fsa');
    let reference: AuthenticationRef;
    let verified: StoredSecret;
    if (credentialWire) {
      const credential = store.credentials.find(
        (record) => record.id === credentialWire.credentialId,
      );
      if (!credential) return { ok: false, reason: 'secret_mismatch' };
      if (credential.revokedAt !== null) return { ok: false, reason: 'revoked' };
      if (!(await verifySecretAsync(credentialWire.secret, credential.secret)))
        return { ok: false, reason: 'secret_mismatch' };
      reference = { kind: 'credential', credentialId: credential.id };
      verified = credential.secret;
    } else if (accessWire) {
      const active = activePersonAccess(store, accessWire.id, this.now());
      if (!active) return { ok: false, reason: 'session_ended' };
      if (!(await verifySecretAsync(accessWire.secret, active.access.secret)))
        return { ok: false, reason: 'secret_mismatch' };
      reference = {
        kind: 'person-session',
        sessionId: active.session.id,
        accessId: active.access.id,
      };
      verified = active.access.secret;
    } else return { ok: false, reason: 'secret_mismatch' };
    this.store.ensureFresh(true);
    const current = this.storedSecret(reference);
    if (current && !sameStoredSecret(current, verified))
      return { ok: false, reason: 'secret_mismatch' };
    const resolved = this.resolveAuthenticationReference(reference);
    if (resolved.ok) this.verificationCache.set(presented, reference);
    return resolved;
  }

  /** The hash a reference's secret is stored under now; missing records fail in resolution. */
  private storedSecret(reference: AuthenticationRef): StoredSecret | undefined {
    const store = this.store.snapshot();
    if (reference.kind === 'credential')
      return store.credentials.find((record) => record.id === reference.credentialId)?.secret;
    return store.personAccessTokens.find((record) => record.id === reference.accessId)?.secret;
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
