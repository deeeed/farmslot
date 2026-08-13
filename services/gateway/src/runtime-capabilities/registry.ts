import { createHash, randomUUID } from 'node:crypto';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityAcquireParams,
  RuntimeCapabilityAcquireResult,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityLease,
  RuntimeCapabilityLifecycleEvent,
  RuntimeCapabilityListResult,
  RuntimeCapabilityProviderActionRef,
  RuntimeCapabilityReleaseParams,
  RuntimeCapabilityReleaseResult,
  RuntimeCapabilityStatusParams,
  RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import {
  RUNTIME_CAPABILITY_EVENT_LIMIT,
  RuntimeCapabilityStore,
  type RuntimeCapabilityStoreSnapshot,
} from './store.js';

export interface RuntimeCapabilityCatalogContext {
  slotId: string;
  project: string;
  capabilities: RuntimeCapabilityCatalogEntry[];
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
  ) => Promise<RuntimeCapabilityActionResult>;
  pressureFor?: (
    slotId: string,
    capability: RuntimeCapabilityCatalogEntry,
    queueOnPressure: boolean,
  ) => Promise<RuntimeCapabilityAcquireConflict | null>;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runtimeCapabilityProviderDigest(
  entry: Omit<RuntimeCapabilityCatalogEntry, 'provenance' | 'availability' | 'project' | 'id'>,
): string {
  return createHash('sha256').update(stableJson(entry)).digest('hex');
}

function sameParameters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableJson(a) === stableJson(b);
}

function blocksAcquisition(lease: RuntimeCapabilityLease): boolean {
  return (
    ACTIVE_STATES.has(lease.state) || (lease.state === 'error' && Boolean(lease.cleanupFailure))
  );
}

function holdsProvider(lease: RuntimeCapabilityLease): boolean {
  return ACTIVE_STATES.has(lease.state) && lease.state !== 'queued';
}

function parameterValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = stableJson(schema);
  const cached = parameterValidators.get(key);
  if (cached) return cached;
  const validator = parameterAjv.compile(schema);
  parameterValidators.set(key, validator);
  return validator;
}

export class RuntimeCapabilityRegistry {
  private readonly now: () => Date;
  private readonly leaseId: () => string;
  private pendingEvents: RuntimeCapabilityLifecycleEvent[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeCapabilityRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.leaseId = options.leaseId ?? (() => `cap-${randomUUID()}`);
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.options.store.load().then(() => {
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

  private async persist(snapshot: RuntimeCapabilityStoreSnapshot): Promise<void> {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    await this.options.store.replace(snapshot);
    for (const event of events) this.options.onEvent?.(event);
  }

  private async runAction(
    slotId: string,
    action: RuntimeCapabilityProviderActionRef,
  ): Promise<RuntimeCapabilityActionResult> {
    try {
      return await this.options.runAction(slotId, action);
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
    return {
      slotId: params.slotId,
      project: catalog.project,
      catalog: structuredClone(catalog.capabilities),
      leases,
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
    const sameOwner = snapshot.leases.find(
      (lease) =>
        lease.slotId === params.slotId &&
        lease.capabilityId === entry.id &&
        lease.owner.runId === params.ownerRunId &&
        ACTIVE_STATES.has(lease.state),
    );
    if (sameOwner?.state === 'acquired') {
      if (!sameParameters(sameOwner.parameters, parameters)) {
        return {
          ok: false,
          conflict: {
            kind: 'invalid-request',
            capabilityId: entry.id,
            reason: 'Existing idempotent lease has different parameters',
          },
        };
      }
      return {
        ok: true,
        lease: structuredClone(sameOwner),
        dependencyLeases: [],
        idempotent: true,
      };
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
        requirements: [...withoutDuplicate, structuredClone(params.proofRequirement)],
      };
      this.recordEvent(snapshot, {
        kind: 'planned',
        slotId: params.slotId,
        capabilityId: entry.id,
        owner: {
          runId: params.ownerRunId,
          ...(params.ownerFamilyId ? { familyId: params.ownerFamilyId } : {}),
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
        const queuedLease = this.createLease(catalog, entry, params, parameters, [], now, 'queued');
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
      !sameParameters(foreign.parameters, parameters)
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
    const requestedClaims = new Map(entry.cost.resources.map((claim) => [claim.id, claim]));
    for (const lease of snapshot.leases) {
      if (
        lease.slotId !== params.slotId ||
        lease.capabilityId === entry.id ||
        !blocksAcquisition(lease)
      ) {
        continue;
      }
      const holder = catalog.capabilities.find(
        (capability) => capability.id === lease.capabilityId,
      );
      const conflict = holder?.cost.resources.find((claim) => {
        const requested = requestedClaims.get(claim.id);
        return requested && (requested.access === 'exclusive' || claim.access === 'exclusive');
      });
      if (conflict) {
        return {
          ok: false,
          conflict: {
            kind: 'lease-conflict',
            capabilityId: entry.id,
            owner: lease.owner,
            leaseId: lease.id,
            reason: `Resource '${conflict.id}' is already claimed by capability '${lease.capabilityId}' for ${lease.owner.runId}`,
          },
        };
      }
    }

    const existingLeaseIds = new Set(snapshot.leases.map((lease) => lease.id));
    const dependencyLeases: RuntimeCapabilityLease[] = [];
    for (const dependencyId of entry.dependencies ?? []) {
      const requirement = {
        capabilityId: dependencyId,
        reason: `Required by ${entry.id}: ${params.proofRequirement.reason}`,
        mode: params.proofRequirement.mode,
      } as const;
      const dependency = await this.acquireInternal(
        snapshot,
        catalog,
        {
          ...params,
          capabilityId: dependencyId,
          proofRequirement: requirement,
          parameters: {},
          queueOnPressure: false,
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

    const warmLease = snapshot.leases.find(
      (candidate) =>
        candidate.slotId === params.slotId &&
        candidate.capabilityId === entry.id &&
        candidate.state === 'released' &&
        candidate.keepWarmUntil !== undefined &&
        Date.parse(candidate.keepWarmUntil) > this.now().getTime() &&
        candidate.provenance.digest === entry.provenance.digest,
    );
    let warmProviderHealthy = false;
    if (active.length === 0 && warmLease) {
      const warmHealth = await this.runAction(params.slotId, entry.actions.health);
      warmProviderHealthy = warmHealth.ok;
      if (warmHealth.ok) {
        warmLease.keepWarmUntil = undefined;
      } else {
        const cleanup = await this.runAction(params.slotId, entry.actions.release);
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
    const lease =
      sameOwner ??
      this.createLease(
        catalog,
        entry,
        params,
        parameters,
        dependencyLeases.map((dependency) => dependency.id),
        now,
        'acquiring',
      );
    if (!sameOwner) snapshot.leases.push(lease);
    if (sameOwner) {
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
      const acquired = await this.runAction(params.slotId, entry.actions.acquire);
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
    const health = await this.runAction(params.slotId, entry.actions.health);
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
    };
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
          : await this.runAction(lease.slotId, entry.actions.release);
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
    return this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const catalog = await this.options.catalogForSlot(params.slotId);
      const roots = snapshot.leases.filter(
        (lease) =>
          lease.slotId === params.slotId &&
          lease.owner.runId === params.ownerRunId &&
          blocksAcquisition(lease) &&
          (!params.capabilityId || lease.capabilityId === params.capabilityId) &&
          (!params.leaseId || lease.id === params.leaseId),
      );
      const order = this.releaseOrder(snapshot, roots);
      const released: RuntimeCapabilityLease[] = [];
      const retained: RuntimeCapabilityLease[] = [];
      const effects = new Set<string>();
      const failures: RuntimeCapabilityReleaseResult['failures'] = [];
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
        if (entry.provenance.digest !== lease.provenance.digest && !params.force) {
          lease.state = 'error';
          lease.cleanupFailure = 'Provider provenance changed; cleanup refused';
          lease.updatedAt = this.timestamp();
          failures.push({
            leaseId: lease.id,
            capabilityId: lease.capabilityId,
            reason: lease.cleanupFailure,
          });
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
            !selectedIds.has(candidate.id) &&
            blocksAcquisition(candidate) &&
            candidate.dependencyLeaseIds.includes(lease.id),
        );
        if (stillRequired) {
          retained.push(structuredClone(lease));
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
          !params.force
        ) {
          lease.keepWarmUntil = new Date(this.now().getTime() + entry.keepWarmMs).toISOString();
        } else if (otherHolders.length === 0 && previousState !== 'queued') {
          releaseActionRan = true;
          actionResult = await this.runAction(params.slotId, entry.actions.release);
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
      await this.persist(snapshot);
      return { ok: failures.length === 0, released, retained, effects: [...effects], failures };
    });
  }

  async cleanupExpiredWarmProviders(slotIds?: string[]): Promise<void> {
    await this.mutate(async () => {
      const snapshot = this.options.store.snapshot();
      const nowMs = this.now().getTime();
      const expired = snapshot.leases.filter(
        (lease) =>
          lease.state === 'released' &&
          lease.keepWarmUntil !== undefined &&
          Date.parse(lease.keepWarmUntil) <= nowMs &&
          (!slotIds || slotIds.includes(lease.slotId)),
      );
      for (const lease of expired) {
        const hasHolder = snapshot.leases.some(
          (candidate) =>
            candidate.slotId === lease.slotId &&
            candidate.capabilityId === lease.capabilityId &&
            holdsProvider(candidate),
        );
        if (hasHolder) {
          lease.keepWarmUntil = undefined;
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
        const cleanup = await this.runAction(lease.slotId, entry.actions.release);
        lease.updatedAt = this.timestamp();
        if (!cleanup.ok) {
          lease.state = 'error';
          lease.cleanupFailure = cleanup.detail ?? 'expired keep-warm cleanup failed';
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
        this.recordEvent(snapshot, {
          kind: 'released',
          slotId: lease.slotId,
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          owner: lease.owner,
          detail: 'keep-warm deadline elapsed; provider released',
        });
      }
      await this.persist(snapshot);
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
        for (const lease of leases) {
          const entry = catalog.capabilities.find(
            (capability) => capability.id === lease.capabilityId,
          );
          const sameCapability = leases.filter(
            (candidate) => candidate.capabilityId === lease.capabilityId,
          );
          const ambiguous = entry?.sharePolicy === 'exclusive' && sameCapability.length > 1;
          if (lease.state === 'queued') {
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
          const health = await this.runAction(slotId, entry.actions.health);
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
          const cleanup = await this.runAction(slotId, entry.actions.release);
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
