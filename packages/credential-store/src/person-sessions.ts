import {
  PERSON_DEVICE_KINDS,
  type PersonDeviceDescription,
  type PersonDeviceSession,
  type PersonSessionGrant,
} from '@farmslot/protocol';

import {
  generateCredentialId,
  generateCredentialSecret,
  hashSecret,
  parseCredentialWire,
  verifySecret,
} from './credential-secret.js';
import type { CredentialStore, StoredSecret } from './credential-store.js';
import { CredentialStoreRefusalError } from './credential-store-lock.js';

export const PERSON_ACCESS_LIFETIME_MS = 60 * 60 * 1000;
export const PERSON_REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface PersonSessionRecord extends PersonDeviceSession {
  refreshSecret: StoredSecret;
  sourceCredentialId?: string;
}

export interface PersonAccessRecord {
  id: string;
  sessionId: string;
  secret: StoredSecret;
  createdAt: string;
  expiresAt: string;
}

/** Gateway-owned authentication context, never accepted from RPC params. */
export interface PersonSessionAuthority {
  principalId: string;
  principalGeneration: number;
  sessionId: string;
  accessId: string;
}

export interface PersonSessionMutation<T> {
  next: CredentialStore;
  result: T;
}

export function parsePersonSessionToken(
  value: string,
  kind: 'fsa' | 'fsr',
): { id: string; secret: string } | null {
  const match = /^(fsa|fsr)_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/u.exec(value);
  return match?.[1] === kind ? { id: match[2], secret: match[3] } : null;
}

/** Hashes and source credentials never enter the public device listing. */
export function personSessionInfo(record: PersonSessionRecord): PersonDeviceSession {
  return {
    id: record.id,
    principalId: record.principalId,
    principalGeneration: record.principalGeneration,
    deviceName: record.deviceName,
    deviceKind: record.deviceKind,
    createdAt: record.createdAt,
    lastRefreshedAt: record.lastRefreshedAt,
    refreshExpiresAt: record.refreshExpiresAt,
    revokedAt: record.revokedAt,
  };
}

export function activePersonSession(
  store: CredentialStore,
  id: string,
  now: number,
): PersonSessionRecord | undefined {
  const record = store.personSessions.find((session) => session.id === id);
  if (!record || record.revokedAt !== null || Date.parse(record.refreshExpiresAt) <= now)
    return undefined;
  const principal = store.principals.find((candidate) => candidate.id === record.principalId);
  if (
    principal?.subject.type !== 'person' ||
    (principal.generation ?? 0) !== record.principalGeneration
  )
    return undefined;
  if (record.sourceCredentialId) {
    const source = store.credentials.find(
      (credential) => credential.id === record.sourceCredentialId,
    );
    if (!source || source.revokedAt !== null || source.principalId !== record.principalId)
      return undefined;
  }
  return record;
}

export function activePersonAccess(store: CredentialStore, accessId: string, now: number) {
  const access = store.personAccessTokens.find((record) => record.id === accessId);
  if (!access || Date.parse(access.expiresAt) <= now) return undefined;
  const session = activePersonSession(store, access.sessionId, now);
  return session ? { access, session } : undefined;
}

export function listPersonSessions(
  store: CredentialStore,
  actor: PersonSessionAuthority,
  now: number,
): PersonDeviceSession[] {
  assertPersonSessionAuthority(store, actor, now);
  return store.personSessions
    .filter(
      (record) =>
        record.principalId === actor.principalId &&
        record.principalGeneration === actor.principalGeneration,
    )
    .map(personSessionInfo);
}

export function exchangePersonCredential(
  store: CredentialStore,
  credential: string,
  device: PersonDeviceDescription,
  now: number,
): PersonSessionMutation<PersonSessionGrant> {
  const parsed = parseCredentialWire(credential);
  const source = parsed && store.credentials.find((record) => record.id === parsed.credentialId);
  if (
    !source ||
    source.revokedAt !== null ||
    !parsed ||
    !verifySecret(parsed.secret, source.secret)
  )
    throw new CredentialStoreRefusalError('Person sign-in failed.', 'AUTH_FAILED');
  const principal = store.principals.find((candidate) => candidate.id === source.principalId);
  if (principal?.subject.type !== 'person')
    throw new CredentialStoreRefusalError(
      'Use a person credential for this sign-in.',
      'AUTH_PERSON_REQUIRED',
    );
  return issuePersonSession(store, principal.id, principal.generation ?? 0, device, now, source.id);
}

/** Pairing supplies the identity generation captured by the invitation, never an RPC caller. */
export function issuePersonSession(
  store: CredentialStore,
  principalId: string,
  generation: number,
  device: PersonDeviceDescription,
  now: number,
  sourceCredentialId?: string,
): PersonSessionMutation<PersonSessionGrant> {
  const principal = store.principals.find((candidate) => candidate.id === principalId);
  if (principal?.subject.type !== 'person' || (principal.generation ?? 0) !== generation)
    throw new CredentialStoreRefusalError('Pairing identity is no longer valid.', 'AUTH_FAILED');
  const deviceName = device.deviceName.trim();
  if (!deviceName || deviceName.length > 128 || !PERSON_DEVICE_KINDS.includes(device.deviceKind))
    throw new CredentialStoreRefusalError(
      'Choose a device name and supported device kind.',
      'INVALID_PARAMS',
    );
  const id = uniqueId(store.personSessions);
  const secret = generateCredentialSecret();
  const timestamp = new Date(now).toISOString();
  const session: PersonSessionRecord = {
    id,
    principalId,
    principalGeneration: generation,
    deviceName,
    deviceKind: device.deviceKind,
    createdAt: timestamp,
    lastRefreshedAt: timestamp,
    refreshExpiresAt: new Date(now + PERSON_REFRESH_LIFETIME_MS).toISOString(),
    revokedAt: null,
    refreshSecret: hashSecret(secret),
    ...(sourceCredentialId ? { sourceCredentialId } : {}),
  };
  return grantAccess(
    { ...store, personSessions: [...store.personSessions, session] },
    session,
    'fsr_' + id + '_' + secret,
    now,
  );
}

export function refreshPersonSession(
  store: CredentialStore,
  refreshToken: string,
  now: number,
): PersonSessionMutation<PersonSessionGrant> {
  const parsed = parsePersonSessionToken(refreshToken, 'fsr');
  const record = parsed && activePersonSession(store, parsed.id, now);
  if (!record || !parsed || !verifySecret(parsed.secret, record.refreshSecret)) throw ended();
  const session: PersonSessionRecord = {
    ...record,
    lastRefreshedAt: new Date(now).toISOString(),
    refreshExpiresAt: new Date(now + PERSON_REFRESH_LIFETIME_MS).toISOString(),
  };
  return grantAccess(
    {
      ...store,
      personSessions: store.personSessions.map((item) => (item.id === session.id ? session : item)),
    },
    session,
    refreshToken,
    now,
  );
}

export function revokePersonSession(
  store: CredentialStore,
  actor: PersonSessionAuthority,
  sessionId: string,
  now: number,
): PersonSessionMutation<PersonDeviceSession> {
  assertPersonSessionAuthority(store, actor, now);
  const session = store.personSessions.find((record) => record.id === sessionId);
  if (
    !session ||
    session.principalId !== actor.principalId ||
    session.principalGeneration !== actor.principalGeneration
  )
    throw new CredentialStoreRefusalError(
      'This device does not belong to your person identity.',
      'AUTH_FORBIDDEN',
    );
  if (session.revokedAt !== null) return { next: store, result: personSessionInfo(session) };
  const revoked = { ...session, revokedAt: new Date(now).toISOString() };
  return {
    next: {
      ...store,
      personSessions: store.personSessions.map((record) =>
        record.id === sessionId ? revoked : record,
      ),
    },
    result: personSessionInfo(revoked),
  };
}

function assertPersonSessionAuthority(
  store: CredentialStore,
  actor: PersonSessionAuthority,
  now: number,
): void {
  const current = activePersonAccess(store, actor.accessId, now);
  if (
    !current ||
    current.session.id !== actor.sessionId ||
    current.session.principalId !== actor.principalId ||
    current.session.principalGeneration !== actor.principalGeneration
  )
    throw ended();
}

function grantAccess(
  store: CredentialStore,
  session: PersonSessionRecord,
  refreshToken: string,
  now: number,
): PersonSessionMutation<PersonSessionGrant> {
  const id = uniqueId(store.personAccessTokens);
  const secret = generateCredentialSecret();
  const expiresAt = new Date(now + PERSON_ACCESS_LIFETIME_MS).toISOString();
  const record: PersonAccessRecord = {
    id,
    sessionId: session.id,
    secret: hashSecret(secret),
    createdAt: new Date(now).toISOString(),
    expiresAt,
  };
  return {
    next: {
      ...store,
      personAccessTokens: [
        ...store.personAccessTokens.filter((access) => Date.parse(access.expiresAt) > now),
        record,
      ],
    },
    result: {
      session: personSessionInfo(session),
      refreshToken,
      accessToken: 'fsa_' + id + '_' + secret,
      accessExpiresAt: expiresAt,
    },
  };
}

function uniqueId(records: ReadonlyArray<{ id: string }>): string {
  let id = generateCredentialId();
  while (records.some((record) => record.id === id)) id = generateCredentialId();
  return id;
}

function ended(): CredentialStoreRefusalError {
  return new CredentialStoreRefusalError(
    'Your device sign-in has expired or was revoked. Sign in again.',
    'AUTH_SESSION_ENDED',
  );
}
