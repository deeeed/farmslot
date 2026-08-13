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
export type RuntimeCapabilityProofMode = 'state' | 'visual' | 'mixed';

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
  releaseEffects: string[];
  /** Explicit project policy; zero/absent means release immediately. */
  keepWarmMs?: number;
}

export interface ProjectRuntimeCapabilitiesConfig {
  providers: Record<string, RuntimeCapabilityProviderConfig>;
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
