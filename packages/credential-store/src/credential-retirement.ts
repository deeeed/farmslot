import { readFileSync } from 'node:fs';

import {
  activeAdminCredentialCount,
  type CredentialStore,
  credentialStorePath,
  migrateCredentialStoreVersion,
  saveCredentialStore,
  validateCredentialStore,
  VIRTUAL_PRINCIPAL_IDS,
} from './credential-store.js';
import { CredentialStoreRefusalError, withCredentialLock } from './credential-store-lock.js';
import { assertNoLiveGatewaysUnlocked } from './gateway-presence.js';

export interface PrincipalRetirement {
  principalIds: string[];
  credentialIds: string[];
}

interface RetirementTransaction {
  next: CredentialStore;
  result: PrincipalRetirement;
}

/** Explicit cutover, never a runtime loader or an authentication strategy. */
export function retirePrincipalsOffline(
  principalIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): PrincipalRetirement {
  return withCredentialLock(() => {
    assertNoLiveGatewaysUnlocked(env);
    const path = credentialStorePath(env);
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Unable to load credential store ${path}: not valid JSON`);
    }
    const { next, result } = retireSelectedPrincipals(input, principalIds, path);
    saveCredentialStore(next, path);
    return result;
  }, env);
}

/** Both online and offline writers share these retirement checks. */
export function retireSelectedPrincipals(
  input: unknown,
  principalIds: string[],
  path: string,
): RetirementTransaction {
  if (
    !Array.isArray(principalIds) ||
    principalIds.length === 0 ||
    principalIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(principalIds).size !== principalIds.length
  )
    throw new CredentialStoreRefusalError('Retirement requires distinct, nonempty principal ids');
  if (principalIds.some((id) => (VIRTUAL_PRINCIPAL_IDS as readonly string[]).includes(id)))
    throw new CredentialStoreRefusalError('Virtual principals cannot be retired');
  if (
    !isRecord(input) ||
    (input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
    !Array.isArray(input.principals) ||
    !Array.isArray(input.credentials)
  )
    throw new CredentialStoreRefusalError(`Invalid credential store ${path}`);

  const selected = new Set(principalIds);
  for (const id of selected) {
    const records = input.principals.filter(
      (principal) => isRecord(principal) && principal.id === id,
    );
    if (records.length !== 1)
      throw new CredentialStoreRefusalError(`Principal '${id}' must exist exactly once`);
  }
  const credentials = input.credentials.filter(
    (record) =>
      isRecord(record) &&
      typeof record.principalId === 'string' &&
      selected.has(record.principalId),
  );
  const credentialIds = credentials.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.id !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(record.id) ||
      typeof record.revokedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.revokedAt) ||
      Number.isNaN(Date.parse(record.revokedAt))
    )
      throw new CredentialStoreRefusalError('Revoke every selected credential before retirement');
    return record.id;
  });
  if (new Set(credentialIds).size !== credentialIds.length)
    throw new CredentialStoreRefusalError('Selected credentials have duplicate ids');

  const principals = input.principals.filter(
    (principal) =>
      !isRecord(principal) || typeof principal.id !== 'string' || !selected.has(principal.id),
  );
  for (const principal of principals) {
    if (
      isRecord(principal) &&
      isRecord(principal.subject) &&
      typeof principal.subject.nativeOwnerPrincipalId === 'string' &&
      selected.has(principal.subject.nativeOwnerPrincipalId)
    )
      throw new CredentialStoreRefusalError('Retire or re-enroll bound nodes before their owner');
  }
  const next: unknown = {
    ...migrateCredentialStoreVersion(input),
    principals,
    credentials: input.credentials.filter((record) => !credentials.includes(record)),
    retiredPrincipalIds: [...retiredIds(input.retiredPrincipalIds), ...principalIds],
    retiredCredentialIds: [...retiredIds(input.retiredCredentialIds), ...credentialIds],
  };
  validateCredentialStore(next, path);
  if (activeAdminCredentialCount(next) === 0)
    throw new CredentialStoreRefusalError(
      'Retirement requires an active surviving admin credential',
    );
  return { next, result: { principalIds: [...principalIds], credentialIds } };
}

function retiredIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim()))
    throw new CredentialStoreRefusalError('Invalid retirement tombstones');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
