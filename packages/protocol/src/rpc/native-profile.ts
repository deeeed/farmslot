export interface NativeAccountObservation {
  runner: string;
  installed: boolean;
  executable?: string;
  version?: string;
  /** Runner-reported state may use cached credentials; it does not prove online token validity. */
  login: 'authenticated' | 'signed-out' | 'unavailable';
  /** Native login channel; not a claim about subscription eligibility or billed cost. */
  mode: 'subscription' | 'api' | 'other' | 'unknown';
  identity?: { subjectId?: string; email?: string; organizationId?: string };
  identityQuality: 'stable-subject' | 'display-only' | 'unavailable';
  observedAt: string;
  reason?:
    | 'not-installed'
    | 'executable-unavailable'
    | 'version-unavailable'
    | 'status-unavailable'
    | 'malformed-status'
    | 'native-auth-unavailable'
    | 'cleanup-unconfirmed';
}

/** Several profiles belong to the trusted operator of one execution node. */
export interface NativeProfileInfo {
  id: string;
  runner: string;
  directory: string;
  /** Binds the registered directory, not its current subscription login. Fresh on re-registration. */
  accountContextId: string;
  state: 'active' | 'retiring';
}

/** A node-local configuration selection. Native login rotation does not change this reference. */
export interface NativeProfileReference {
  executionNodeId: string;
  runner: string;
  profileId: string;
  accountContextId: string;
}

const NATIVE_PROFILE_REFERENCE_FIELDS = [
  'executionNodeId',
  'runner',
  'profileId',
  'accountContextId',
] as const;

export function isNativeProfileReference(value: unknown): value is NativeProfileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    !Object.keys(profile).some(
      (key) => !NATIVE_PROFILE_REFERENCE_FIELDS.some((field) => field === key),
    ) &&
    NATIVE_PROFILE_REFERENCE_FIELDS.every(
      (field) => typeof profile[field] === 'string' && profile[field].trim(),
    ) &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(profile.profileId)) &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(String(profile.accountContextId))
  );
}

export function parseNativeProfileReference(value: unknown): NativeProfileReference {
  if (!isNativeProfileReference(value)) throw new Error('Invalid native profile reference');
  return {
    executionNodeId: value.executionNodeId,
    runner: value.runner,
    profileId: value.profileId,
    accountContextId: value.accountContextId,
  };
}

export function nativeProfileSessionParams(profile: NativeProfileReference | undefined) {
  return profile
    ? { profileId: profile.profileId, accountContextId: profile.accountContextId }
    : {};
}

export function sameNativeProfileReference(
  left: NativeProfileReference | undefined,
  right: NativeProfileReference | undefined,
): boolean {
  return (
    left?.executionNodeId === right?.executionNodeId &&
    left?.runner === right?.runner &&
    left?.profileId === right?.profileId &&
    left?.accountContextId === right?.accountContextId
  );
}
export interface NativeProfileTargetParams {
  executionNodeId?: string;
  profileId: string;
}
export interface NativeProfileAddParams extends NativeProfileTargetParams {
  runner: string;
  /** Existing native profile directory; omitted creates a node-local directory. */
  directory?: string;
}
export interface NativeProfileRemoveParams extends NativeProfileTargetParams {
  accountContextId: string;
}
export interface NativeProfileListResult {
  profiles: NativeProfileInfo[];
}
export interface NativeProfileStatusResult {
  profile: NativeProfileInfo;
  account: NativeAccountObservation;
  /** Normal native login command for the execution node. Never contains a token. */
  loginCommand: string;
}
