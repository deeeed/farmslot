import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  RuntimeCapabilityLease,
  RuntimeCapabilityLifecycleEvent,
  RuntimeCapabilityProofPlan,
} from '@farmslot/protocol';

export interface RuntimeCapabilityStoreSnapshot {
  version: 1;
  leases: RuntimeCapabilityLease[];
  proofPlans: Record<string, RuntimeCapabilityProofPlan>;
  events: RuntimeCapabilityLifecycleEvent[];
}

export const RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT = 1_000;
export const RUNTIME_CAPABILITY_PROOF_PLAN_LIMIT = 500;
export const RUNTIME_CAPABILITY_EVENT_LIMIT = 500;

function emptySnapshot(): RuntimeCapabilityStoreSnapshot {
  return { version: 1, leases: [], proofPlans: {}, events: [] };
}

function isSnapshot(value: unknown): value is RuntimeCapabilityStoreSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RuntimeCapabilityStoreSnapshot>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.leases) &&
    Boolean(candidate.proofPlans) &&
    typeof candidate.proofPlans === 'object' &&
    !Array.isArray(candidate.proofPlans) &&
    Array.isArray(candidate.events)
  );
}

function leaseNeedsRetention(lease: RuntimeCapabilityLease): boolean {
  return (
    ['acquiring', 'acquired', 'releasing'].includes(lease.state) ||
    (lease.state === 'error' && Boolean(lease.cleanupFailure)) ||
    // ADR-054: a released lease with a keep-warm deadline still describes a
    // running provider. Evicting it under churn would lose both the deadline
    // and the only record of the process that must still be cleaned up.
    Boolean(lease.keepWarmUntil)
  );
}

export function compactRuntimeCapabilitySnapshot(
  snapshot: RuntimeCapabilityStoreSnapshot,
): RuntimeCapabilityStoreSnapshot {
  const retainedOwners = new Set(
    snapshot.leases.filter(leaseNeedsRetention).map((lease) => lease.owner.runId),
  );
  const protectedLeaseIds = new Set(
    snapshot.leases
      .filter(leaseNeedsRetention)
      .flatMap((lease) => [lease.id, ...lease.dependencyLeaseIds]),
  );
  const recentTerminalIds = new Set(
    snapshot.leases
      .filter((lease) => !leaseNeedsRetention(lease))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT)
      .map((lease) => lease.id),
  );
  const recentPlanOwners = new Set(
    Object.values(snapshot.proofPlans)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, RUNTIME_CAPABILITY_PROOF_PLAN_LIMIT)
      .map((plan) => plan.ownerRunId),
  );

  return {
    version: 1,
    leases: snapshot.leases.filter(
      (lease) => protectedLeaseIds.has(lease.id) || recentTerminalIds.has(lease.id),
    ),
    proofPlans: Object.fromEntries(
      Object.entries(snapshot.proofPlans).filter(
        ([ownerRunId]) => retainedOwners.has(ownerRunId) || recentPlanOwners.has(ownerRunId),
      ),
    ),
    events: snapshot.events.slice(-RUNTIME_CAPABILITY_EVENT_LIMIT),
  };
}

export class RuntimeCapabilityStore {
  private snapshotValue: RuntimeCapabilityStoreSnapshot = emptySnapshot();
  private loaded = false;

  constructor(readonly path: string) {}

  async load(): Promise<RuntimeCapabilityStoreSnapshot> {
    if (this.loaded) return this.snapshot();
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!isSnapshot(parsed)) throw new Error('store does not match version 1 contract');
      this.snapshotValue = structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `Failed to load runtime capability store ${this.path}: ${(error as Error).message}`,
        );
      }
      this.snapshotValue = emptySnapshot();
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): RuntimeCapabilityStoreSnapshot {
    return structuredClone(this.snapshotValue);
  }

  async replace(snapshot: RuntimeCapabilityStoreSnapshot): Promise<void> {
    const compacted = compactRuntimeCapabilitySnapshot(snapshot);
    await mkdir(path.dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(compacted, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    this.snapshotValue = structuredClone(compacted);
    this.loaded = true;
  }
}
