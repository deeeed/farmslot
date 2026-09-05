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
