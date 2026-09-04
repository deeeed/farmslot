import type { ProjectResourcePostureConfig } from '../contracts/resource-posture.js';
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
