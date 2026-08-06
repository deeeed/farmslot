import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { Principal, PrincipalSubject, RoleBinding } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { isCredentialStoreLockHeld } from './credential-lock-state.js';

export interface CredentialRecord {
  id: string;
  principalId: string;
  displayName: string;
  secret: StoredSecret;
  origin: 'issued' | 'paired' | 'env-migrated';
  createdAt: string;
  revokedAt: string | null;
}

export interface StoredSecret {
  scheme: 'scrypt-v1';
  salt: string;
  hash: string;
}

export interface CredentialStore {
  schemaVersion: 1;
  activatedAt: string | null;
  principals: Principal[];
  credentials: CredentialRecord[];
}

export interface CredentialStoreChange {
  revokedCredentialIds: string[];
  changedPrincipalIds: string[];
  activationLatched: boolean;
}

interface FreshnessStamp {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

export function credentialStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(farmslotHome(env), 'credentials.json');
}

export function emptyCredentialStore(): CredentialStore {
  return { schemaVersion: 1, activatedAt: null, principals: [], credentials: [] };
}

export function loadCredentialStore(path = credentialStorePath()): CredentialStore {
  if (!existsSync(path)) return emptyCredentialStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load credential store ${path}: ${(error as Error).message}`);
  }
  validateCredentialStore(parsed, path);
  return parsed;
}

export function saveCredentialStore(store: CredentialStore, path = credentialStorePath()): void {
  const lockPath = join(dirname(path), 'credentials.lock');
  if (!isCredentialStoreLockHeld(lockPath)) {
    throw new Error(`Refusing to write credential store ${path} without credentials.lock`);
  }
  validateCredentialStore(store, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function activeAdminCredentialCount(store: CredentialStore): number {
  const principals = new Map(store.principals.map((principal) => [principal.id, principal]));
  return store.credentials.filter((credential) => {
    if (credential.revokedAt !== null) return false;
    const principal = principals.get(credential.principalId);
    return principal?.roles.some(isGlobalAdminBinding) ?? false;
  }).length;
}

export function isGlobalAdminBinding(binding: RoleBinding): boolean {
  return binding.role === 'admin' && binding.scope.kind === 'global';
}

export class CredentialStoreRuntime {
  readonly path: string;
  private projection: CredentialStore;
  private stamp: FreshnessStamp | null;
  private readonly listeners = new Set<(change: CredentialStoreChange) => void>();

  constructor(readonly env: NodeJS.ProcessEnv = process.env) {
    this.path = credentialStorePath(env);
    this.projection = loadCredentialStore(this.path);
    this.stamp = readStamp(this.path);
  }

  ensureFresh(): void {
    const nextStamp = readStamp(this.path);
    if (stampsEqual(this.stamp, nextStamp)) return;
    const previous = this.projection;
    this.projection = loadCredentialStore(this.path);
    this.stamp = nextStamp;
    this.emit(diffStores(previous, this.projection));
  }

  reloadAfterWrite(): void {
    const previous = this.projection;
    this.projection = loadCredentialStore(this.path);
    this.stamp = readStamp(this.path);
    this.emit(diffStores(previous, this.projection));
  }

  snapshot(): CredentialStore {
    this.ensureFresh();
    return this.projection;
  }

  findCredential(credentialId: string): CredentialRecord | undefined {
    this.ensureFresh();
    return this.projection.credentials.find((credential) => credential.id === credentialId);
  }

  findPrincipal(principalId: string): Principal | undefined {
    this.ensureFresh();
    return this.projection.principals.find((principal) => principal.id === principalId);
  }

  isActivated(): boolean {
    this.ensureFresh();
    return this.projection.activatedAt !== null;
  }

  onChange(listener: (change: CredentialStoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: CredentialStoreChange): void {
    if (
      !change.activationLatched &&
      change.revokedCredentialIds.length === 0 &&
      change.changedPrincipalIds.length === 0
    ) {
      return;
    }
    for (const listener of this.listeners) listener(change);
  }
}

function validateCredentialStore(value: unknown, path: string): asserts value is CredentialStore {
  if (!isRecord(value)) fail(path, 'expected an object');
  if (value.schemaVersion !== 1) {
    fail(path, `unsupported schemaVersion ${String(value.schemaVersion)}`);
  }
  if (value.activatedAt !== null && typeof value.activatedAt !== 'string') {
    fail(path, 'activatedAt must be an ISO-8601 string or null');
  }
  if (typeof value.activatedAt === 'string' && !isIsoUtc(value.activatedAt)) {
    fail(path, 'activatedAt must be an ISO-8601 UTC string');
  }
  if (!Array.isArray(value.principals) || !Array.isArray(value.credentials)) {
    fail(path, 'principals and credentials must be arrays');
  }
  value.principals.forEach((principal, index) => validatePrincipal(principal, path, index));
  value.credentials.forEach((credential, index) => validateCredential(credential, path, index));
  assertUniqueIds(value.principals, path, 'principal');
  assertUniqueIds(value.credentials, path, 'credential');
}

function validatePrincipal(
  value: unknown,
  path: string,
  index: number,
): asserts value is Principal {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !Array.isArray(value.roles)
  ) {
    fail(path, `principal[${index}] is invalid`);
  }
  if (value.id === 'local-admin' || value.id === 'local-node' || value.id === 'system') {
    fail(path, `principal[${index}] uses reserved virtual id '${value.id}'`);
  }
  validateSubject(value.subject, path, index);
  value.roles.forEach((binding, bindingIndex) => {
    if (
      !isRecord(binding) ||
      (binding.role !== 'admin' && binding.role !== 'operator') ||
      !isRecord(binding.scope) ||
      binding.scope.kind !== 'global'
    ) {
      fail(path, `principal[${index}].roles[${bindingIndex}] is invalid`);
    }
  });
  if (value.subject.type === 'node' && value.roles.length > 0) {
    fail(path, `principal[${index}] is a node subject and must have roles: []`);
  }
}

function validateSubject(
  value: unknown,
  path: string,
  index: number,
): asserts value is PrincipalSubject {
  if (!isRecord(value) || typeof value.displayName !== 'string') {
    fail(path, `principal[${index}].subject is invalid`);
  }
  if (value.type === 'person' || value.type === 'service') return;
  if (value.type === 'node' && typeof value.machine === 'string' && value.machine.length > 0)
    return;
  fail(path, `principal[${index}].subject has an unknown or incomplete type`);
}

function validateCredential(
  value: unknown,
  path: string,
  index: number,
): asserts value is CredentialRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.principalId !== 'string' ||
    typeof value.displayName !== 'string' ||
    (value.origin !== 'issued' && value.origin !== 'paired' && value.origin !== 'env-migrated') ||
    typeof value.createdAt !== 'string' ||
    !isIsoUtc(value.createdAt) ||
    (value.revokedAt !== null &&
      (typeof value.revokedAt !== 'string' || !isIsoUtc(value.revokedAt))) ||
    !isRecord(value.secret) ||
    value.secret.scheme !== 'scrypt-v1' ||
    typeof value.secret.salt !== 'string' ||
    typeof value.secret.hash !== 'string'
  ) {
    fail(path, `credential[${index}] is invalid`);
  }
}

function readStamp(path: string): FreshnessStamp | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

function stampsEqual(a: FreshnessStamp | null, b: FreshnessStamp | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.mtimeMs === b.mtimeMs &&
      a.size === b.size)
  );
}

function diffStores(previous: CredentialStore, next: CredentialStore): CredentialStoreChange {
  const previousCredentials = new Map(previous.credentials.map((record) => [record.id, record]));
  const previousPrincipals = new Map(
    previous.principals.map((principal) => [principal.id, principal]),
  );
  return {
    revokedCredentialIds: next.credentials
      .filter(
        (record) =>
          record.revokedAt !== null && previousCredentials.get(record.id)?.revokedAt === null,
      )
      .map((record) => record.id),
    changedPrincipalIds: next.principals
      .filter(
        (principal) =>
          JSON.stringify(previousPrincipals.get(principal.id)?.roles ?? null) !==
          JSON.stringify(principal.roles),
      )
      .map((principal) => principal.id),
    activationLatched: previous.activatedAt === null && next.activatedAt !== null,
  };
}

function isIsoUtc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUniqueIds(
  records: Array<{ id: string }>,
  path: string,
  kind: 'principal' | 'credential',
): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) fail(path, `duplicate ${kind} id '${record.id}'`);
    seen.add(record.id);
  }
}

function fail(path: string, detail: string): never {
  throw new Error(`Invalid credential store ${path}: ${detail}`);
}
