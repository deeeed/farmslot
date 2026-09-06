import type {
  ProjectResourcePostureConfig,
  ResourcePostureRetention,
  ResourcePostureRetentionBoundary,
} from './resource-posture.js';

/** Runtime resources acquired after core prepare from a declared proof plan. */
export type RuntimeCapabilityCostClass = 'low' | 'medium' | 'high';
export type RuntimeCapabilitySharePolicy = 'exclusive' | 'shared';
export type RuntimeCapabilityLeaseState =
  | 'queued'
  | 'acquiring'
  | 'acquired'
  | 'releasing'
  | 'released'
  | 'error';
export type RuntimeCapabilityHealthState = 'unknown' | 'healthy' | 'unhealthy';
/** Proof modes a requirement may ask for. Exported as a value so clients can
 * build option lists and validators from the protocol instead of retyping it. */
export const RUNTIME_CAPABILITY_PROOF_MODES = ['state', 'visual', 'mixed'] as const;
export type RuntimeCapabilityProofMode = (typeof RUNTIME_CAPABILITY_PROOF_MODES)[number];

export function isRuntimeCapabilityProofMode(value: unknown): value is RuntimeCapabilityProofMode {
  return RUNTIME_CAPABILITY_PROOF_MODES.includes(value as RuntimeCapabilityProofMode);
}

export interface RuntimeCapabilityResourceClaim {
  id: string;
  access: RuntimeCapabilitySharePolicy;
  kind?: 'port' | 'device' | 'process' | 'service' | 'other';
}

export interface RuntimeCapabilityCost {
  class: RuntimeCapabilityCostClass;
  resources: RuntimeCapabilityResourceClaim[];
}

export type RuntimeCapabilityProviderActionRef =
  | {
      kind: 'resource';
      resourceId: string;
      action: 'boot' | 'health' | 'shutdown' | 'relaunch';
    }
  | {
      kind: 'slot-action';
      actionId: string;
    };

export interface RuntimeCapabilityProviderActions {
  acquire: RuntimeCapabilityProviderActionRef;
  health: RuntimeCapabilityProviderActionRef;
  release: RuntimeCapabilityProviderActionRef;
}

/**
 * Who owns the lifecycle of a slot resource a provider touches.
 * - `capability`: the lease is the resource's owner, so a running resource with
 *   no lease is an unowned leak and machine parking refuses to stop it.
 * - `slot-lifecycle`: prepare (or the operator) owns the resource and the
 *   capability only rides on it, so no lease is required for it to be running.
 */
export const RUNTIME_CAPABILITY_AFFECTED_OWNERSHIPS = ['capability', 'slot-lifecycle'] as const;
export type RuntimeCapabilityAffectedOwnership =
  (typeof RUNTIME_CAPABILITY_AFFECTED_OWNERSHIPS)[number];

/**
 * What releasing the provider factually does to the resource. This is a claim
 * about mechanics, not a policy knob: `retain` means the provider's release
 * action leaves the resource running, so parking must not stop it either and
 * restore must find it still running rather than boot it.
 */
export const RUNTIME_CAPABILITY_AFFECTED_RELEASE_EFFECTS = ['stop', 'retain'] as const;
export type RuntimeCapabilityAffectedReleaseEffect =
  (typeof RUNTIME_CAPABILITY_AFFECTED_RELEASE_EFFECTS)[number];

/** One slot resource a provider touches, declared by the project catalog. */
export interface RuntimeCapabilityAffectedResource {
  /** Names a key of the project's `resources` map. */
  resourceId: string;
  ownership: RuntimeCapabilityAffectedOwnership;
  releaseEffect: RuntimeCapabilityAffectedReleaseEffect;
}

export interface RuntimeCapabilityProviderConfig {
  label: string;
  description?: string;
  version: string;
  dependencies?: string[];
  sharePolicy: RuntimeCapabilitySharePolicy;
  cost: RuntimeCapabilityCost;
  /** JSON Schema object for acquire parameters. */
  parameters?: Record<string, unknown>;
  actions: RuntimeCapabilityProviderActions;
  /**
   * Slot resources this provider touches. Absent means "derive from the
   * resource-kind action refs" (every referenced resource, owned by the
   * capability, stopped on release) — the behaviour every catalog had before
   * this field existed. An empty array is a deliberate declaration that the
   * provider touches no watched slot resource, which is distinct from absent.
   */
  affectedResources?: RuntimeCapabilityAffectedResource[];
  releaseEffects: string[];
  /** Explicit project policy; zero/absent means release immediately. */
  keepWarmMs?: number;
  /**
   * Per-posture retention (ADR-054). Overrides the project posture defaults for
   * this provider. `retain` is not accepted at `terminal`.
   */
  retention?: Partial<Record<ResourcePostureRetentionBoundary, ResourcePostureRetention>>;
}

export interface ProjectRuntimeCapabilitiesConfig {
  providers: Record<string, RuntimeCapabilityProviderConfig>;
  /** Project-wide posture defaults (ADR-054); provider `retention` wins over these. */
  posture?: ProjectResourcePostureConfig;
}

export interface RuntimeCapabilityProviderProvenance {
  project: string;
  providerId: string;
  version: string;
  digest: string;
}

export interface RuntimeCapabilityAvailability {
  state: 'available' | 'unavailable';
  reason?: string;
}

export interface RuntimeCapabilityCatalogEntry extends RuntimeCapabilityProviderConfig {
  id: string;
  project: string;
  provenance: RuntimeCapabilityProviderProvenance;
  availability: RuntimeCapabilityAvailability;
}

export interface RuntimeCapabilityProofRequirement {
  capabilityId: string;
  reason: string;
  mode: RuntimeCapabilityProofMode;
  parameters?: Record<string, unknown>;
}

export interface RuntimeCapabilityProofPlan {
  version: 1;
  slotId: string;
  ownerRunId: string;
  createdAt: string;
  requirements: RuntimeCapabilityProofRequirement[];
}

export interface RuntimeCapabilityLeaseOwner {
  runId: string;
  familyId?: string;
}

export interface RuntimeCapabilityLeaseHealth {
  state: RuntimeCapabilityHealthState;
  checkedAt?: string;
  detail?: string;
}

export interface RuntimeCapabilityLease {
  id: string;
  slotId: string;
  project: string;
  capabilityId: string;
  owner: RuntimeCapabilityLeaseOwner;
  state: RuntimeCapabilityLeaseState;
  referenceCount: number;
  parameters: Record<string, unknown>;
  provenance: RuntimeCapabilityProviderProvenance;
  health: RuntimeCapabilityLeaseHealth;
  dependencyLeaseIds: string[];
  acquiredAt?: string;
  updatedAt: string;
  releasedAt?: string;
  keepWarmUntil?: string;
  cleanupFailure?: string;
  /** Admission pressure retained while this lease is queued. */
  pressure?: RuntimeCapabilityPressureConflict;
}

export interface RuntimeCapabilityLeaseConflict {
  kind: 'lease-conflict';
  capabilityId: string;
  owner: RuntimeCapabilityLeaseOwner;
  leaseId: string;
  reason: string;
}

export interface RuntimeCapabilityPressureConflict {
  kind: 'host-pressure';
  reason: string;
  severity: 'warn' | 'critical';
  machine?: string;
  queued: boolean;
  retryAfterMs?: number;
}

export type RuntimeCapabilityAcquireConflict =
  | RuntimeCapabilityLeaseConflict
  | RuntimeCapabilityPressureConflict
  | {
      kind: 'unavailable' | 'invalid-request';
      capabilityId: string;
      reason: string;
    };

export type RuntimeCapabilityLifecycleEventKind =
  | 'planned'
  | 'queued'
  | 'acquiring'
  | 'acquired'
  | 'health-changed'
  | 'releasing'
  | 'released'
  | 'recovery-adopted'
  | 'recovery-rejected'
  | 'cleanup-failed';

export interface RuntimeCapabilityLifecycleEvent {
  kind: RuntimeCapabilityLifecycleEventKind;
  at: string;
  slotId: string;
  capabilityId: string;
  leaseId?: string;
  owner?: RuntimeCapabilityLeaseOwner;
  detail?: string;
}

/**
 * Device-identity parameters a capability provider may accept so a validation
 * or recipe rerun can name a target device instead of re-dispatching the run to
 * another slot (ADR-054 item 3).
 *
 * These are the ONLY acquire parameters the Gateway turns into hook template
 * variables. Everything else in a provider's parameter schema stays data the
 * provider's own actions read; it never reaches a shell template.
 */
export const RUNTIME_CAPABILITY_TARGET_KEYS = [
  'platform',
  'udid',
  'simulator',
  'avd',
  'adb_serial',
] as const;
export type RuntimeCapabilityTargetKey = (typeof RUNTIME_CAPABILITY_TARGET_KEYS)[number];
export type RuntimeCapabilityTarget = Partial<Record<RuntimeCapabilityTargetKey, string>>;

/**
 * The charset a device identity may use. Deliberately narrow: these values are
 * substituted into project hook command templates, so anything that could carry
 * shell meaning is refused before it reaches a template rather than escaped
 * afterwards.
 *
 * A LEADING dash is refused too. `-x` is shell-safe but it is still an argument
 * to whatever the hook runs — `simctl boot -x`, `adb -s -x` — so an identity
 * must start with an identity character.
 */
export const RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;

export function isRuntimeCapabilityTargetKey(value: unknown): value is RuntimeCapabilityTargetKey {
  return RUNTIME_CAPABILITY_TARGET_KEYS.includes(value as RuntimeCapabilityTargetKey);
}

export function isRuntimeCapabilityTargetValue(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN.test(value);
}

/**
 * The device-identity subset of a lease's stored acquire parameters, for
 * clients that show which device a lease actually resolved to. Values that are
 * not well-formed identities are dropped rather than rendered: a lease can only
 * have been acquired with valid ones, so anything else is not a target.
 */
export function runtimeCapabilityTargetFromParameters(
  parameters: Record<string, unknown> | undefined,
): RuntimeCapabilityTarget | undefined {
  if (!parameters) return undefined;
  const target: RuntimeCapabilityTarget = {};
  for (const key of RUNTIME_CAPABILITY_TARGET_KEYS) {
    const value = parameters[key];
    if (isRuntimeCapabilityTargetValue(value)) target[key] = value;
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

/** `simulator=A, udid=B` in the order the keys are declared. For labels only. */
export function formatRuntimeCapabilityTarget(target: RuntimeCapabilityTarget): string {
  return RUNTIME_CAPABILITY_TARGET_KEYS.filter((key) => target[key] !== undefined)
    .map((key) => `${key}=${target[key]}`)
    .join(', ');
}
