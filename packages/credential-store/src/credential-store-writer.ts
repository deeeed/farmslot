import type { Principal, PrincipalSubject, Role, RoleBinding, RoleScope } from '@farmslot/protocol';

import {
  formatCredentialWire,
  generateCredentialId,
  generateCredentialSecret,
  hashSecret,
  verifySecret,
} from './credential-secret.js';
import {
  activeAdminCredentialCount,
  type CredentialRecord,
  type CredentialStore,
  type CredentialStoreRuntime,
} from './credential-store.js';
import { withCredentialStoreLock } from './credential-store-lock.js';
import { assertNoLiveGatewaysUnlocked } from './gateway-presence.js';

export const VIRTUAL_PRINCIPAL_IDS = ['local-admin', 'local-node', 'system'] as const;

export interface IssuedCredential {
  record: CredentialRecord;
  secret: string;
}

export interface CredentialIssue {
  record: CredentialRecord;
  secret: string;
  adminGrant?: IssuedCredential;
  activationLatched: boolean;
}

export interface EnvironmentCredentialReconciliation {
  credentialId: string;
  created: boolean;
  otherActiveCredentialIds: string[];
}

export class CredentialStoreRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialStoreRefusalError';
  }
}

export function readCredentialStoreOffline(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  return withCredentialStoreLock((store) => ({ next: store, result: structuredClone(store) }), {
    env,
    beforeRead: () => assertNoLiveGatewaysUnlocked(env),
  });
}

export class CredentialStoreWriter {
  constructor(
    private readonly runtime: CredentialStoreRuntime,
    private readonly offline = false,
  ) {}

  createPrincipal(
    subject: PrincipalSubject,
    roles: RoleBinding[],
    requestedId?: string,
  ): Principal {
    validateNodeRoles(subject, roles);
    const result = this.mutate((store) => {
      const id = requestedId ?? uniquePrincipalId(store, subject.displayName);
      if ((VIRTUAL_PRINCIPAL_IDS as readonly string[]).includes(id)) {
        throw new CredentialStoreRefusalError(
          `Principal id '${id}' is reserved for a virtual principal`,
        );
      }
      if (store.principals.some((principal) => principal.id === id)) {
        throw new CredentialStoreRefusalError(`Principal '${id}' already exists`);
      }
      const principal: Principal = {
        id,
        subject: structuredClone(subject),
        roles: cloneRoles(roles),
      };
      return {
        next: { ...store, principals: [...store.principals, principal] },
        result: principal,
      };
    });
    return result;
  }

  grantRole(principalId: string, role: Role, scope: RoleScope): Principal {
    return this.mutate((store) => {
      const principal = requiredPrincipal(store, principalId);
      if (principal.subject.type === 'node') {
        throw new CredentialStoreRefusalError(
          `Node principal '${principalId}' cannot hold role bindings`,
        );
      }
      const binding = { role, scope } satisfies RoleBinding;
      const roles = principal.roles.some((existing) => sameBinding(existing, binding))
        ? principal.roles
        : [...principal.roles, binding];
      const updated = { ...principal, roles };
      return {
        next: replacePrincipal(store, updated),
        result: updated,
      };
    });
  }

  revokeRole(principalId: string, role: Role, scope: RoleScope): Principal {
    return this.mutate((store) => {
      const principal = requiredPrincipal(store, principalId);
      const updated = {
        ...principal,
        roles: principal.roles.filter((binding) => !sameBinding(binding, { role, scope })),
      };
      const next = replacePrincipal(store, updated);
      this.assertAdminRemains(store, next, `principal '${principalId}'`);
      return { next, result: updated };
    });
  }

  issueCredential(
    principalId: string,
    displayName: string,
    origin: CredentialRecord['origin'] = 'issued',
  ): CredentialIssue {
    const rawSecret = generateCredentialSecret();
    return this.issueCredentialWithSecret(principalId, displayName, origin, rawSecret);
  }

  issueCredentialWithSecret(
    principalId: string,
    displayName: string,
    origin: CredentialRecord['origin'],
    rawSecret: string,
  ): CredentialIssue {
    return this.mutate((store) => {
      const principal = requiredPrincipal(store, principalId);
      const now = new Date().toISOString();
      const activationLatched = store.activatedAt === null;
      const issued = buildCredential(principalId, displayName, origin, rawSecret, now);
      let next: CredentialStore = {
        ...store,
        activatedAt: store.activatedAt ?? now,
        credentials: [...store.credentials, issued.record],
      };
      let adminGrant: IssuedCredential | undefined;
      if (!this.offline && activationLatched && activeAdminCredentialCount(next) === 0) {
        const owner = buildOwnerPrincipal(next);
        const ownerSecret = generateCredentialSecret();
        adminGrant = buildCredential(owner.id, 'owner', 'issued', ownerSecret, now);
        next = {
          ...next,
          principals: [...next.principals, owner],
          credentials: [...next.credentials, adminGrant.record],
        };
      }
      if (principal.subject.type === 'node' && principal.roles.length > 0) {
        throw new CredentialStoreRefusalError(
          `Node principal '${principal.id}' cannot hold role bindings`,
        );
      }
      return {
        next,
        result: {
          record: issued.record,
          secret: issued.secret,
          ...(adminGrant ? { adminGrant } : {}),
          activationLatched,
        },
      };
    });
  }

  revokeCredential(credentialId: string): CredentialRecord {
    return this.mutate((store) => {
      const credential = store.credentials.find((record) => record.id === credentialId);
      if (!credential) {
        throw new CredentialStoreRefusalError(`Credential '${credentialId}' does not exist`);
      }
      if (credential.revokedAt !== null) return { next: store, result: credential };
      const revoked = { ...credential, revokedAt: new Date().toISOString() };
      const next = {
        ...store,
        credentials: store.credentials.map((record) =>
          record.id === credentialId ? revoked : record,
        ),
      };
      this.assertAdminRemains(store, next, `credential '${credential.displayName}'`);
      return { next, result: revoked };
    });
  }

  latchActivation(): boolean {
    return this.mutate((store) => {
      if (store.activatedAt !== null) return { next: store, result: false };
      return {
        next: { ...store, activatedAt: new Date().toISOString() },
        result: true,
      };
    });
  }

  reconcileEnvironmentCredential(rawSecret: string): EnvironmentCredentialReconciliation {
    return this.mutate<EnvironmentCredentialReconciliation>((store) => {
      const activeEnvironmentCredentials = store.credentials.filter(
        (credential) => credential.origin === 'env-migrated' && credential.revokedAt === null,
      );
      const matching = activeEnvironmentCredentials.find((credential) =>
        verifySecret(rawSecret, credential.secret),
      );
      if (matching) {
        return {
          next: store,
          result: {
            credentialId: matching.id,
            created: false,
            otherActiveCredentialIds: activeEnvironmentCredentials
              .filter((credential) => credential.id !== matching.id)
              .map((credential) => credential.id),
          },
        };
      }

      const now = new Date().toISOString();
      const principal: Principal = {
        id: uniquePrincipalId(store, 'legacy-env'),
        subject: { type: 'service', displayName: 'legacy-env' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      };
      const issued = buildCredential(principal.id, 'legacy-env', 'env-migrated', rawSecret, now);
      return {
        next: {
          ...store,
          activatedAt: store.activatedAt ?? now,
          principals: [...store.principals, principal],
          credentials: [...store.credentials, issued.record],
        },
        result: {
          credentialId: issued.record.id,
          created: true,
          otherActiveCredentialIds: activeEnvironmentCredentials.map((credential) => credential.id),
        },
      };
    });
  }

  private mutate<T>(fn: (store: CredentialStore) => { next: CredentialStore; result: T }): T {
    const result = withCredentialStoreLock(fn, {
      env: this.runtime.env,
      ...(this.offline ? { beforeRead: () => assertNoLiveGatewaysUnlocked(this.runtime.env) } : {}),
    });
    this.runtime.reloadAfterWrite();
    return result;
  }

  private assertAdminRemains(
    previous: CredentialStore,
    next: CredentialStore,
    target: string,
  ): void {
    if (
      this.offline ||
      activeAdminCredentialCount(previous) === 0 ||
      activeAdminCredentialCount(next) > 0
    ) {
      return;
    }
    throw new CredentialStoreRefusalError(
      `Refusing to revoke ${target}: it is the last active admin credential,\n` +
        'and removing it would leave this gateway with no way to issue or revoke anything.\n' +
        'Next: issue a replacement admin credential first, then revoke this one:\n' +
        '  farmslot credential issue --principal <principal> --name <new-name>\n\n' +
        'A compromised admin credential uses the offline recovery path.\n' +
        'Next: stop every gateway in this identity domain, then run\n' +
        '  farmslot credential revoke <compromised-id> --offline\n' +
        '  farmslot credential issue --principal owner --role admin --scope global --offline\n' +
        'and start them again.',
    );
  }
}

function buildCredential(
  principalId: string,
  displayName: string,
  origin: CredentialRecord['origin'],
  rawSecret: string,
  now: string,
): IssuedCredential {
  const id = generateCredentialId();
  return {
    record: {
      id,
      principalId,
      displayName,
      secret: hashSecret(rawSecret),
      origin,
      createdAt: now,
      revokedAt: null,
    },
    secret: origin === 'env-migrated' ? rawSecret : formatCredentialWire(id, rawSecret),
  };
}

function buildOwnerPrincipal(store: CredentialStore): Principal {
  const subject: PrincipalSubject = { type: 'person', displayName: 'owner' };
  return {
    id: uniquePrincipalId(store, subject.displayName),
    subject,
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  };
}

function requiredPrincipal(store: CredentialStore, id: string): Principal {
  const principal = store.principals.find((candidate) => candidate.id === id);
  if (!principal) throw new CredentialStoreRefusalError(`Principal '${id}' does not exist`);
  return principal;
}

function replacePrincipal(store: CredentialStore, principal: Principal): CredentialStore {
  return {
    ...store,
    principals: store.principals.map((candidate) =>
      candidate.id === principal.id ? principal : candidate,
    ),
  };
}

function uniquePrincipalId(store: CredentialStore, displayName: string): string {
  const base =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'principal';
  if ((VIRTUAL_PRINCIPAL_IDS as readonly string[]).includes(base)) {
    throw new CredentialStoreRefusalError(
      `Principal id '${base}' is reserved for a virtual principal`,
    );
  }
  let candidate = base;
  let suffix = 2;
  while (store.principals.some((principal) => principal.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function validateNodeRoles(subject: PrincipalSubject, roles: RoleBinding[]): void {
  if (subject.type === 'node' && roles.length > 0) {
    throw new CredentialStoreRefusalError('Node principals must be created with roles: []');
  }
}

function sameBinding(a: RoleBinding, b: RoleBinding): boolean {
  return a.role === b.role && a.scope.kind === b.scope.kind;
}

function cloneRoles(roles: RoleBinding[]): RoleBinding[] {
  return roles.map((binding) => ({ role: binding.role, scope: { kind: binding.scope.kind } }));
}
