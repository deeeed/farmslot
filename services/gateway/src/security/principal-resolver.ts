import type { AuthenticationRef, GatewayAuthClientKind, Principal } from '@farmslot/protocol';

import type { GatewayAuthSession } from './auth.js';
import { parseCredentialWire, verifySecret } from './credential-secret.js';
import type { CredentialStoreRuntime } from './credential-store.js';
import { VerificationCache } from './verification-cache.js';

export type PrincipalResolution =
  | { ok: true; principal: Principal; authentication?: AuthenticationRef }
  | {
      ok: false;
      reason: 'no_credential' | 'revoked' | 'missing_principal' | 'secret_mismatch';
    };

export interface PrincipalResolverFacts {
  bindIsLoopbackOnly: boolean;
  trustProxyHeaders: boolean;
  machine: string;
}

export class PrincipalResolver {
  readonly verificationCache = new VerificationCache();

  constructor(
    readonly store: CredentialStoreRuntime,
    private facts: PrincipalResolverFacts,
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
    const parsed = parseCredentialWire(presented);
    if (transport !== 'token' || !parsed) return { ok: false, reason: 'secret_mismatch' };
    const cachedCredentialId = this.verificationCache.get(presented);
    if (cachedCredentialId) return this.resolveCredentialReference(cachedCredentialId);

    const credential = this.store.findCredential(parsed.credentialId);
    if (!credential) return { ok: false, reason: 'secret_mismatch' };
    const resolved = this.resolveCredentialReference(credential.id);
    if (!resolved.ok) return resolved;
    if (!verifySecret(parsed.secret, credential.secret)) {
      return { ok: false, reason: 'secret_mismatch' };
    }
    this.verificationCache.set(presented, credential.id);
    return resolved;
  }

  resolveSessionPrincipal(session: GatewayAuthSession): PrincipalResolution {
    this.store.ensureFresh();
    if (session.authentication?.kind === 'credential') {
      return this.resolveCredentialReference(session.authentication.credentialId);
    }
    if (this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal(session.clientKind ?? 'ui') };
    }
    return { ok: false, reason: 'no_credential' };
  }

  resolvePrincipalId(principalId: string): PrincipalResolution {
    this.store.ensureFresh();
    if (principalId === 'local-admin' && this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal('ui') };
    }
    if (principalId === 'local-node' && this.isSoloMode()) {
      return { ok: true, principal: this.virtualPrincipal('node') };
    }
    const principal = this.store.findPrincipal(principalId);
    return principal ? { ok: true, principal } : { ok: false, reason: 'missing_principal' };
  }

  private resolveCredentialReference(credentialId: string): PrincipalResolution {
    const credential = this.store.findCredential(credentialId);
    if (!credential) return { ok: false, reason: 'secret_mismatch' };
    if (credential.revokedAt !== null) return { ok: false, reason: 'revoked' };
    const principal = this.store.findPrincipal(credential.principalId);
    if (!principal) return { ok: false, reason: 'missing_principal' };
    return {
      ok: true,
      principal,
      authentication: { kind: 'credential', credentialId },
    };
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
