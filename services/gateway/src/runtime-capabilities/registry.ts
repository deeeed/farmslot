import { createHash, randomUUID } from 'node:crypto';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

import {
  type ProjectResourcePostureConfig,
  type RuntimeCapabilityAcquireConflict,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityClaimScope,
  runtimeCapabilityClaimScope,
  type RuntimeCapabilityClaimWaiter,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityLeaseClaim,
  type RuntimeCapabilityLifecycleEvent,
  type RuntimeCapabilityListResult,
  type RuntimeCapabilityProviderActionRef,
  type RuntimeCapabilityReleaseParams,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityScopedClaimWait,
  type RuntimeCapabilityStatusParams,
  type RuntimeCapabilityStatusResult,
  widerRuntimeCapabilityClaimScope,
} from '@farmslot/protocol';

import { claimsDevice } from './device-target.js';
import { sameCapabilityParameters, stableJson } from './parameters.js';
import {
  hydrateFenceEntries,
  retainFreshFenceEntries,
  RUNTIME_CAPABILITY_EVENT_LIMIT,
  type RuntimeCapabilityFenceEntry,
  RuntimeCapabilityStore,
  type RuntimeCapabilityStoreSnapshot,
} from './store.js';

export interface RuntimeCapabilityCatalogContext {
  slotId: string;
  project: string;
  /**
   * The machine this slot runs on, stamped onto every lease it takes so a
   * `machine`-scoped claim can be arbitrated from the snapshot alone. Absent
   * when the caller has no fleet (tests, validation gateways): those leases can
   * only arbitrate at `slot` and `fleet` scope.
   */
  machine?: string;
  capabilities: RuntimeCapabilityCatalogEntry[];
  /** Project posture defaults (ADR-054); provider `retention` wins over these. */
  posture?: ProjectResourcePostureConfig;
}

/** What one keep-warm sweep did, so a caller can report it without guessing. */
export interface WarmSweepSummary {
  /** Warm leases the selector matched. */
  selected: RuntimeCapabilityLease[];
  /** Left warm because something active or still warm depends on them. */
  deferred: RuntimeCapabilityLease[];
  /** Providers actually stopped. */
  released: RuntimeCapabilityLease[];
  /** Warm window cleared, but another lease still owns the running provider. */
  stillHeld: RuntimeCapabilityLease[];
  failures: Array<{ leaseId: string; capabilityId: string; reason: string }>;
  effects: string[];
}

export interface RuntimeCapabilityActionResult {
  ok: boolean;
  detail?: string;
}

export interface RuntimeCapabilityRegistryOptions {
  store: RuntimeCapabilityStore;
  catalogForSlot: (slotId: string) => Promise<RuntimeCapabilityCatalogContext>;
  runAction: (
    slotId: string,
    action: RuntimeCapabilityProviderActionRef,
    /**
     * The acquire parameters of the lease this action belongs to. Device
     * identity travels here (ADR-054 item 3), so a release always stops the
     * device its own lease acquired rather than the slot's configured default.
     */
    parameters: Record<string, unknown>,
    /**
     * The parameter names THIS provider's schema declares. Only these may be
     * substituted into its hook command: the device allowlist is global, so
     * without this a provider that names a parameter `platform` or `simulator`
     * for its own purposes would have it rewritten into its command line, and
     * `platform` would shadow the slot's auto-injected one.
     */
    declaredParameters: readonly string[],
  ) => Promise<RuntimeCapabilityActionResult>;
  /**
   * Refuse a device target that is not usable on this fleet, before the provider
   * boots anything. Returns the refusal reason, or null to allow. Left unwired
   * by tests and validation gateways that have no fleet.
   */
  assertTargetAvailable?: (input: {
    slotId: string;
    capabilityId: string;
    ownerRunId: string;
    parameters: Record<string, unknown>;
    /**
     * Whether this capability claims a device, taken from the catalog entry the
     * registry already resolved under its own lock. The guard must not re-read
     * the catalog to answer this: a config file mid-write would make it skip
     * itself for exactly the acquires it exists to check.
     */
    claimsDevice: boolean;
    /** Leases that currently hold a provider, across every slot. */
    activeLeases: readonly RuntimeCapabilityLease[];
  }) => Promise<string | null>;
  pressureFor?: (
    slotId: string,
    capability: RuntimeCapabilityCatalogEntry,
    queueOnPressure: boolean,
  ) => Promise<RuntimeCapabilityAcquireConflict | null>;
  /** Family of a run, used when a caller omits the optional `ownerFamilyId`. */
  familyForRun?: (ownerRunId: string) => string | undefined;
  /**
   * Whether the RUN STORE says this owner is already terminal.
   *
   * The durable half of the fence. The persisted owner list is a fast path that
   * survives restart but is bounded, so an owner evicted past that bound still
   * has to be refused — and the run store is what actually knows, from the run's
   * terminal status or its persisted terminal posture. Left unwired only by
   * tests and validation gateways that have no run store.
   */
  isTerminalOwner?: (ownerRunId: string) => boolean;

  onEvent?: (event: RuntimeCapabilityLifecycleEvent) => void;
  now?: () => Date;
  leaseId?: () => string;
}

const ACTIVE_STATES = new Set<RuntimeCapabilityLease['state']>([
  'queued',
  'acquiring',
  'acquired',
  'releasing',
]);
const parameterAjv = new Ajv2020({ allErrors: true, strict: false });
const parameterValidators = new Map<string, ValidateFunction>();

export function runtimeCapabilityProviderDigest(
  entry: Omit<RuntimeCapabilityCatalogEntry, 'provenance' | 'availability' | 'project' | 'id'>,
): string {
  return createHash('sha256').update(stableJson(entry)).digest('hex');
}

function blocksAcquisition(lease: RuntimeCapabilityLease): boolean {
  return (
    ACTIVE_STATES.has(lease.state) || (lease.state === 'error' && Boolean(lease.cleanupFailure))
  );
}

function holdsProvider(lease: RuntimeCapabilityLease): boolean {
  return ACTIVE_STATES.has(lease.state) && lease.state !== 'queued';
}

/**
 * Whether this lease's PROVIDER is running, which is not the same question as
 * whether the lease still holds it. A keep-warm lease is `released` with a
 * deadline and its provider is deliberately still up — the one state where a
 * device runs under no active lease. Anything asking "is this device in use"
 * has to see those, or a second slot adopts the device and the warm sweeper
 * later stops it under the run that adopted it.
 *
 * An ELAPSED deadline counts too, exactly as the warm-lease adoption path
 * treats it: the deadline is a schedule, not proof the sweeper has run.
 */
function runsProvider(lease: RuntimeCapabilityLease): boolean {
  return holdsProvider(lease) || (lease.state === 'released' && lease.keepWarmUntil !== undefined);
}

/**
 * Whether this lease HOLDS its resource claims.
 *
 * A queued lease blocks acquisition of its own capability on its own slot, but
 * it holds nothing: it has no provider and never ran an acquire action. Letting
 * it count as a claim holder would make two waiters block each other and stall
 * the drain that exists to serve them.
 */
function holdsClaim(lease: RuntimeCapabilityLease): boolean {
  return lease.state !== 'queued' && blocksAcquisition(lease);
}

/**
 * Whether a holder's claim reaches the acquiring slot.
 *
 * `slot` never reaches past its own slot, which is exactly how every claim
 * behaved before scopes existed. `machine` needs both sides to know their
 * machine — an unknown machine is not a match, so a Gateway with no fleet
 * arbitrates machine claims as slot claims rather than as fleet claims.
 */
function claimReachesSlot(
  holder: RuntimeCapabilityLease,
  scope: RuntimeCapabilityClaimScope,
  acquiringSlotId: string,
  acquiringMachine: string | undefined,
): boolean {
  if (holder.slotId === acquiringSlotId) return true;
  if (scope === 'fleet') return true;
  if (scope === 'machine') {
    return (
      holder.machine !== undefined &&
      acquiringMachine !== undefined &&
      holder.machine === acquiringMachine
    );
  }
  return false;
}

/** The claims a catalog entry declares, with the `slot` default applied. */
function claimsOfEntry(
  entry: Pick<RuntimeCapabilityCatalogEntry, 'cost'>,
): RuntimeCapabilityLeaseClaim[] {
  return entry.cost.resources.map((claim) => ({
    id: claim.id,
    access: claim.access,
    scope: runtimeCapabilityClaimScope(claim),
  }));
}

/** The wait record of a queued lease, or undefined when it is not a claim waiter. */
function scopedWaitOf(lease: RuntimeCapabilityLease): RuntimeCapabilityScopedClaimWait | undefined {
  return lease.state === 'queued' && lease.wait?.kind === 'scoped-claim' ? lease.wait : undefined;
}

/**
 * Queue order for one claim: enqueue time, then lease id as the tiebreak.
 *
 * Derived on every read and never stored. A restart therefore preserves the
 * order for free, and nothing ever has to renumber a queue.
 */
function claimQueueOrder(
  leases: readonly RuntimeCapabilityLease[],
  claimId: string,
): RuntimeCapabilityLease[] {
  return leases
    .filter((lease) => scopedWaitOf(lease)?.claimId === claimId)
    .sort(
      (left, right) =>
        scopedWaitOf(left)!.enqueuedAt.localeCompare(scopedWaitOf(right)!.enqueuedAt) ||
        left.id.localeCompare(right.id),
    );
}

/** One resource claim a live lease holds that a pending acquire also wants. */
interface ClaimConflict {
  holder: RuntimeCapabilityLease;
  claimId: string;
  /** The effective (widest) scope of the two declarations. */
  scope: RuntimeCapabilityClaimScope;
  /** Whether the holder is on a different slot than the acquirer. */
  crossSlot: boolean;
}

function claimConflictReason(capabilityId: string, conflict: ClaimConflict): string {
  return conflict.crossSlot
    ? `Resource '${conflict.claimId}' is claimed at ${conflict.scope} scope by capability ` +
        `'${conflict.holder.capabilityId}' on slot '${conflict.holder.slotId}' for ` +
        `${conflict.holder.owner.runId}`
    : `Resource '${conflict.claimId}' is already claimed by capability ` +
        `'${conflict.holder.capabilityId}' for ${conflict.holder.owner.runId}`;
}

/** Parameter names a provider's own schema declares, or none when it has no schema. */
function declaredParameterNames(
  entry: Pick<RuntimeCapabilityCatalogEntry, 'parameters'>,
): readonly string[] {
  const properties = (entry.parameters as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties) : [];
}

function parameterValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = stableJson(schema);
  const cached = parameterValidators.get(key);
  if (cached) return cached;
  const validator = parameterAjv.compile(schema);
  parameterValidators.set(key, validator);
  return validator;
}

/** The fence map as the store's entry list. */
function fenceEntries(fenced: ReadonlyMap<string, string>): RuntimeCapabilityFenceEntry[] {
  return [...fenced].map(([id, at]) => ({ id, at }));
}

export class RuntimeCapabilityRegistry {
  private readonly now: () => Date;
  private readonly leaseId: () => string;
  private pendingEvents: RuntimeCapabilityLifecycleEvent[] = [];
  /**
   * Runs whose terminal cleanup has already run. A lease must never be handed to
   * one of them: the run is gone, so nothing would ever release it again.
   */
  private terminatedOwners = new Map<string, string>();
  /** Families whose terminal cleanup has run; siblings must not reacquire. */
  private terminatedFamilies = new Map<string, string>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  /**
   * What a queued waiter needs to finish its acquire once the claim frees.
   *
   * In memory on purpose. A provider boot takes minutes and must not run under
   * the release lock, so the drain only marks the head waiter `acquiring` and
   * hands the boot to this map, outside the lock. A restart loses it, which is
   * why the DURABLE record is the queued lease plus the run's resource wait:
   * the owner's pre-validation retry re-acquires and re-enters the queue at its
   * existing place.
   */
  private pendingWaiters = new Map<
    string,
    { params: RuntimeCapabilityAcquireParams; wait: RuntimeCapabilityScopedClaimWait }
  >();

  constructor(private readonly options: RuntimeCapabilityRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.leaseId = options.leaseId ?? (() => `cap-${randomUUID()}`);
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.options.store.load().then((snapshot) => {
        // Rebuild the fence from durable state before anything can acquire. A
        // registry that came up empty here handed a terminal run a provider
        // again after every restart, and nothing would have released it.
        const loadedAt = this.timestamp();
        for (const entry of hydrateFenceEntries(
          snapshot.terminalOwnerEntries,
          snapshot.terminalOwners,
          loadedAt,
        )) {
          this.terminatedOwners.set(entry.id, entry.at);
        }
        for (const entry of hydrateFenceEntries(
          snapshot.terminalFamilyEntries,
          snapshot.terminalFamilies,
          loadedAt,
        )) {
          this.terminatedFamilies.set(entry.id, entry.at);
        }
        this.loaded = true;
      });
    }
    await this.loadPromise;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private recordEvent(
    snapshot: RuntimeCapabilityStoreSnapshot,
    event: Omit<RuntimeCapabilityLifecycleEvent, 'at'>,
  ): void {
    const record = { ...event, at: this.timestamp() };
    snapshot.events.push(record);
    if (snapshot.events.length > RUNTIME_CAPABILITY_EVENT_LIMIT) {
      snapshot.events.splice(0, snapshot.events.length - RUNTIME_CAPABILITY_EVENT_LIMIT);
    }
    this.pendingEvents.push(record);
  }

  /**
   * Retire expired fence entries from the IN-MEMORY maps on the same age rule
   * the store's compaction applies to disk.
   *
   * Compaction alone left the two disagreeing: an entry past the TTL vanished
   * from the file while `acquire` kept refusing on the copy this process still
   * held, so the fence only actually expired at the next restart. Run on the
   * write path, so memory and disk retire together.
   */
  private pruneExpiredFences(): void {
    const nowMs = this.now().getTime();
    for (const fenced of [this.terminatedOwners, this.terminatedFamilies]) {
      const fresh = new Set(
        retainFreshFenceEntries(fenceEntries(fenced), nowMs).map((entry) => entry.id),
      );
      for (const id of fenced.keys()) {
        if (!fresh.has(id)) fenced.delete(id);
      }
    }
  }

  private async persist(snapshot: RuntimeCapabilityStoreSnapshot): Promise<void> {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.pruneExpiredFences();
    // Stamped on every write, so the terminal fence lands in the SAME replace as
    // the release that armed it. A separate write would leave a window where the
    // providers were stopped but the fence was not durable yet.
    snapshot.terminalOwnerEntries = fenceEntries(this.terminatedOwners);
    snapshot.terminalFamilyEntries = fenceEntries(this.terminatedFamilies);
    // The legacy count-bounded keys were folded into the entry lists at load;
    // rewriting them would resurrect the bound the entries replaced.
    snapshot.terminalOwners = undefined;
    snapshot.terminalFamilies = undefined;
    await this.options.store.replace(snapshot);
    for (const event of events) this.options.onEvent?.(event);
  }

  /**
   * What to acquire a dependency with. The caller's explicit map wins; the
   * stored proof plan is the fallback for callers that do not reconcile a whole
   * plan at once. Never `{}` when the plan says otherwise — that silently pins
   * the slot's configured device under a re-target.
   */
  private parametersForDependency(
    snapshot: RuntimeCapabilityStoreSnapshot,
    params: RuntimeCapabilityAcquireParams,
    dependencyId: string,
  ): Record<string, unknown> {
    const explicit = params.dependencyParameters?.[dependencyId];
    if (explicit) return structuredClone(explicit);
    const planned = snapshot.proofPlans[params.ownerRunId]?.requirements.find(
      (requirement) => requirement.capabilityId === dependencyId,
    )?.parameters;
    return planned ? structuredClone(planned) : {};
  }

  private async runAction(
    slotId: string,
    action: RuntimeCapabilityProviderActionRef,
    parameters: Record<string, unknown>,
    /** The provider the action belongs to; its schema is the substitution allowlist. */
    entry: Pick<RuntimeCapabilityCatalogEntry, 'parameters'>,
  ): Promise<RuntimeCapabilityActionResult> {
    try {
      return await this.options.runAction(
        slotId,
        action,
        parameters,
        declaredParameterNames(entry),
      );
    } catch (error) {
      return {
        ok: false,
        detail: `Provider action threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async list(slotId: string): Promise<RuntimeCapabilityListResult> {
    await this.initialize();
    const catalog = await this.options.catalogForSlot(slotId);
    return {
      slotId,
      project: catalog.project,
      capabilities: structuredClone(catalog.capabilities),
    };
  }

  async status(params: RuntimeCapabilityStatusParams): Promise<RuntimeCapabilityStatusResult> {
    await this.initialize();
    const [catalog, snapshot] = await Promise.all([
      this.options.catalogForSlot(params.slotId),
      Promise.resolve(this.options.store.snapshot()),
    ]);
    const leases = snapshot.leases.filter(
      (lease) =>
        lease.slotId === params.slotId &&
        (!params.ownerRunId || lease.owner.runId === params.ownerRunId),
    );
    const pressure = [...leases]
      .reverse()
      .find((lease) => lease.state === 'queued' && lease.pressure)?.pressure;
    // Derived across EVERY slot, not just this one. `leases` is slot-filtered,
    // so on its own it cannot say how many runs are ahead of this slot's waiter
    // when the claim is machine- or fleet-scoped.
    const claimWaiters: RuntimeCapabilityClaimWaiter[] = [];
    const claimIds = new Set(
      leases.map((lease) => scopedWaitOf(lease)?.claimId).filter((id): id is string => Boolean(id)),
    );
    for (const claimId of [...claimIds].sort()) {
      claimQueueOrder(snapshot.leases, claimId).forEach((waiter, index) => {
        const wait = scopedWaitOf(waiter)!;
        claimWaiters.push({
          claimId,
          scope: wait.scope,
          position: index + 1,
          leaseId: waiter.id,
          slotId: waiter.slotId,
          capabilityId: waiter.capabilityId,
          owner: structuredClone(waiter.owner),
          enqueuedAt: wait.enqueuedAt,
          blockingOwner: structuredClone(wait.blockingOwner),
          blockingLeaseId: wait.blockingLeaseId,
        });
      });
    }
    return {
      slotId: params.slotId,
      project: catalog.project,
      catalog: structuredClone(catalog.capabilities),
      leases,
      ...(claimWaiters.length > 0 ? { claimWaiters } : {}),
      proofPlans: Object.fromEntries(
        Object.entries(snapshot.proofPlans).filter(
          ([runId, plan]) =>
            plan.slotId === params.slotId && (!params.ownerRunId || runId === params.ownerRunId),
        ),
      ),
      events: snapshot.events.filter(
        (event) =>
          event.slotId === params.slotId &&
          (!params.ownerRunId || event.owner?.runId === params.ownerRunId),
      ),
      ...(pressure ? { pressure: structuredClone(pressure) } : {}),
      ...(catalog.posture ? { posture: structuredClone(catalog.posture) } : {}),
    };
  }

  async acquire(params: RuntimeCapabilityAcquireParams): Promise<RuntimeCapabilityAcquireResult> {
    return this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const catalog = await this.options.catalogForSlot(params.slotId);
      const result = await this.acquireInternal(snapshot, catalog, params, true);
      await this.persist(snapshot);
      return result;
    });
  }

  private async acquireInternal(
    snapshot: RuntimeCapabilityStoreSnapshot,
    catalog: RuntimeCapabilityCatalogContext,
    params: RuntimeCapabilityAcquireParams,
    recordPlan: boolean,
  ): Promise<RuntimeCapabilityAcquireResult> {
    const entry = catalog.capabilities.find((capability) => capability.id === params.capabilityId);
    if (!entry) {
      return {
        ok: false,
        conflict: {
          kind: 'unavailable',
          capabilityId: params.capabilityId,
          reason: `Capability '${params.capabilityId}' is not in the ${catalog.project} catalog`,
        },
      };
    }
    // The run record is the authority on family membership. `ownerFamilyId` is
    // optional on the wire, so a caller could omit it and get a family-less lease
    // that family cleanup then misses, or pass someone else's family and be
    // cleaned by the wrong one. Derive it here, reject a mismatch, and stamp the
    // derived value on everything below so the lease itself carries the truth.
    const authoritativeFamilyId = this.options.familyForRun?.(params.ownerRunId);
    if (
      authoritativeFamilyId !== undefined &&
      params.ownerFamilyId !== undefined &&
      params.ownerFamilyId !== authoritativeFamilyId
    ) {
      return {
        ok: false,
        conflict: {
          kind: 'invalid-request',
          capabilityId: entry.id,
          reason: `ownerFamilyId '${params.ownerFamilyId}' does not match the family of run '${params.ownerRunId}' ('${authoritativeFamilyId}')`,
        },
      };
    }
    const acquiringFamilyId = params.ownerFamilyId ?? authoritativeFamilyId;
    // Everything downstream — lease owner, events, dependency acquisitions —
    // uses the resolved family, never the caller's optional field.
    const ownedParams: RuntimeCapabilityAcquireParams =
      acquiringFamilyId === params.ownerFamilyId
        ? params
        : { ...params, ...(acquiringFamilyId ? { ownerFamilyId: acquiringFamilyId } : {}) };
    const fenced = this.fenceVerdict(params.ownerRunId, acquiringFamilyId);
    if (fenced) {
      // Fail closed. Handing a provider to a run that has already been torn down
      // leaks it: nothing will release it again.
      return {
        ok: false,
        conflict: {
          kind: 'invalid-request',
          capabilityId: entry.id,
          reason:
            fenced.scope === 'owner'
              ? `Run '${fenced.id}' has already had its terminal capability cleanup; it cannot acquire '${entry.id}'`
              : `Family '${fenced.id}' has already had its terminal capability cleanup; run '${params.ownerRunId}' cannot acquire '${entry.id}'`,
        },
      };
    }
    if (entry.availability.state !== 'available') {
      return {
        ok: false,
        conflict: {
          kind: 'unavailable',
          capabilityId: entry.id,
          reason: entry.availability.reason ?? 'provider unavailable',
        },
      };
    }
    if (params.proofRequirement.capabilityId !== params.capabilityId) {
      return {
        ok: false,
        conflict: {
          kind: 'invalid-request',
          capabilityId: entry.id,
          reason: 'proofRequirement.capabilityId must match capabilityId',
        },
      };
    }
    const parameters = params.parameters ?? params.proofRequirement.parameters ?? {};
    if (entry.parameters) {
      try {
        const validate = parameterValidator(entry.parameters);
        if (!validate(parameters)) {
          const issue = validate.errors?.[0];
          return {
            ok: false,
            conflict: {
              kind: 'invalid-request',
              capabilityId: entry.id,
              reason: `Capability parameters are invalid${
                issue ? ` at ${issue.instancePath || '/'}: ${issue.message ?? 'invalid value'}` : ''
              }`,
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          conflict: {
            kind: 'invalid-request',
            capabilityId: entry.id,
            reason: `Capability parameter schema is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
    }
    // Whether this acquire is heading for the claim queue below.
    //
    // The device guard refuses a second boot of one physical device outright,
    // which is the right answer when nobody is arbitrating. A scoped claim IS
    // that arbitration: the two acquires are contending for one declared
    // resource, and this caller has said it wants to wait its turn rather than
    // be told no. Running the guard first would refuse the exact contention the
    // queue exists to serialize, before the queue was ever consulted. With no
    // `queueOnConflict` the guard runs first and still refuses, unchanged — the
    // two rules never both answer for the same acquire.
    const willQueueOnClaim =
      params.queueOnConflict === true &&
      this.findClaimConflict(snapshot, catalog, entry, params.slotId) !== null &&
      !snapshot.leases.some(
        (lease) =>
          lease.slotId === params.slotId &&
          lease.capabilityId === entry.id &&
          lease.owner.runId === params.ownerRunId &&
          holdsClaim(lease),
      );
    // Asked for EVERY device-claiming acquire, not only one that names a
    // device. An ordinary acquire with no parameters resolves to the slot's own
    // configured device, and another slot may have re-targeted onto exactly
    // that device — in which case this acquire is the second boot. Skipping the
    // check for `{}` left the common case unguarded.
    if (
      this.options.assertTargetAvailable &&
      !willQueueOnClaim &&
      (Object.keys(parameters).length > 0 || claimsDevice(entry))
    ) {
      const refusal = await this.options.assertTargetAvailable({
        slotId: params.slotId,
        capabilityId: entry.id,
        ownerRunId: params.ownerRunId,
        parameters,
        claimsDevice: claimsDevice(entry),
        // Warm leases included: their provider is still up, so a target naming
        // that device would be adopted and then stopped by the warm sweeper.
        activeLeases: snapshot.leases.filter(runsProvider),
      });
      if (refusal) {
        return {
          ok: false,
          conflict: { kind: 'invalid-request', capabilityId: entry.id, reason: refusal },
        };
      }
    }
    const sameOwner = snapshot.leases.find(
      (lease) =>
        lease.slotId === params.slotId &&
        lease.capabilityId === entry.id &&
        lease.owner.runId === params.ownerRunId &&
        ACTIVE_STATES.has(lease.state),
    );
    let staleOwnerLease = false;
    if (sameOwner?.state === 'acquired') {
      if (!sameCapabilityParameters(sameOwner.parameters, parameters)) {
        // Say WHY the held lease exists when it is not this caller's own doing.
        // A device provider pinned as another capability's dependency is the
        // usual cause, and "different parameters" alone sent the operator
        // looking at the wrong requirement.
        const dependents = snapshot.leases
          .filter(
            (candidate) =>
              candidate.dependencyLeaseIds.includes(sameOwner.id) && blocksAcquisition(candidate),
          )
          .map((candidate) => candidate.capabilityId);
        return {
          ok: false,
          conflict: {
            kind: 'invalid-request',
            capabilityId: entry.id,
            reason: dependents.length
              ? `Existing idempotent lease has different parameters; it is held as a dependency of ${dependents.join(', ')}, which acquired it as ${stableJson(sameOwner.parameters)}`
              : 'Existing idempotent lease has different parameters',
          },
        };
      }
      // ADR-054: a validation or recipe rerun must prove the retained provider is
      // actually alive before it reuses the lease. Without this a provider that
      // died while the run waited would pass preparation and the action would run
      // against nothing.
      if (params.revalidateHealth) {
        const health = await this.runAction(
          params.slotId,
          entry.actions.health,
          sameOwner.parameters,
          entry,
        );
        sameOwner.updatedAt = this.timestamp();
        if (health.ok) {
          sameOwner.health = {
            state: 'healthy',
            checkedAt: sameOwner.updatedAt,
            ...(health.detail ? { detail: health.detail } : {}),
          };
          this.recordEvent(snapshot, {
            kind: 'health-changed',
            slotId: params.slotId,
            capabilityId: entry.id,
            leaseId: sameOwner.id,
            owner: sameOwner.owner,
            detail: 'retained provider revalidated healthy',
          });
          // A healthy parent proves nothing about what it runs on. Walk the
          // dependencies under the same revalidation so a dead one is cleaned up
          // and reacquired instead of silently passing preparation.
          const revalidatedDependencies: RuntimeCapabilityLease[] = [];
          for (const dependencyId of entry.dependencies ?? []) {
            const revalidateDependencyParameters = this.parametersForDependency(
              snapshot,
              ownedParams,
              dependencyId,
            );
            const dependency = await this.acquireInternal(
              snapshot,
              catalog,
              {
                ...ownedParams,
                capabilityId: dependencyId,
                proofRequirement: {
                  capabilityId: dependencyId,
                  reason: `Required by ${entry.id}: ${params.proofRequirement.reason}`,
                  mode: params.proofRequirement.mode,
                  ...(Object.keys(revalidateDependencyParameters).length > 0
                    ? { parameters: revalidateDependencyParameters }
                    : {}),
                },
                parameters: revalidateDependencyParameters,
                queueOnPressure: false,
                // A dependency never queues on its own. A parent that cannot
                // finish rolls its dependencies back, and a queued lease left
                // behind by that rollback would hold a place in line for an
                // acquire nobody is waiting on.
                queueOnConflict: false,
                revalidateHealth: true,
              },
              false,
            );
            if (!dependency.ok) return dependency;
            revalidatedDependencies.push(dependency.lease, ...dependency.dependencyLeases);
          }
          // Revalidation can replace a dependency lease (the dead one was
          // released and a fresh one acquired). Relink the parent, dropping ids
          // that no longer hold a provider: otherwise a parent-scoped release
          // walks a stale id and the replacement leaks.
          const replacementIds = new Set(revalidatedDependencies.map((lease) => lease.id));
          sameOwner.dependencyLeaseIds = [
            ...new Set([
              ...sameOwner.dependencyLeaseIds.filter((id) => {
                if (replacementIds.has(id)) return true;
                const existing = snapshot.leases.find((lease) => lease.id === id);
                return Boolean(existing && blocksAcquisition(existing));
              }),
              ...replacementIds,
            ]),
          ];
          sameOwner.updatedAt = this.timestamp();
          return {
            ok: true,
            lease: structuredClone(sameOwner),
            dependencyLeases: revalidatedDependencies,
            idempotent: true,
          };
        }
        // Unhealthy: clean the provider up before anything reuses it. A failed
        // cleanup is durable as an error lease and blocks the action.
        sameOwner.health = {
          state: 'unhealthy',
          checkedAt: sameOwner.updatedAt,
          ...(health.detail ? { detail: health.detail } : {}),
        };
        const otherHolders = snapshot.leases.some(
          (candidate) =>
            candidate.id !== sameOwner.id &&
            candidate.slotId === sameOwner.slotId &&
            candidate.capabilityId === sameOwner.capabilityId &&
            holdsProvider(candidate),
        );
        const cleanup = otherHolders
          ? { ok: true }
          : await this.runAction(params.slotId, entry.actions.release, sameOwner.parameters, entry);
        sameOwner.updatedAt = this.timestamp();
        if (!cleanup.ok) {
          sameOwner.state = 'error';
          sameOwner.cleanupFailure = cleanup.detail ?? 'unhealthy provider cleanup failed';
          this.recordEvent(snapshot, {
            kind: 'cleanup-failed',
            slotId: params.slotId,
            capabilityId: entry.id,
            leaseId: sameOwner.id,
            owner: sameOwner.owner,
            detail: sameOwner.cleanupFailure,
          });
          return {
            ok: false,
            conflict: {
              kind: 'unavailable',
              capabilityId: entry.id,
              reason: sameOwner.cleanupFailure,
            },
          };
        }
        sameOwner.state = 'released';
        sameOwner.releasedAt = sameOwner.updatedAt;
        sameOwner.referenceCount = 0;
        sameOwner.keepWarmUntil = undefined;
        staleOwnerLease = true;
        this.recordEvent(snapshot, {
          kind: 'released',
          slotId: params.slotId,
          capabilityId: entry.id,
          leaseId: sameOwner.id,
          owner: sameOwner.owner,
          detail: `unhealthy retained provider cleaned up before reacquire: ${
            health.detail ?? 'health check failed'
          }`,
        });
      } else {
        return {
          ok: true,
          lease: structuredClone(sameOwner),
          dependencyLeases: [],
          idempotent: true,
        };
      }
    }

    if (recordPlan) {
      const existingPlan = snapshot.proofPlans[params.ownerRunId];
      const requirements = existingPlan?.requirements ?? [];
      const withoutDuplicate = requirements.filter(
        (requirement) => requirement.capabilityId !== params.proofRequirement.capabilityId,
      );
      snapshot.proofPlans[params.ownerRunId] = {
        version: 1,
        slotId: params.slotId,
        ownerRunId: params.ownerRunId,
        createdAt: existingPlan?.createdAt ?? this.timestamp(),
        // The EFFECTIVE parameters, not just whatever the caller happened to put
        // on the requirement. `parameters` may arrive beside the requirement
        // rather than on it, and a plan that omits the device it was acquired
        // with is not replayable: the next validation-prepare reads this plan as
        // its default requirement set and would reacquire the slot's configured
        // device, or be refused for disagreeing with the lease it already holds.
        requirements: [
          ...withoutDuplicate,
          {
            ...structuredClone(params.proofRequirement),
            ...(Object.keys(parameters).length > 0
              ? { parameters: structuredClone(parameters) }
              : {}),
          },
        ],
      };
      this.recordEvent(snapshot, {
        kind: 'planned',
        slotId: params.slotId,
        capabilityId: entry.id,
        owner: {
          runId: params.ownerRunId,
          ...(acquiringFamilyId ? { familyId: acquiringFamilyId } : {}),
        },
        detail: params.proofRequirement.reason,
      });
    }

    const pressure = await this.options.pressureFor?.(
      params.slotId,
      entry,
      params.queueOnPressure === true,
    );
    if (pressure) {
      if (pressure.kind === 'host-pressure' && pressure.queued && !sameOwner) {
        const now = this.timestamp();
        const queuedLease = this.createLease(
          catalog,
          entry,
          ownedParams,
          parameters,
          [],
          now,
          'queued',
        );
        queuedLease.pressure = structuredClone(pressure);
        snapshot.leases.push(queuedLease);
        this.recordEvent(snapshot, {
          kind: 'queued',
          slotId: params.slotId,
          capabilityId: entry.id,
          leaseId: queuedLease.id,
          owner: queuedLease.owner,
          detail: pressure.reason,
        });
      }
      return { ok: false, conflict: pressure };
    }

    const active = snapshot.leases.filter(
      (lease) =>
        lease.slotId === params.slotId &&
        lease.capabilityId === entry.id &&
        blocksAcquisition(lease),
    );
    const uncertain = active.find(
      (lease) => lease.state === 'error' && Boolean(lease.cleanupFailure),
    );
    if (uncertain) {
      return {
        ok: false,
        conflict: {
          kind: 'lease-conflict',
          capabilityId: entry.id,
          owner: uncertain.owner,
          leaseId: uncertain.id,
          reason: `Capability '${entry.id}' has unresolved cleanup owned by ${uncertain.owner.runId}: ${uncertain.cleanupFailure}`,
        },
      };
    }
    const foreign = active.find((lease) => lease.owner.runId !== params.ownerRunId);
    if (entry.sharePolicy === 'exclusive' && foreign) {
      return {
        ok: false,
        conflict: {
          kind: 'lease-conflict',
          capabilityId: entry.id,
          owner: foreign.owner,
          leaseId: foreign.id,
          reason: `Exclusive capability '${entry.id}' is owned by ${foreign.owner.runId}`,
        },
      };
    }
    if (
      entry.sharePolicy === 'shared' &&
      foreign &&
      !sameCapabilityParameters(foreign.parameters, parameters)
    ) {
      return {
        ok: false,
        conflict: {
          kind: 'invalid-request',
          capabilityId: entry.id,
          reason: `Shared capability '${entry.id}' already has different active parameters`,
        },
      };
    }
    const claimConflict = this.findClaimConflict(snapshot, catalog, entry, params.slotId);
    if (claimConflict) {
      // The proof plan is already recorded above, so a queued run's plan is
      // replayable by the pre-validation retry exactly like an acquired one's.
      // An owner that already HOLDS the provider never queues; one that is
      // already queued re-enters `enqueueClaimWaiter`, which keeps its place.
      if (
        params.queueOnConflict === true &&
        (sameOwner === undefined || sameOwner.state === 'queued')
      ) {
        return this.enqueueClaimWaiter(
          snapshot,
          catalog,
          entry,
          ownedParams,
          parameters,
          claimConflict,
        );
      }
      return {
        ok: false,
        conflict: {
          kind: 'lease-conflict',
          capabilityId: entry.id,
          owner: claimConflict.holder.owner,
          leaseId: claimConflict.holder.id,
          reason: claimConflictReason(entry.id, claimConflict),
        },
      };
    }

    const existingLeaseIds = new Set(snapshot.leases.map((lease) => lease.id));
    const dependencyLeases: RuntimeCapabilityLease[] = [];
    for (const dependencyId of entry.dependencies ?? []) {
      const dependencyParameters = this.parametersForDependency(
        snapshot,
        ownedParams,
        dependencyId,
      );
      const requirement = {
        capabilityId: dependencyId,
        reason: `Required by ${entry.id}: ${params.proofRequirement.reason}`,
        mode: params.proofRequirement.mode,
        ...(Object.keys(dependencyParameters).length > 0
          ? { parameters: dependencyParameters }
          : {}),
      };
      const dependency = await this.acquireInternal(
        snapshot,
        catalog,
        {
          ...ownedParams,
          capabilityId: dependencyId,
          proofRequirement: requirement,
          parameters: dependencyParameters,
          queueOnPressure: false,
          // See the revalidation path: a dependency's queue place would outlive
          // the parent acquire that asked for it.
          queueOnConflict: false,
        },
        false,
      );
      if (!dependency.ok) {
        await this.rollbackLeases(
          snapshot,
          catalog,
          snapshot.leases
            .filter((lease) => !existingLeaseIds.has(lease.id))
            .map((lease) => lease.id),
        );
        return dependency;
      }
      dependencyLeases.push(dependency.lease, ...dependency.dependencyLeases);
    }

    // Any lease still carrying a keep-warm deadline, expired or not. An elapsed
    // deadline is a schedule, not proof the provider stopped: the sweeper may
    // not have run yet. Ignoring those started a second instance blind, so the
    // health check below decides — adopt it, or clean it up and acquire fresh.
    const warmLease = snapshot.leases.find(
      (candidate) =>
        candidate.slotId === params.slotId &&
        candidate.capabilityId === entry.id &&
        candidate.state === 'released' &&
        candidate.keepWarmUntil !== undefined,
    );
    // A warm lease from an older provider definition still describes a running
    // process. Filtering it out by digest left it running and started a second
    // one beside it. It is never adopted — the old definition's behaviour is not
    // the new one's — but it is cleaned up first, through its own lease record.
    const warmProvenanceChanged =
      warmLease !== undefined && warmLease.provenance.digest !== entry.provenance.digest;
    // A warm provider acquired for a DIFFERENT device is not this acquisition's
    // provider. It is never adopted, and it is never simply ignored either: its
    // process is still running, so it is cleaned up through its own lease — with
    // its own parameters — before the requested device is booted beside it.
    const warmParametersDiffer =
      warmLease !== undefined && !sameCapabilityParameters(warmLease.parameters, parameters);
    let warmProviderHealthy = false;
    if (active.length === 0 && warmLease) {
      const warmHealth = warmProvenanceChanged
        ? { ok: false, detail: 'warm provider predates the current provider definition' }
        : warmParametersDiffer
          ? {
              ok: false,
              detail: `warm provider was acquired for a different device target (${stableJson(
                warmLease.parameters,
              )})`,
            }
          : // Probed with the WARM lease's own parameters: the question is
            // whether THAT provider is still up, not whether the requested one is.
            await this.runAction(params.slotId, entry.actions.health, warmLease.parameters, entry);
      warmProviderHealthy = warmHealth.ok;
      if (warmHealth.ok) {
        warmLease.keepWarmUntil = undefined;
      } else {
        const staleEntry = warmProvenanceChanged
          ? catalog.capabilities.find(
              (capability) => capability.provenance.digest === warmLease.provenance.digest,
            )
          : undefined;
        if (warmProvenanceChanged && !staleEntry) {
          // Fail closed. The definition that started this provider is gone from
          // the catalog, so the only release action on hand belongs to a
          // different definition. If its target changed, running it stops the
          // wrong thing, leaves the old provider up, and a second one starts
          // beside it — while the acquire reports success. Refuse instead, and
          // say what the operator has to do.
          warmLease.state = 'error';
          warmLease.cleanupFailure =
            `Warm provider was started by a provider definition (digest ${warmLease.provenance.digest}) ` +
            `that is no longer in the ${catalog.project} catalog, so its own release action is unavailable ` +
            'and cleanup was refused rather than guessed from the current definition. Stop the provider, ' +
            'then retry.';
          warmLease.keepWarmUntil = undefined;
          warmLease.updatedAt = this.timestamp();
          this.recordEvent(snapshot, {
            kind: 'recovery-rejected',
            slotId: warmLease.slotId,
            capabilityId: warmLease.capabilityId,
            leaseId: warmLease.id,
            owner: warmLease.owner,
            detail: warmLease.cleanupFailure,
          });
          await this.rollbackLeases(
            snapshot,
            catalog,
            snapshot.leases
              .filter((lease) => !existingLeaseIds.has(lease.id))
              .map((lease) => lease.id),
          );
          return {
            ok: false,
            conflict: {
              kind: 'unavailable',
              capabilityId: entry.id,
              reason: `${warmLease.cleanupFailure} (lease ${warmLease.id})`,
            },
          };
        }
        const cleanup = await this.runAction(
          params.slotId,
          (staleEntry ?? entry).actions.release,
          warmLease.parameters,
          staleEntry ?? entry,
        );
        warmLease.keepWarmUntil = undefined;
        if (!cleanup.ok) {
          warmLease.state = 'error';
          warmLease.cleanupFailure = cleanup.detail ?? 'warm-provider cleanup failed';
          warmLease.updatedAt = this.timestamp();
          await this.rollbackLeases(
            snapshot,
            catalog,
            snapshot.leases
              .filter((lease) => !existingLeaseIds.has(lease.id))
              .map((lease) => lease.id),
          );
          return {
            ok: false,
            conflict: {
              kind: 'unavailable',
              capabilityId: entry.id,
              reason: warmLease.cleanupFailure,
            },
          };
        }
      }
    }

    const now = this.timestamp();
    const reusableOwnerLease = staleOwnerLease ? undefined : sameOwner;
    const lease =
      reusableOwnerLease ??
      this.createLease(
        catalog,
        entry,
        ownedParams,
        parameters,
        dependencyLeases.map((dependency) => dependency.id),
        now,
        'acquiring',
      );
    if (!reusableOwnerLease) snapshot.leases.push(lease);
    if (reusableOwnerLease) {
      lease.parameters = structuredClone(parameters);
      lease.dependencyLeaseIds = [
        ...new Set([
          ...lease.dependencyLeaseIds,
          ...dependencyLeases.map((dependency) => dependency.id),
        ]),
      ];
    }
    lease.state = 'acquiring';
    lease.pressure = undefined;
    // A lease that is acquiring is no longer in line for anything.
    lease.wait = undefined;
    lease.updatedAt = now;
    this.recordEvent(snapshot, {
      kind: 'acquiring',
      slotId: params.slotId,
      capabilityId: entry.id,
      leaseId: lease.id,
      owner: lease.owner,
    });
    await this.persist(snapshot);

    const providerAlreadyActive = active.some(
      (candidate) =>
        candidate.id !== lease.id &&
        candidate.state !== 'queued' &&
        candidate.state !== 'releasing',
    );
    const shouldRunAcquire = !providerAlreadyActive && !warmProviderHealthy;
    if (shouldRunAcquire) {
      const acquired = await this.runAction(
        params.slotId,
        entry.actions.acquire,
        parameters,
        entry,
      );
      if (!acquired.ok) {
        lease.updatedAt = this.timestamp();
        lease.health = { state: 'unhealthy', checkedAt: lease.updatedAt, detail: acquired.detail };
        this.recordEvent(snapshot, {
          kind: 'health-changed',
          slotId: params.slotId,
          capabilityId: entry.id,
          leaseId: lease.id,
          owner: lease.owner,
          detail: `Acquire failed: ${acquired.detail ?? 'provider action failed'}`,
        });
        await this.rollbackLeases(snapshot, catalog, [
          ...snapshot.leases
            .filter((candidate) => !existingLeaseIds.has(candidate.id))
            .map((candidate) => candidate.id),
          lease.id,
        ]);
        return {
          ok: false,
          conflict: {
            kind: 'unavailable',
            capabilityId: entry.id,
            reason: acquired.detail ?? 'provider acquire action failed',
          },
        };
      }
    }
    const health = await this.runAction(params.slotId, entry.actions.health, parameters, entry);
    if (!health.ok) {
      lease.updatedAt = this.timestamp();
      lease.health = { state: 'unhealthy', checkedAt: lease.updatedAt, detail: health.detail };
      this.recordEvent(snapshot, {
        kind: 'health-changed',
        slotId: params.slotId,
        capabilityId: entry.id,
        leaseId: lease.id,
        owner: lease.owner,
        detail: `Health failed: ${health.detail ?? 'provider health action failed'}`,
      });
      await this.rollbackLeases(snapshot, catalog, [
        ...snapshot.leases
          .filter((candidate) => !existingLeaseIds.has(candidate.id))
          .map((candidate) => candidate.id),
        lease.id,
      ]);
      return {
        ok: false,
        conflict: {
          kind: 'unavailable',
          capabilityId: entry.id,
          reason: health.detail ?? 'provider health action failed',
        },
      };
    }
    lease.state = 'acquired';
    lease.acquiredAt = lease.acquiredAt ?? this.timestamp();
    lease.updatedAt = this.timestamp();
    lease.health = {
      state: 'healthy',
      checkedAt: lease.updatedAt,
      ...(health.detail ? { detail: health.detail } : {}),
    };
    this.updateReferenceCounts(snapshot, params.slotId, entry.id);
    this.recordEvent(snapshot, {
      kind: 'acquired',
      slotId: params.slotId,
      capabilityId: entry.id,
      leaseId: lease.id,
      owner: lease.owner,
      detail: shouldRunAcquire
        ? 'provider acquired and healthy'
        : warmProviderHealthy
          ? 'adopted healthy keep-warm provider'
          : 'joined healthy shared provider',
    });
    return { ok: true, lease: structuredClone(lease), dependencyLeases, idempotent: false };
  }

  private createLease(
    catalog: RuntimeCapabilityCatalogContext,
    entry: RuntimeCapabilityCatalogEntry,
    /** Callers pass the family-resolved params, never the raw request. */
    params: RuntimeCapabilityAcquireParams,
    parameters: Record<string, unknown>,
    dependencyLeaseIds: string[],
    now: string,
    state: RuntimeCapabilityLease['state'],
  ): RuntimeCapabilityLease {
    return {
      id: this.leaseId(),
      slotId: params.slotId,
      project: catalog.project,
      capabilityId: entry.id,
      owner: {
        runId: params.ownerRunId,
        ...(params.ownerFamilyId ? { familyId: params.ownerFamilyId } : {}),
      },
      state,
      referenceCount: 1,
      parameters: structuredClone(parameters),
      provenance: structuredClone(entry.provenance),
      health: { state: 'unknown' },
      dependencyLeaseIds,
      updatedAt: now,
      // Resolved from the catalog HERE, once, and persisted. Judging this
      // lease's claims from another slot later would otherwise need that
      // slot's catalog — possibly from another project, possibly mid-write.
      ...(catalog.machine ? { machine: catalog.machine } : {}),
      claims: claimsOfEntry(entry),
    };
  }

  /**
   * The claims a lease holds, as it holds them.
   *
   * `lease.claims` is the authority: it is what the catalog said when the lease
   * was taken, so a catalog edit since then cannot rewrite what is already
   * running. A lease with no `claims` was written before scopes existed; it is
   * read from the catalog only when it is on the acquiring slot, which is
   * exactly the arbitration it had then, and contributes nothing across slots.
   */
  private claimsHeldByLease(
    lease: RuntimeCapabilityLease,
    catalog: RuntimeCapabilityCatalogContext,
    sameSlot: boolean,
  ): RuntimeCapabilityLeaseClaim[] {
    if (lease.claims) return lease.claims;
    if (!sameSlot) return [];
    const holder = catalog.capabilities.find((capability) => capability.id === lease.capabilityId);
    return holder ? claimsOfEntry(holder) : [];
  }

  /**
   * The first live lease whose claims collide with what this entry wants.
   *
   * The same provider on the same slot is deliberately skipped: that is share
   * policy, decided by the exclusive/shared checks above, and counting it here
   * would make every second reference of a shared provider a resource conflict.
   * The same provider on ANOTHER slot is not skipped — two slots each running
   * `recording` against one fleet-scoped helper is precisely the contention
   * this exists to catch.
   */
  private findClaimConflict(
    snapshot: RuntimeCapabilityStoreSnapshot,
    catalog: RuntimeCapabilityCatalogContext,
    entry: RuntimeCapabilityCatalogEntry,
    slotId: string,
  ): ClaimConflict | null {
    const requested = new Map(entry.cost.resources.map((claim) => [claim.id, claim]));
    if (requested.size === 0) return null;
    for (const lease of snapshot.leases) {
      const sameSlot = lease.slotId === slotId;
      if (sameSlot && lease.capabilityId === entry.id) continue;
      if (!holdsClaim(lease)) continue;
      for (const held of this.claimsHeldByLease(lease, catalog, sameSlot)) {
        const wanted = requested.get(held.id);
        if (!wanted) continue;
        if (wanted.access !== 'exclusive' && held.access !== 'exclusive') continue;
        const scope = widerRuntimeCapabilityClaimScope(
          runtimeCapabilityClaimScope(wanted),
          held.scope,
        );
        if (!claimReachesSlot(lease, scope, slotId, catalog.machine)) continue;
        return { holder: lease, claimId: held.id, scope, crossSlot: !sameSlot };
      }
    }
    return null;
  }

  /**
   * Take a place in line behind a scoped claim, and say where that place is.
   *
   * An owner that is already queued for this claim keeps its ORIGINAL
   * `enqueuedAt`: preparation retries, and a retry that re-enqueued would send
   * the run to the back of the queue every time it asked how it was doing.
   */
  private enqueueClaimWaiter(
    snapshot: RuntimeCapabilityStoreSnapshot,
    catalog: RuntimeCapabilityCatalogContext,
    entry: RuntimeCapabilityCatalogEntry,
    params: RuntimeCapabilityAcquireParams,
    parameters: Record<string, unknown>,
    conflict: ClaimConflict,
  ): RuntimeCapabilityAcquireResult {
    const now = this.timestamp();
    const existing = snapshot.leases.find(
      (lease) =>
        lease.slotId === params.slotId &&
        lease.capabilityId === entry.id &&
        lease.owner.runId === params.ownerRunId &&
        scopedWaitOf(lease)?.claimId === conflict.claimId,
    );
    const reason = claimConflictReason(entry.id, conflict);
    const wait: RuntimeCapabilityScopedClaimWait = {
      kind: 'scoped-claim',
      claimId: conflict.claimId,
      scope: conflict.scope,
      blockingOwner: structuredClone(conflict.holder.owner),
      blockingLeaseId: conflict.holder.id,
      enqueuedAt: scopedWaitOf(existing ?? ({} as RuntimeCapabilityLease))?.enqueuedAt ?? now,
    };
    let lease = existing;
    if (lease) {
      // Only who is blocking is refreshed; the queue place is not.
      lease.wait = wait;
      lease.updatedAt = now;
    } else {
      lease = this.createLease(catalog, entry, params, parameters, [], now, 'queued');
      lease.wait = wait;
      snapshot.leases.push(lease);
      this.recordEvent(snapshot, {
        kind: 'queued',
        slotId: params.slotId,
        capabilityId: entry.id,
        leaseId: lease.id,
        owner: lease.owner,
        detail: reason,
      });
    }
    this.pendingWaiters.set(lease.id, { params: { ...params, parameters }, wait });
    const position =
      claimQueueOrder(snapshot.leases, conflict.claimId).findIndex(
        (candidate) => candidate.id === lease!.id,
      ) + 1;
    return {
      ok: false,
      conflict: {
        kind: 'scoped-wait',
        capabilityId: entry.id,
        claimId: conflict.claimId,
        scope: conflict.scope,
        owner: structuredClone(conflict.holder.owner),
        leaseId: conflict.holder.id,
        queuedLeaseId: lease.id,
        position,
        reason,
      },
    };
  }

  /**
   * Hand each claim this release actually freed to the head of its queue.
   *
   * Runs inside the release's own mutation, before the snapshot is persisted,
   * so the promotion lands in the same write as the release that caused it and
   * no acquire can slip between the two. Exactly one waiter is promoted per
   * freed claim, and only to `acquiring`: the provider has not booted yet, and
   * saying `acquired` here would report a live device that does not exist.
   *
   * Returns the leases whose provider boot must now run OUTSIDE this lock.
   */
  private drainClaimQueue(
    snapshot: RuntimeCapabilityStoreSnapshot,
    releasedLeases: readonly RuntimeCapabilityLease[],
    catalog: RuntimeCapabilityCatalogContext,
  ): string[] {
    const freed = new Set<string>();
    for (const lease of releasedLeases) {
      for (const claim of this.claimsHeldByLease(lease, catalog, true)) freed.add(claim.id);
    }
    const resumed: string[] = [];
    for (const claimId of [...freed].sort()) {
      for (const waiter of claimQueueOrder(snapshot.leases, claimId)) {
        // A queue place handed to a run that is already gone is a leak: nothing
        // would ever release the provider it is about to be given. Dropped
        // outright, with no provider action, because a queued lease has none.
        if (this.isFencedOwner(waiter.owner.runId, waiter.owner.familyId)) {
          waiter.state = 'released';
          waiter.updatedAt = this.timestamp();
          waiter.releasedAt = waiter.updatedAt;
          waiter.referenceCount = 0;
          waiter.wait = undefined;
          this.pendingWaiters.delete(waiter.id);
          this.recordEvent(snapshot, {
            kind: 'released',
            slotId: waiter.slotId,
            capabilityId: waiter.capabilityId,
            leaseId: waiter.id,
            owner: waiter.owner,
            detail: `queue slot for '${claimId}' dropped: owner run '${waiter.owner.runId}' already had its terminal capability cleanup`,
          });
          continue;
        }
        // Another holder may still have the claim at this waiter's scope — a
        // third slot, or a sibling capability on its own. Stop at the head
        // rather than skipping past it: the queue is FIFO, and serving someone
        // further back because the head is still blocked is not.
        if (this.claimStillHeld(snapshot, waiter, claimId)) break;
        waiter.state = 'acquiring';
        waiter.wait = undefined;
        waiter.updatedAt = this.timestamp();
        this.recordEvent(snapshot, {
          kind: 'acquiring',
          slotId: waiter.slotId,
          capabilityId: waiter.capabilityId,
          leaseId: waiter.id,
          owner: waiter.owner,
          detail: `resource '${claimId}' was released; next in queue may acquire`,
        });
        resumed.push(waiter.id);
        break;
      }
    }
    return resumed;
  }

  /**
   * Whether anything still holds `claimId` in a way that reaches this waiter.
   *
   * Reads only persisted `claims`, never a catalog: the waiter can be on any
   * slot, and loading a foreign project's config here would put a file read
   * inside the release lock. Every lease taken since scoped claims landed
   * carries its claims, so the only blind spot is a lease that predates them
   * and is still live — and those arbitrate at slot scope, where the waiter's
   * own re-check at resume catches them.
   */
  private claimStillHeld(
    snapshot: RuntimeCapabilityStoreSnapshot,
    waiter: RuntimeCapabilityLease,
    claimId: string,
  ): boolean {
    const wanted = waiter.claims?.find((claim) => claim.id === claimId);
    if (!wanted) return false;
    return snapshot.leases.some((lease) => {
      if (lease.id === waiter.id) return false;
      const sameSlot = lease.slotId === waiter.slotId;
      if (sameSlot && lease.capabilityId === waiter.capabilityId) return false;
      if (!holdsClaim(lease)) return false;
      const held = lease.claims?.find((claim) => claim.id === claimId);
      if (!held) return false;
      if (wanted.access !== 'exclusive' && held.access !== 'exclusive') return false;
      const scope = widerRuntimeCapabilityClaimScope(wanted.scope, held.scope);
      return claimReachesSlot(lease, scope, waiter.slotId, waiter.machine);
    });
  }

  /**
   * Finish a promoted waiter's acquire, outside the release that promoted it.
   *
   * Re-enters the normal acquire path, which finds the promoted lease as this
   * owner's own `acquiring` lease and drives it through the provider actions.
   * A re-conflict puts the lease back in the queue at its ORIGINAL place rather
   * than dropping it: the claim it was promoted for is real, and losing the
   * place would send a run that has already waited to the back of the line.
   */
  private async resumeQueuedAcquire(leaseId: string): Promise<void> {
    const pending = this.pendingWaiters.get(leaseId);
    if (!pending) return;
    this.pendingWaiters.delete(leaseId);
    await this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const lease = snapshot.leases.find((candidate) => candidate.id === leaseId);
      // Something else already moved it — a terminal cleanup, a slot release.
      if (!lease || lease.state !== 'acquiring') return;
      let requeueReason: string | undefined;
      try {
        const catalog = await this.options.catalogForSlot(pending.params.slotId);
        const result = await this.acquireInternal(
          snapshot,
          catalog,
          { ...pending.params, queueOnConflict: false, queueOnPressure: false },
          false,
        );
        if (!result.ok) requeueReason = result.conflict.reason;
      } catch (error) {
        // Handled, not swallowed: the catalog is what says how to boot this
        // provider, so without it the promotion cannot be completed. The waiter
        // keeps its place and the reason is on the record.
        requeueReason = `project capability catalog unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      // A failure that ran the rollback has already moved the lease off
      // `acquiring`; only a refusal that never touched it needs requeueing.
      if (requeueReason !== undefined && lease.state === 'acquiring') {
        lease.state = 'queued';
        lease.wait = pending.wait;
        lease.updatedAt = this.timestamp();
        this.pendingWaiters.set(lease.id, pending);
        this.recordEvent(snapshot, {
          kind: 'queued',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: `promotion could not complete, queue place kept: ${requeueReason}`,
        });
      }
      await this.persist(snapshot);
    });
  }

  /**
   * Waiter promotions still in flight, chained so they run one at a time.
   *
   * Awaitable through `settleQueuedResumes` for callers that need the queue
   * quiet — tests, and anything draining before shutdown. No RPC waits on it:
   * a release must never block on a foreign run's provider boot.
   */
  private resumeTail: Promise<void> = Promise.resolve();

  /** Resolve once every promotion scheduled so far has finished. */
  async settleQueuedResumes(): Promise<void> {
    await this.resumeTail;
  }

  private scheduleQueuedResumes(leaseIds: readonly string[]): void {
    for (const leaseId of leaseIds) {
      this.resumeTail = this.resumeTail
        .then(() => this.resumeQueuedAcquire(leaseId))
        .catch((error: unknown) => {
          // Every failure the resume can reason about is handled inside it, by
          // putting the waiter back in the queue with the reason on the record.
          // Reaching here means the STORE WRITE itself failed, which no in-memory
          // recovery can repair — so it is reported rather than hidden, and the
          // durable queued lease is what the owner's next retry finds.
          console.warn(
            `[runtime-capabilities] queued acquisition ${leaseId} could not resume: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  }

  private updateReferenceCounts(
    snapshot: RuntimeCapabilityStoreSnapshot,
    slotId: string,
    capabilityId: string,
  ): void {
    const active = snapshot.leases.filter(
      (lease) =>
        lease.slotId === slotId &&
        lease.capabilityId === capabilityId &&
        lease.state === 'acquired',
    );
    for (const lease of active) lease.referenceCount = active.length;
  }

  private async rollbackLeases(
    snapshot: RuntimeCapabilityStoreSnapshot,
    catalog: RuntimeCapabilityCatalogContext,
    leaseIds: string[],
  ): Promise<void> {
    const selectedIds = new Set(leaseIds);
    const roots = snapshot.leases.filter(
      (lease) => selectedIds.has(lease.id) && ACTIVE_STATES.has(lease.state),
    );
    const order = this.releaseOrder(snapshot, roots).filter((lease) => selectedIds.has(lease.id));

    for (const lease of order) {
      const entry = catalog.capabilities.find((capability) => capability.id === lease.capabilityId);
      if (!entry) {
        lease.state = 'error';
        lease.cleanupFailure = 'Provider is no longer in the project capability catalog';
        lease.updatedAt = this.timestamp();
        this.recordEvent(snapshot, {
          kind: 'cleanup-failed',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: lease.cleanupFailure,
        });
        continue;
      }
      const stillRequired = snapshot.leases.some(
        (candidate) =>
          candidate.id !== lease.id &&
          !selectedIds.has(candidate.id) &&
          ACTIVE_STATES.has(candidate.state) &&
          candidate.dependencyLeaseIds.includes(lease.id),
      );
      if (stillRequired) continue;
      const otherHolders = snapshot.leases.some(
        (candidate) =>
          candidate.id !== lease.id &&
          !selectedIds.has(candidate.id) &&
          candidate.slotId === lease.slotId &&
          candidate.capabilityId === lease.capabilityId &&
          holdsProvider(candidate),
      );
      const previousState = lease.state;
      lease.state = 'releasing';
      lease.updatedAt = this.timestamp();
      this.recordEvent(snapshot, {
        kind: 'releasing',
        slotId: lease.slotId,
        capabilityId: lease.capabilityId,
        leaseId: lease.id,
        owner: lease.owner,
        detail: 'rolling back failed capability acquisition',
      });
      await this.persist(snapshot);

      const cleanup =
        otherHolders || previousState === 'queued'
          ? { ok: true }
          : await this.runAction(lease.slotId, entry.actions.release, lease.parameters, entry);
      lease.updatedAt = this.timestamp();
      if (!cleanup.ok) {
        lease.state = 'error';
        lease.cleanupFailure = cleanup.detail ?? 'acquisition rollback failed';
        this.recordEvent(snapshot, {
          kind: 'cleanup-failed',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: lease.cleanupFailure,
        });
        continue;
      }
      lease.state = 'released';
      lease.releasedAt = lease.updatedAt;
      lease.referenceCount = 0;
      this.recordEvent(snapshot, {
        kind: 'released',
        slotId: lease.slotId,
        capabilityId: lease.capabilityId,
        leaseId: lease.id,
        owner: lease.owner,
        detail: 'failed acquisition rolled back',
      });
      this.updateReferenceCounts(snapshot, lease.slotId, lease.capabilityId);
    }
  }

  async release(params: RuntimeCapabilityReleaseParams): Promise<RuntimeCapabilityReleaseResult> {
    const force = params.force === true;
    // `force` historically meant both "bypass provenance" and "bypass keep-warm".
    // ADR-054 splits the second half into `keepWarm`; unset keeps the old behaviour.
    const keepWarm = params.keepWarm ?? !force;
    return this.releaseSelected(
      params.slotId,
      (lease) =>
        lease.owner.runId === params.ownerRunId &&
        (!params.capabilityId || lease.capabilityId === params.capabilityId) &&
        (!params.leaseId || lease.id === params.leaseId),
      { force, keepWarmFor: () => keepWarm },
    );
  }

  async releaseFamily(slotId: string, familyId: string): Promise<RuntimeCapabilityReleaseResult> {
    return this.releaseSelected(slotId, (lease) => lease.owner.familyId === familyId, {
      force: false,
      keepWarmFor: () => true,
    });
  }

  async releaseRunAndFamily(
    slotId: string,
    ownerRunId: string,
    familyId: string,
  ): Promise<RuntimeCapabilityReleaseResult> {
    return this.releaseSelected(
      slotId,
      (lease) => lease.owner.runId === ownerRunId || lease.owner.familyId === familyId,
      { force: false, keepWarmFor: () => true },
    );
  }

  async releaseSlot(slotId: string): Promise<RuntimeCapabilityReleaseResult> {
    return this.releaseSelected(slotId, () => true, { force: false, keepWarmFor: () => true });
  }

  /**
   * One dependency-ordered release pass with a per-lease keep-warm decision, so
   * a posture that warms one provider and stops another cannot reorder them
   * across two calls (ADR-054). Leases pulled in as dependencies but not named
   * by the caller keep the project's own keep-warm policy.
   */
  /**
   * Terminal cleanup for one run and its family.
   *
   * Selection is by owner and is evaluated INSIDE the mutation lock, not from a
   * lease list the caller read earlier. That matters: `status` does not take the
   * lock, so a caller that snapshots lease ids while an acquire is in flight
   * misses every lease that reaches `acquired` afterwards, and those leases then
   * outlive the run — a cancelled run was observed holding a simulator and Metro
   * this way. Queuing on the lock means any in-flight acquire finishes first and
   * this sees its result.
   *
   * The owner is also fenced, so a later acquire cannot hand a provider to a run
   * that is already terminal.
   */
  async releaseRunTerminal(
    slotId: string,
    ownerRunId: string,
    familyId?: string,
  ): Promise<RuntimeCapabilityReleaseResult> {
    // Fence before releasing, not after: an acquire queued behind this release
    // would otherwise slip in the moment it finishes. The family is fenced as a
    // whole because the whole family is what this cleans, so a sibling cannot
    // reacquire on the way out.
    this.fenceOwner(ownerRunId);
    if (familyId !== undefined) this.fenceFamily(familyId);
    const result = await this.releaseSelected(
      slotId,
      (lease) =>
        lease.owner.runId === ownerRunId ||
        (familyId !== undefined && lease.owner.familyId === familyId),
      // Terminal bypasses keep-warm by definition (ADR-054).
      { force: false, keepWarmFor: () => false },
    );
    // Fence every owner this cleanup covered, read back from the store rather
    // than from the result: a lease whose cleanup FAILED appears in neither
    // `released` nor `retained`, and that owner is exactly the one that must not
    // be allowed to acquire again.
    for (const lease of this.options.store.snapshot().leases) {
      if (lease.slotId !== slotId) continue;
      if (
        lease.owner.runId === ownerRunId ||
        (familyId !== undefined && lease.owner.familyId === familyId)
      ) {
        this.fenceOwner(lease.owner.runId);
      }
    }
    return result;
  }

  // No count bound on either: entries retire by AGE in the store. A count bound
  // evicted the oldest owners, which are exactly the ones whose run records
  // archiving has already deleted, so the run-store fallback meant to cover
  // eviction was blind precisely where eviction bit.
  private fenceOwner(ownerRunId: string): void {
    if (!this.terminatedOwners.has(ownerRunId)) {
      this.terminatedOwners.set(ownerRunId, this.timestamp());
    }
  }

  private fenceFamily(familyId: string): void {
    if (!this.terminatedFamilies.has(familyId)) {
      this.terminatedFamilies.set(familyId, this.timestamp());
    }
  }

  /**
   * Whether this owner has already had its terminal capability cleanup.
   *
   * Two sources, and the second is the one that makes the fence hold. The sets
   * are a bounded fast path — they survive restart now because `persist` writes
   * them, but they still evict — so an owner that fell out of them is checked
   * against the run store, which knows from terminal status and persisted
   * posture and never forgets.
   */
  private isFencedOwner(ownerRunId: string, familyId?: string): boolean {
    return this.fenceVerdict(ownerRunId, familyId) !== null;
  }

  /**
   * Which half of the fence refuses this acquire, or null when neither does.
   *
   * Returned rather than collapsed to a boolean so the refusal can say what is
   * actually true. The message used to claim the requesting run had already had
   * its own terminal cleanup even when it was a live sibling refused by the
   * family fence, which sent operators looking for a cleanup that never
   * happened.
   */
  private fenceVerdict(
    ownerRunId: string,
    familyId?: string,
  ): { scope: 'owner' | 'family'; id: string } | null {
    if (this.terminatedOwners.has(ownerRunId)) return { scope: 'owner', id: ownerRunId };
    // The owner predicate is a SUPPLEMENT, not the authority: it answers for a
    // run the store still has, and the durable entries answer for the rest.
    // Correct at owner scope because a terminal run must never reacquire under
    // its own id, whatever its cleanup history.
    if (this.options.isTerminalOwner?.(ownerRunId) === true) {
      return { scope: 'owner', id: ownerRunId };
    }
    if (familyId === undefined) return null;
    // Family scope has NO run-store equivalent, deliberately. Asking whether any
    // member is terminal fenced live children: a CI-watch chain's follow-up run
    // shares its parent's family, so the parent reaching `done` refused its own
    // child at PREPARE. Only a family-scope cleanup writes this, and only that
    // is read back.
    if (this.terminatedFamilies.has(familyId)) return { scope: 'family', id: familyId };
    return null;
  }

  async releaseForPosture(
    slotId: string,
    dispositions: Array<{ leaseId: string; keepWarm: boolean }>,
  ): Promise<RuntimeCapabilityReleaseResult> {
    const wanted = new Map(dispositions.map((entry) => [entry.leaseId, entry.keepWarm]));
    return this.releaseSelected(slotId, (lease) => wanted.has(lease.id), {
      force: false,
      keepWarmFor: (lease) => wanted.get(lease.id) ?? true,
      // The posture already decided every lease individually. Pulling a
      // dependency in because its parent is going would override a policy that
      // says the dependency stays acquired.
      expandDependencies: false,
    });
  }

  private async releaseSelected(
    slotId: string,
    select: (lease: RuntimeCapabilityLease) => boolean,
    options: {
      force: boolean;
      keepWarmFor: (lease: RuntimeCapabilityLease) => boolean;
      /**
       * Whether releasing a lease also releases the dependencies it pulled in.
       * True for ownership-shaped releases ("this run is done with X"), false
       * when the caller has already resolved a disposition per lease: a
       * dependency the policy says stays acquired must survive its parent
       * being released (ADR-054).
       */
      expandDependencies?: boolean;
    },
  ): Promise<RuntimeCapabilityReleaseResult> {
    const { force, keepWarmFor } = options;
    const expandDependencies = options.expandDependencies !== false;
    // Filled by the drain inside the mutation, acted on outside it: a promoted
    // waiter's provider boot takes minutes and must not run under this lock.
    const promoted: string[] = [];
    const result = await this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const catalog = await this.options.catalogForSlot(slotId);
      const roots = snapshot.leases.filter(
        (lease) => lease.slotId === slotId && blocksAcquisition(lease) && select(lease),
      );
      const rootIds = new Set(roots.map((lease) => lease.id));
      const ordered = this.releaseOrder(snapshot, roots);
      const order = expandDependencies ? ordered : ordered.filter((lease) => rootIds.has(lease.id));
      const released: RuntimeCapabilityLease[] = [];
      const retained: RuntimeCapabilityLease[] = [];
      const effects = new Set<string>();
      const failures: RuntimeCapabilityReleaseResult['failures'] = [];
      // Leases that did not actually go away: they failed to release, or they
      // were retained because something that failed still needs them. Either way
      // they still hold their own dependencies, so the chain must propagate.
      const stillHolding = new Set<string>();
      const selectedIds = new Set(order.map((lease) => lease.id));

      for (const lease of order) {
        const entry = catalog.capabilities.find(
          (capability) => capability.id === lease.capabilityId,
        );
        if (!entry) {
          lease.state = 'error';
          lease.cleanupFailure = 'Provider is no longer in the project capability catalog';
          lease.updatedAt = this.timestamp();
          failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'cleanup-failed',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        if (entry.provenance.digest !== lease.provenance.digest && !force) {
          lease.state = 'error';
          lease.cleanupFailure = 'Provider provenance changed; cleanup refused';
          lease.updatedAt = this.timestamp();
          failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'recovery-rejected',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        const stillRequired = snapshot.leases.some(
          (candidate) =>
            candidate.id !== lease.id &&
            // A selected lease that failed to release did not go away: it still
            // holds whatever it depends on. Treating it as gone would stop a
            // dependency out from under a provider that is demonstrably still up.
            (!selectedIds.has(candidate.id) || stillHolding.has(candidate.id)) &&
            blocksAcquisition(candidate) &&
            candidate.dependencyLeaseIds.includes(lease.id),
        );
        if (stillRequired) {
          retained.push(structuredClone(lease));
          // Retained means still up. Anything it depends on is still in use, so
          // the whole chain below it has to be protected too (A -> B -> C: a
          // failed A retains B, and B must then retain C).
          stillHolding.add(lease.id);
          continue;
        }
        const otherHolders = snapshot.leases.filter(
          (candidate) =>
            candidate.id !== lease.id &&
            candidate.slotId === lease.slotId &&
            candidate.capabilityId === lease.capabilityId &&
            holdsProvider(candidate),
        );
        const previousState = lease.state;
        lease.state = 'releasing';
        lease.updatedAt = this.timestamp();
        this.recordEvent(snapshot, {
          kind: 'releasing',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
        });
        await this.persist(snapshot);

        let actionResult: RuntimeCapabilityActionResult = { ok: true };
        let releaseActionRan = false;
        if (
          otherHolders.length === 0 &&
          previousState !== 'error' &&
          previousState !== 'queued' &&
          entry.keepWarmMs &&
          keepWarmFor(lease)
        ) {
          lease.keepWarmUntil = new Date(this.now().getTime() + entry.keepWarmMs).toISOString();
        } else if (otherHolders.length === 0 && previousState !== 'queued') {
          releaseActionRan = true;
          // The provider is going away, so any earlier warm deadline is void.
          lease.keepWarmUntil = undefined;
          actionResult = await this.runAction(
            slotId,
            entry.actions.release,
            lease.parameters,
            entry,
          );
        }
        if (!actionResult.ok) {
          lease.state = 'error';
          lease.cleanupFailure = actionResult.detail ?? 'provider release action failed';
          lease.updatedAt = this.timestamp();
          failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'cleanup-failed',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        lease.state = 'released';
        lease.cleanupFailure = undefined;
        lease.releasedAt = this.timestamp();
        lease.updatedAt = lease.releasedAt;
        lease.referenceCount = 0;
        lease.health = { state: 'unknown', checkedAt: lease.releasedAt };
        released.push(structuredClone(lease));
        if (releaseActionRan) {
          for (const effect of entry.releaseEffects) effects.add(effect);
        }
        this.updateReferenceCounts(snapshot, lease.slotId, lease.capabilityId);
        this.recordEvent(snapshot, {
          kind: 'released',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: lease.keepWarmUntil
            ? `lease released; provider kept warm until ${lease.keepWarmUntil}`
            : 'provider released',
        });
      }
      // Inside the same mutation as the release, before the write: a waiter
      // promoted here lands in the identical snapshot as the release that
      // freed its claim, so no acquire can take the claim in between.
      promoted.push(...this.drainClaimQueue(snapshot, released, catalog));
      await this.persist(snapshot);
      return { ok: failures.length === 0, released, retained, effects: [...effects], failures };
    });
    this.scheduleQueuedResumes(promoted);
    return result;
  }

  /**
   * Stop providers that a released lease is still keeping warm, whatever their
   * deadline. A `terminal` posture must bypass keep-warm (ADR-054), and by then
   * the lease is already released, so the normal release path cannot see it.
   */
  async stopWarmProviders(slotId: string, capabilityIds?: string[]): Promise<WarmSweepSummary> {
    const wanted = capabilityIds ? new Set(capabilityIds) : null;
    return this.sweepWarmProviders(
      (lease) =>
        lease.slotId === slotId &&
        lease.keepWarmUntil !== undefined &&
        (!wanted || wanted.has(lease.capabilityId)),
    );
  }

  async cleanupExpiredWarmProviders(slotIds?: string[]): Promise<WarmSweepSummary> {
    const nowMs = this.now().getTime();
    return this.sweepWarmProviders(
      (lease) =>
        lease.keepWarmUntil !== undefined &&
        Date.parse(lease.keepWarmUntil) <= nowMs &&
        (!slotIds || slotIds.includes(lease.slotId)),
    );
  }

  private async sweepWarmProviders(
    select: (lease: RuntimeCapabilityLease) => boolean,
  ): Promise<WarmSweepSummary> {
    return this.mutate(async () => {
      const summary: WarmSweepSummary = {
        selected: [],
        deferred: [],
        released: [],
        stillHeld: [],
        failures: [],
        effects: [],
      };
      const snapshot = this.options.store.snapshot();
      const selected = snapshot.leases.filter(
        (lease) => lease.state === 'released' && select(lease),
      );
      // Warm providers are still real processes with real dependencies, so they
      // stop in the same dependency order as an ordinary release. Lease
      // insertion order is the opposite: `acquireInternal` creates dependencies
      // before their dependent, so iterating the array would stop a dependency
      // out from under something still using it.
      const selectedIds = new Set(selected.map((lease) => lease.id));
      // A dependency must outlive whatever still depends on it. With staggered
      // keep-warm windows the dependency can expire first, so defer it until the
      // dependent's own window ends rather than pulling the floor out from under
      // a provider that is still warm and reusable.
      const heldByWarmDependent = (lease: RuntimeCapabilityLease): boolean =>
        snapshot.leases.some(
          (candidate) =>
            candidate.id !== lease.id &&
            !selectedIds.has(candidate.id) &&
            candidate.dependencyLeaseIds.includes(lease.id) &&
            (blocksAcquisition(candidate) ||
              (candidate.state === 'released' && candidate.keepWarmUntil !== undefined)),
        );
      summary.selected = selected.map((lease) => structuredClone(lease));
      summary.deferred = selected
        .filter((lease) => heldByWarmDependent(lease))
        .map((lease) => structuredClone(lease));
      // Leases this sweep did not actually stop. Seeded with the ones a warm or
      // active dependent already holds, then extended as cleanups fail: a
      // provider that failed to stop is still up, so whatever it depends on is
      // still in use and must not be stopped beneath it.
      const stillHolding = new Set<string>();
      const eligible = selected.filter((lease) => {
        if (!heldByWarmDependent(lease)) return true;
        stillHolding.add(lease.id);
        return false;
      });
      const eligibleIds = new Set(eligible.map((lease) => lease.id));
      const expired = this.releaseOrder(snapshot, eligible).filter((lease) =>
        eligibleIds.has(lease.id),
      );
      for (const lease of expired) {
        // Recheck against failures recorded earlier in this same pass. The
        // release order visits dependents first, so a parent that just failed
        // is already known by the time its dependency comes up.
        const requiredByFailedDependent = snapshot.leases.some(
          (candidate) =>
            candidate.id !== lease.id &&
            stillHolding.has(candidate.id) &&
            candidate.dependencyLeaseIds.includes(lease.id),
        );
        if (requiredByFailedDependent) {
          stillHolding.add(lease.id);
          summary.deferred.push(structuredClone(lease));
          continue;
        }
        const hasHolder = snapshot.leases.some(
          (candidate) =>
            candidate.slotId === lease.slotId &&
            candidate.capabilityId === lease.capabilityId &&
            holdsProvider(candidate),
        );
        if (hasHolder) {
          // Another lease still owns this provider, so the warm window is moot
          // but the process legitimately stays up.
          lease.keepWarmUntil = undefined;
          summary.stillHeld.push(structuredClone(lease));
          continue;
        }
        let catalog: RuntimeCapabilityCatalogContext;
        try {
          catalog = await this.options.catalogForSlot(lease.slotId);
        } catch (error) {
          lease.keepWarmUntil = undefined;
          lease.state = 'error';
          lease.cleanupFailure = `Project capability catalog unavailable during keep-warm cleanup; cleanup refused: ${
            error instanceof Error ? error.message : String(error)
          }`;
          lease.updatedAt = this.timestamp();
          summary.failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'recovery-rejected',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        const entry = catalog.capabilities.find(
          (capability) => capability.id === lease.capabilityId,
        );
        lease.keepWarmUntil = undefined;
        if (!entry || entry.provenance.digest !== lease.provenance.digest) {
          lease.state = 'error';
          lease.cleanupFailure =
            'Expired keep-warm provider no longer matches the project catalog; cleanup refused';
          lease.updatedAt = this.timestamp();
          summary.failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'recovery-rejected',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        const cleanup = await this.runAction(
          lease.slotId,
          entry.actions.release,
          lease.parameters,
          entry,
        );
        lease.updatedAt = this.timestamp();
        if (!cleanup.ok) {
          lease.state = 'error';
          lease.cleanupFailure = cleanup.detail ?? 'expired keep-warm cleanup failed';
          summary.failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
          stillHolding.add(lease.id);
          this.recordEvent(snapshot, {
            kind: 'cleanup-failed',
            slotId: lease.slotId,
            capabilityId: lease.capabilityId,
            leaseId: lease.id,
            owner: lease.owner,
            detail: lease.cleanupFailure,
          });
          continue;
        }
        summary.released.push(structuredClone(lease));
        for (const effect of entry.releaseEffects) {
          if (!summary.effects.includes(effect)) summary.effects.push(effect);
        }
        this.recordEvent(snapshot, {
          kind: 'released',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: 'keep-warm window ended; provider released',
        });
      }
      await this.persist(snapshot);
      return summary;
    });
  }

  private releaseOrder(
    snapshot: RuntimeCapabilityStoreSnapshot,
    roots: RuntimeCapabilityLease[],
  ): RuntimeCapabilityLease[] {
    const byId = new Map(snapshot.leases.map((lease) => [lease.id, lease]));
    const reachable = new Map<string, RuntimeCapabilityLease>();
    const collect = (lease: RuntimeCapabilityLease): void => {
      if (reachable.has(lease.id)) return;
      reachable.set(lease.id, lease);
      for (const dependencyId of lease.dependencyLeaseIds) {
        const dependency = byId.get(dependencyId);
        if (dependency) collect(dependency);
      }
    };
    const sortedRoots = [...roots].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    for (const root of sortedRoots) collect(root);

    const incomingParents = new Map([...reachable.keys()].map((id) => [id, 0]));
    for (const lease of reachable.values()) {
      for (const dependencyId of lease.dependencyLeaseIds) {
        if (reachable.has(dependencyId)) {
          incomingParents.set(dependencyId, (incomingParents.get(dependencyId) ?? 0) + 1);
        }
      }
    }
    const compareLease = (left: RuntimeCapabilityLease, right: RuntimeCapabilityLease) =>
      left.capabilityId.localeCompare(right.capabilityId) || left.id.localeCompare(right.id);
    const ready = [...reachable.values()]
      .filter((lease) => incomingParents.get(lease.id) === 0)
      .sort(compareLease);
    const ordered: RuntimeCapabilityLease[] = [];
    while (ready.length > 0) {
      const lease = ready.shift()!;
      ordered.push(lease);
      for (const dependencyId of lease.dependencyLeaseIds) {
        if (!reachable.has(dependencyId)) continue;
        const remaining = (incomingParents.get(dependencyId) ?? 0) - 1;
        incomingParents.set(dependencyId, remaining);
        if (remaining === 0) {
          ready.push(reachable.get(dependencyId)!);
          ready.sort(compareLease);
        }
      }
    }
    return ordered;
  }

  async recover(slotIds?: string[]): Promise<void> {
    await this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const active = snapshot.leases.filter(
        (lease) => ACTIVE_STATES.has(lease.state) && (!slotIds || slotIds.includes(lease.slotId)),
      );
      const bySlot = new Map<string, RuntimeCapabilityLease[]>();
      for (const lease of active) {
        const leases = bySlot.get(lease.slotId) ?? [];
        leases.push(lease);
        bySlot.set(lease.slotId, leases);
      }
      for (const [slotId, leases] of bySlot) {
        let catalog: RuntimeCapabilityCatalogContext;
        try {
          catalog = await this.options.catalogForSlot(slotId);
        } catch (error) {
          const detail = `Project capability catalog unavailable after restart; cleanup refused: ${
            error instanceof Error ? error.message : String(error)
          }`;
          for (const lease of leases) {
            lease.state = 'error';
            lease.updatedAt = this.timestamp();
            lease.cleanupFailure = detail;
            this.recordEvent(snapshot, {
              kind: 'recovery-rejected',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail,
            });
          }
          continue;
        }
        const initialProviderHolderCounts = new Map<string, number>();
        for (const candidate of leases) {
          if (!holdsProvider(candidate)) continue;
          initialProviderHolderCounts.set(
            candidate.capabilityId,
            (initialProviderHolderCounts.get(candidate.capabilityId) ?? 0) + 1,
          );
        }
        for (const lease of leases) {
          const entry = catalog.capabilities.find(
            (capability) => capability.id === lease.capabilityId,
          );
          const sameCapabilityHolders = leases.filter(
            (candidate) =>
              candidate.capabilityId === lease.capabilityId && holdsProvider(candidate),
          );
          const ambiguous =
            entry?.sharePolicy === 'exclusive' &&
            (initialProviderHolderCounts.get(lease.capabilityId) ?? 0) > 1;
          if (lease.state === 'queued') {
            // The fence applies to a queue slot too. A queued lease holds no
            // provider, but `blocksAcquisition` counts it, so a fenced owner's
            // queued exclusive lease blocks every other run on that capability
            // for as long as the record survives — forever, since the owner is
            // gone and will never retry admission. Released without any
            // provider action, because there is nothing running to stop.
            if (this.isFencedOwner(lease.owner.runId, lease.owner.familyId)) {
              lease.state = 'released';
              lease.updatedAt = this.timestamp();
              lease.releasedAt = lease.updatedAt;
              lease.referenceCount = 0;
              this.recordEvent(snapshot, {
                kind: 'recovery-rejected',
                slotId,
                capabilityId: lease.capabilityId,
                leaseId: lease.id,
                owner: lease.owner,
                detail: `queue slot dropped: owner run '${lease.owner.runId}' already had its terminal capability cleanup`,
              });
              continue;
            }
            this.recordEvent(snapshot, {
              kind: 'queued',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: 'queued acquisition restored; owner may retry admission',
            });
            continue;
          }
          if (!entry || entry.provenance.digest !== lease.provenance.digest || ambiguous) {
            lease.state = 'error';
            lease.updatedAt = this.timestamp();
            lease.cleanupFailure = ambiguous
              ? 'Ambiguous exclusive ownership after restart; cleanup refused'
              : 'Stale or missing provider provenance after restart; cleanup refused';
            this.recordEvent(snapshot, {
              kind: 'recovery-rejected',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: lease.cleanupFailure,
            });
            continue;
          }
          if (lease.state === 'releasing') {
            const otherHolders = sameCapabilityHolders.filter(
              (candidate) => candidate.id !== lease.id,
            );
            const cleanup =
              otherHolders.length === 0
                ? await this.runAction(slotId, entry.actions.release, lease.parameters, entry)
                : { ok: true };
            lease.updatedAt = this.timestamp();
            lease.health = { state: 'unknown', checkedAt: lease.updatedAt };
            if (cleanup.ok) {
              lease.state = 'released';
              lease.releasedAt = lease.updatedAt;
              lease.referenceCount = 0;
              lease.cleanupFailure = undefined;
              this.recordEvent(snapshot, {
                kind: 'released',
                slotId,
                capabilityId: lease.capabilityId,
                leaseId: lease.id,
                owner: lease.owner,
                detail: 'interrupted release resumed after restart',
              });
            } else {
              lease.state = 'error';
              lease.cleanupFailure = cleanup.detail ?? 'restart release cleanup failed';
              this.recordEvent(snapshot, {
                kind: 'cleanup-failed',
                slotId,
                capabilityId: lease.capabilityId,
                leaseId: lease.id,
                owner: lease.owner,
                detail: lease.cleanupFailure,
              });
            }
            continue;
          }
          // The terminal fence, applied BEFORE the health probe can promote this
          // lease back to `acquired`. A healthy provider owned by a run that
          // already had its terminal cleanup is exactly the leak the fence
          // exists to stop: adopting it hands a live provider to a run that is
          // gone, and nothing would ever release it again. Recovery used to
          // consult only lease provenance, so a restart re-adopted it.
          if (this.isFencedOwner(lease.owner.runId, lease.owner.familyId)) {
            const liveHolders = sameCapabilityHolders.filter(
              (candidate) =>
                candidate.id !== lease.id &&
                !this.isFencedOwner(candidate.owner.runId, candidate.owner.familyId),
            );
            // A sibling that is NOT fenced still owns the running provider, so
            // stopping it here would tear it out from under a live run.
            const stopped = liveHolders.length === 0;
            const cleanup = stopped
              ? await this.runAction(slotId, entry.actions.release, lease.parameters, entry)
              : { ok: true };
            lease.updatedAt = this.timestamp();
            lease.health = { state: 'unknown', checkedAt: lease.updatedAt };
            // The detail states what actually happened to the PROVIDER, which
            // is not the same in all three cases: it was stopped, it was left
            // running for a live sibling, or the stop failed and the lease is
            // an error. Reporting "released" for all three told an operator the
            // provider was down when it may still be up.
            let outcome: string;
            if (!cleanup.ok) {
              lease.state = 'error';
              lease.cleanupFailure =
                cleanup.detail ?? 'restart cleanup failed after terminal capability cleanup';
              outcome = `provider stop FAILED (${lease.cleanupFailure})`;
            } else {
              lease.state = 'released';
              lease.releasedAt = lease.updatedAt;
              lease.referenceCount = 0;
              lease.cleanupFailure = undefined;
              outcome = stopped
                ? 'provider stopped'
                : 'provider left running for a live sibling holder';
            }
            this.recordEvent(snapshot, {
              kind: 'recovery-rejected',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: `owner run '${lease.owner.runId}' already had its terminal capability cleanup; lease not adopted, ${outcome}`,
            });
            continue;
          }
          const health = await this.runAction(
            slotId,
            entry.actions.health,
            lease.parameters,
            entry,
          );
          if (health.ok) {
            lease.state = 'acquired';
            lease.updatedAt = this.timestamp();
            lease.health = {
              state: 'healthy',
              checkedAt: lease.updatedAt,
              ...(health.detail ? { detail: health.detail } : {}),
            };
            this.recordEvent(snapshot, {
              kind: 'recovery-adopted',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: 'matching healthy provider adopted',
            });
            continue;
          }
          const cleanup = await this.runAction(
            slotId,
            entry.actions.release,
            lease.parameters,
            entry,
          );
          lease.updatedAt = this.timestamp();
          lease.health = { state: 'unhealthy', checkedAt: lease.updatedAt, detail: health.detail };
          if (cleanup.ok) {
            lease.state = 'released';
            lease.releasedAt = lease.updatedAt;
            this.recordEvent(snapshot, {
              kind: 'released',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: 'unhealthy restart lease cleaned up',
            });
          } else {
            lease.state = 'error';
            lease.cleanupFailure = cleanup.detail ?? 'restart cleanup failed';
            this.recordEvent(snapshot, {
              kind: 'cleanup-failed',
              slotId,
              capabilityId: lease.capabilityId,
              leaseId: lease.id,
              owner: lease.owner,
              detail: lease.cleanupFailure,
            });
          }
        }
      }
      for (const lease of active)
        this.updateReferenceCounts(snapshot, lease.slotId, lease.capabilityId);
      await this.persist(snapshot);
    });
  }
}
