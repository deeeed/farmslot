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
  /**
   * Runs whose terminal capability cleanup has already run, oldest first.
   *
   * Superseded by `terminalOwnerEntries`. Still read on load so an existing
   * store keeps its fence, never written again.
   */
  terminalOwners?: string[];
  /** Families whose terminal cleanup has run, oldest first. Superseded too. */
  terminalFamilies?: string[];
  /**
   * Runs whose terminal capability cleanup has run, with when it ran.
   *
   * This is the fence AUTHORITY, not a cache of one. It used to be bounded by
   * count and backed by a run-store predicate for anything evicted past the
   * bound — but archiving deletes the run record, so that predicate went blind
   * exactly for the oldest owners, and an archived terminal owner could
   * reacquire. Retiring on AGE instead keeps the authority here, where
   * archiving cannot reach it.
   */
  terminalOwnerEntries?: RuntimeCapabilityFenceEntry[];
  /**
   * Families whose terminal cleanup has run, with when it ran.
   *
   * Written ONLY by a family-scope cleanup. It is never inferred from member
   * run status: a chained follow-up run shares its parent's family, so "some
   * member is terminal" fenced live children the moment their parent finished.
   */
  terminalFamilyEntries?: RuntimeCapabilityFenceEntry[];
}

/** One fenced owner or family, with the time its terminal cleanup ran. */
export interface RuntimeCapabilityFenceEntry {
  id: string;
  at: string;
}

export const RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT = 1_000;
/**
 * How long a fenced owner or family is remembered.
 *
 * Age, not count. A count bound evicted the OLDEST entries, which are exactly
 * the ones whose run records archiving has already deleted — so the fallback
 * that was supposed to cover eviction was blind precisely where eviction bit.
 * Keyed on time instead, the fence outlives both archiving and churn, and an
 * entry is only dropped once the run it names is far beyond any chance of
 * acquiring again.
 */
export const RUNTIME_CAPABILITY_TERMINAL_FENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
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
    Array.isArray(candidate.events) &&
    // Optional on purpose: stores written before the fence was persisted must
    // keep loading. Present-but-wrong is still a contract violation.
    (candidate.terminalOwners === undefined || Array.isArray(candidate.terminalOwners)) &&
    (candidate.terminalFamilies === undefined || Array.isArray(candidate.terminalFamilies)) &&
    (candidate.terminalOwnerEntries === undefined ||
      Array.isArray(candidate.terminalOwnerEntries)) &&
    (candidate.terminalFamilyEntries === undefined ||
      Array.isArray(candidate.terminalFamilyEntries))
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

/**
 * Drop fence entries older than the TTL, keeping unparseable timestamps.
 *
 * An entry whose `at` cannot be read has unknown age; dropping it would open
 * the fence for exactly the owners whose provenance is least certain, so it is
 * kept instead.
 */
export function retainFreshFenceEntries(
  entries: RuntimeCapabilityFenceEntry[],
  nowMs: number = Date.now(),
): RuntimeCapabilityFenceEntry[] {
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return true;
    return nowMs - at < RUNTIME_CAPABILITY_TERMINAL_FENCE_TTL_MS;
  });
}

/**
 * Fold a loaded snapshot's fence records into one entry list per scope.
 *
 * A store written before entries existed carries bare id lists with no
 * timestamp. Those are adopted with the load time as their `at`, which is
 * conservative in the right direction: an unknown-age fence gets a fresh TTL
 * rather than being dropped on the first compaction after upgrade.
 */
export function hydrateFenceEntries(
  entries: RuntimeCapabilityFenceEntry[] | undefined,
  legacyIds: string[] | undefined,
  now: string = new Date().toISOString(),
): RuntimeCapabilityFenceEntry[] {
  const byId = new Map<string, RuntimeCapabilityFenceEntry>();
  for (const id of legacyIds ?? []) byId.set(id, { id, at: now });
  for (const entry of entries ?? []) byId.set(entry.id, entry);
  return [...byId.values()];
}

function fenceEntriesFor(
  entries: RuntimeCapabilityFenceEntry[] | undefined,
  legacyIds: string[] | undefined,
): { terminalOwnerEntries?: RuntimeCapabilityFenceEntry[] } {
  if (!entries && !legacyIds) return {};
  return { terminalOwnerEntries: retainFreshFenceEntries(hydrateFenceEntries(entries, legacyIds)) };
}

function fenceEntriesForFamilies(
  entries: RuntimeCapabilityFenceEntry[] | undefined,
  legacyIds: string[] | undefined,
): { terminalFamilyEntries?: RuntimeCapabilityFenceEntry[] } {
  if (!entries && !legacyIds) return {};
  return {
    terminalFamilyEntries: retainFreshFenceEntries(hydrateFenceEntries(entries, legacyIds)),
  };
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
    // Retired by age. Legacy count-bounded keys are FOLDED IN here rather than
    // carried or dropped: a caller that replaces a snapshot it loaded before the
    // registry hydrated would otherwise silently erase an existing fence, which
    // is the one thing this store must never do.
    ...fenceEntriesFor(snapshot.terminalOwnerEntries, snapshot.terminalOwners),
    ...fenceEntriesForFamilies(snapshot.terminalFamilyEntries, snapshot.terminalFamilies),
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
