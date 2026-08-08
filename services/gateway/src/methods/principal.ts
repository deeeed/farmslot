import type {
  CredentialIssueParams,
  CredentialIssueResult,
  CredentialListParams,
  CredentialListResult,
  CredentialRevokeParams,
  CredentialRevokeResult,
  CredentialSummary,
  PrincipalCreateParams,
  PrincipalCreateResult,
  PrincipalGrantParams,
  PrincipalGrantResult,
  PrincipalListResult,
  PrincipalRevokeRoleParams,
  PrincipalRevokeRoleResult,
  PrincipalSubject,
  RoleBinding,
  RoleScope,
} from '@farmslot/protocol';

import { GatewayInternalError, GatewayMethodError } from '../core/method-error.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import {
  type CredentialRecord,
  CredentialStoreRefusalError,
} from '../security/credential-store.js';

export function principalCreate(
  params: PrincipalCreateParams,
  runtime: GatewayAuthRuntime,
): PrincipalCreateResult {
  const subject = validateSubject(params?.subject);
  const roles = validateRoles(params?.roles);
  return { principal: translateWriterError(() => runtime.writer.createPrincipal(subject, roles)) };
}

export function principalList(runtime: GatewayAuthRuntime): PrincipalListResult {
  return { principals: structuredClone(runtime.store.snapshot().principals) };
}

export function principalGrant(
  params: PrincipalGrantParams,
  runtime: GatewayAuthRuntime,
): PrincipalGrantResult {
  validatePrincipalId(params?.principalId);
  validateRole(params?.role);
  validateScope(params?.scope);
  return {
    principal: translateWriterError(() =>
      runtime.writer.grantRole(params.principalId, params.role, params.scope),
    ),
  };
}

export function principalRevokeRole(
  params: PrincipalRevokeRoleParams,
  runtime: GatewayAuthRuntime,
): PrincipalRevokeRoleResult {
  validatePrincipalId(params?.principalId);
  validateRole(params?.role);
  validateScope(params?.scope);
  return {
    principal: translateWriterError(() =>
      runtime.writer.revokeRole(params.principalId, params.role, params.scope),
    ),
  };
}

export function credentialIssue(
  params: CredentialIssueParams,
  runtime: GatewayAuthRuntime,
): CredentialIssueResult {
  validatePrincipalId(params?.principalId);
  if (typeof params?.displayName !== 'string' || !params.displayName.trim()) {
    throw invalid('credential.issue requires displayName');
  }
  const issue = translateWriterError(() =>
    runtime.writer.issueCredential(params.principalId, params.displayName.trim()),
  );
  return {
    credential: credentialSummary(issue.record),
    secret: issue.secret,
    activationLatched: issue.activationLatched,
    ...(issue.adminGrant
      ? {
          adminGrant: {
            credential: credentialSummary(issue.adminGrant.record),
            secret: issue.adminGrant.secret,
          },
        }
      : {}),
  };
}

export function credentialList(
  params: CredentialListParams,
  runtime: GatewayAuthRuntime,
): CredentialListResult {
  if (params?.includeRevoked !== undefined && typeof params.includeRevoked !== 'boolean') {
    throw invalid('credential.list includeRevoked must be boolean');
  }
  return {
    credentials: runtime.store
      .snapshot()
      .credentials.filter((record) => params?.includeRevoked === true || record.revokedAt === null)
      .map(credentialSummary),
  };
}

export function credentialRevoke(
  params: CredentialRevokeParams,
  runtime: GatewayAuthRuntime,
): CredentialRevokeResult {
  if (typeof params?.credentialId !== 'string' || !params.credentialId) {
    throw invalid('credential.revoke requires credentialId');
  }
  return {
    credential: credentialSummary(
      translateWriterError(() => runtime.writer.revokeCredential(params.credentialId)),
    ),
  };
}

export function credentialSummary(record: CredentialRecord): CredentialSummary {
  return {
    id: record.id,
    principalId: record.principalId,
    displayName: record.displayName,
    origin: record.origin,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function validateSubject(value: unknown): PrincipalSubject {
  if (typeof value !== 'object' || value === null) throw invalid('subject is required');
  const subject = value as Record<string, unknown>;
  if (typeof subject.displayName !== 'string' || !subject.displayName.trim()) {
    throw invalid('subject.displayName is required');
  }
  if (subject.type === 'person' || subject.type === 'service') {
    return { type: subject.type, displayName: subject.displayName.trim() };
  }
  if (subject.type === 'node' && typeof subject.machine === 'string' && subject.machine.trim()) {
    return {
      type: 'node',
      displayName: subject.displayName.trim(),
      machine: subject.machine.trim(),
    };
  }
  throw invalid('subject.type must be person, service, or node (with machine)');
}

function validateRoles(value: unknown): RoleBinding[] {
  if (!Array.isArray(value)) throw invalid('roles is required and must be an array');
  return value.map((binding) => {
    if (typeof binding !== 'object' || binding === null) throw invalid('invalid role binding');
    const candidate = binding as Record<string, unknown>;
    validateRole(candidate.role);
    validateScope(candidate.scope);
    return { role: candidate.role, scope: candidate.scope };
  });
}

function validateRole(value: unknown): asserts value is 'admin' | 'operator' {
  if (value !== 'admin' && value !== 'operator') throw invalid('role must be admin or operator');
}

function validateScope(value: unknown): asserts value is RoleScope {
  if (typeof value !== 'object' || value === null || (value as RoleScope).kind !== 'global') {
    throw invalid('scope is required and must be { kind: global }');
  }
}

function validatePrincipalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw invalid('principalId is required');
}

function translateWriterError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof CredentialStoreRefusalError)) {
      throw new GatewayInternalError('Credential store operation failed', error);
    }
    if (error.diagnostic) console.error(`[credential-store] ${error.diagnostic}`);
    const message = error.message;
    const [headline, ...rest] = message.split('\nNext:');
    throw new GatewayMethodError('CREDENTIAL_STORE_REFUSED', headline, {
      ...(rest.length ? { userAction: rest.join('\nNext:').trim() } : {}),
    });
  }
}

function invalid(message: string): GatewayMethodError {
  return new GatewayMethodError('INVALID_PARAMS', message);
}
