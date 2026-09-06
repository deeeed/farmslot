import type {
  ProjectResourcePostureConfig,
  ResourcePostureObservedState,
} from '../contracts/resource-posture.js';
import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityLease,
  RuntimeCapabilityLifecycleEvent,
  RuntimeCapabilityPressureConflict,
  RuntimeCapabilityProofPlan,
  RuntimeCapabilityProofRequirement,
} from '../contracts/runtime-capabilities.js';

import { Methods } from './registry.js';

export const RuntimeCapabilityMethods = {
  list: Methods.RUNTIME_CAPABILITY_LIST,
  acquire: Methods.RUNTIME_CAPABILITY_ACQUIRE,
  release: Methods.RUNTIME_CAPABILITY_RELEASE,
  status: Methods.RUNTIME_CAPABILITY_STATUS,
  stopWarm: Methods.RUNTIME_CAPABILITY_STOP_WARM,
} as const;

export interface RuntimeCapabilityListParams {
  slotId: string;
}

export interface RuntimeCapabilityListResult {
  slotId: string;
  project: string;
  capabilities: RuntimeCapabilityCatalogEntry[];
}

export interface RuntimeCapabilityAcquireParams {
  slotId: string;
  capabilityId: string;
  ownerRunId: string;
  ownerFamilyId?: string;
  proofRequirement: RuntimeCapabilityProofRequirement;
  parameters?: Record<string, unknown>;
  queueOnPressure?: boolean;
  /**
   * Re-run the provider health check before reusing a lease this owner already
   * holds, and clean up the provider when it fails (ADR-054). Validation and
   * recipe reruns set this so a dead retained provider cannot pass preparation.
   */
  revalidateHealth?: boolean;
  /**
   * Parameters to acquire each DEPENDENCY with, keyed by capability id.
   *
   * A device provider is often reached as another provider's dependency
   * (`companion-native-client-ios` -> `ios-simulator`). Acquiring a dependency
   * with no parameters pins the slot's configured device, and the requirement
   * that actually names a target is then refused for disagreeing with the lease
   * its own parent just created. The caller reconciling a proof plan passes the
   * whole plan's parameters here so the order it happens to walk the plan in
   * cannot decide which device is used.
   */
  dependencyParameters?: Record<string, Record<string, unknown>>;
}

export type RuntimeCapabilityAcquireResult =
  | {
      ok: true;
      lease: RuntimeCapabilityLease;
      dependencyLeases: RuntimeCapabilityLease[];
      idempotent: boolean;
    }
  | { ok: false; conflict: RuntimeCapabilityAcquireConflict };

export interface RuntimeCapabilityReleaseParams {
  slotId: string;
  ownerRunId: string;
  capabilityId?: string;
  leaseId?: string;
  /** Explicitly retry cleanup with the current provider after provenance changed. */
  force?: boolean;
  /**
   * Whether the provider may stay warm past this release (ADR-054). Defaults to
   * the historical behaviour: warm unless `force` is set. `false` stops the
   * provider without bypassing the provenance guard that `force` bypasses.
   */
  keepWarm?: boolean;
}

export interface RuntimeCapabilityReleaseResult {
  ok: boolean;
  released: RuntimeCapabilityLease[];
  retained: RuntimeCapabilityLease[];
  effects: string[];
  failures: Array<{ leaseId: string; capabilityId: string; reason: string }>;
}

export interface RuntimeCapabilityStatusParams {
  slotId: string;
  ownerRunId?: string;
}

export interface RuntimeCapabilityStatusResult {
  slotId: string;
  project: string;
  catalog: RuntimeCapabilityCatalogEntry[];
  leases: RuntimeCapabilityLease[];
  proofPlans: Record<string, RuntimeCapabilityProofPlan>;
  pressure?: RuntimeCapabilityPressureConflict;
  events: RuntimeCapabilityLifecycleEvent[];
  /** Project posture defaults for this slot's project (ADR-054). */
  posture?: ProjectResourcePostureConfig;
}

export interface RuntimeCapabilityStopWarmParams {
  slotId: string;
  capabilityId: string;
}

export const RUNTIME_CAPABILITY_STOP_WARM_OUTCOMES = [
  /** The provider was kept alive by a released lease and has now been stopped. */
  'stopped',
  /** Something active or still warm depends on it; stopping it would break that. */
  'deferred',
  /** Nothing was keeping this capability warm on the slot. */
  'not-warm',
  /** Cleanup ran and failed; the provider's real state is not known. */
  'failed',
] as const;
export type RuntimeCapabilityStopWarmOutcome =
  (typeof RUNTIME_CAPABILITY_STOP_WARM_OUTCOMES)[number];

/**
 * Result of stopping one warm provider. `runtime.capability.release` cannot do
 * this: it filters released leases, so it reports success while the provider
 * keeps running. `observedState` is never `stopped` unless it really stopped.
 */
export interface RuntimeCapabilityStopWarmResult {
  ok: boolean;
  slotId: string;
  capabilityId: string;
  outcome: RuntimeCapabilityStopWarmOutcome;
  observedState: ResourcePostureObservedState;
  /** Why it was deferred or skipped, in operator terms. */
  reason?: string;
  cleanupFailure?: string;
  /** Declared release effects of what actually stopped. */
  effects: string[];
}
