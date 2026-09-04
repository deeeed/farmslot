/**
 * Run resource posture reconciler (ADR-054).
 *
 * One Gateway-owned answer to "which runtime capabilities should be live at this
 * point in the run". Everything here is keyed to a *semantic* posture handed in
 * by the run engine — never to a run status, a step name, a runner, or a
 * project. It only ever calls the runtime capability registry and the machine
 * parking service, so it structurally cannot stop a worker (ADR-038).
 */
import { randomUUID } from 'node:crypto';

import {
  type MachinePauseExecuteParams,
  type MachinePauseExecuteResult,
  type MachinePausePreviewParams,
  type MachinePausePreviewResult,
  postureForGateChoice,
  type ProjectResourcePostureConfig,
  type ResourcePosture,
  type ResourcePostureCapabilityState,
  type ResourcePostureDesiredDisposition,
  type ResourcePostureGateChoice,
  type ResourcePostureObservedState,
  type ResourcePosturePlan,
  type ResourcePosturePolicySource,
  type ResourcePostureRejection,
  type ResourcePostureRetention,
  type ResourcePostureRetentionBoundary,
  type ResourcePostureTransition,
  type ResourcePostureTransitionFailure,
  type ResourcePostureWaitPolicy,
  type Run,
  type RunResourcePostureState,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityProofRequirement,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
  type RuntimePostureApplyResult,
  type RuntimePostureStatusResult,
} from '@farmslot/protocol';

const POLICY_SOURCE_RANK: Record<ResourcePosturePolicySource, number> = {
  'gate-choice': 3,
  'run-dispatch': 2,
  'project-default': 1,
  'framework-default': 0,
};

function strongestSource(sources: ResourcePosturePolicySource[]): ResourcePosturePolicySource {
  return sources.reduce(
    (winner, candidate) =>
      POLICY_SOURCE_RANK[candidate] > POLICY_SOURCE_RANK[winner] ? candidate : winner,
    'framework-default' as ResourcePosturePolicySource,
  );
}

export interface PostureCapabilityDecision {
  desired: ResourcePostureDesiredDisposition;
  source: ResourcePosturePolicySource;
  reason: string;
}

export interface EffectivePosturePolicy {
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  reason: string;
  gateChoice?: ResourcePostureGateChoice;
  perCapability: Map<string, PostureCapabilityDecision>;
}

export interface EffectivePosturePolicyInput {
  /** Posture of the lifecycle boundary the run engine reached. */
  posture: ResourcePosture;
  gateChoice?: ResourcePostureGateChoice;
  waitPolicy?: ResourcePostureWaitPolicy;
  projectPosture?: ProjectResourcePostureConfig;
  catalog: RuntimeCapabilityCatalogEntry[];
  proofRequirements: RuntimeCapabilityProofRequirement[];
  /** Capabilities the run holds, planned, or that the boundary needs. */
  capabilityIds: string[];
}

function retentionOverride(
  entry: RuntimeCapabilityCatalogEntry | undefined,
  projectPosture: ProjectResourcePostureConfig | undefined,
  boundary: ResourcePostureRetentionBoundary,
): { value: ResourcePostureRetention; scope: 'provider' | 'project' } | undefined {
  const provider = entry?.retention?.[boundary];
  if (provider) return { value: provider, scope: 'provider' };
  const project = projectPosture?.defaults?.[boundary];
  if (project) return { value: project, scope: 'project' };
  return undefined;
}

function retentionToDisposition(
  retention: ResourcePostureRetention,
  entry: RuntimeCapabilityCatalogEntry | undefined,
): { desired: ResourcePostureDesiredDisposition; degraded: boolean } {
  if (retention === 'retain') return { desired: 'acquired', degraded: false };
  if (retention === 'stop') return { desired: 'stopped', degraded: false };
  // `warm` needs a declared keep-warm window; without one the provider stops the
  // moment the lease is released, so report the truth instead of a warm claim.
  return entry?.keepWarmMs
    ? { desired: 'warm', degraded: false }
    : { desired: 'stopped', degraded: true };
}

function frameworkWaitDisposition(entry: RuntimeCapabilityCatalogEntry | undefined): {
  desired: ResourcePostureDesiredDisposition;
  reason: string;
} {
  // "Expensive" is the project-declared cost class, not a process name.
  if (entry?.cost.class !== 'high') {
    return { desired: 'acquired', reason: 'kept so the next operator action stays usable' };
  }
  return entry.keepWarmMs
    ? { desired: 'warm', reason: 'high-cost provider warmed for the duration of the wait' }
    : { desired: 'stopped', reason: 'high-cost provider released while the run waits' };
}

/**
 * Precedence (ADR-054): gate choice, run dispatch `waitPolicy`, project posture
 * defaults and per-provider retention, framework defaults. Gate choices govern
 * durable operator waits only — `active`, `terminal`, and an explicit `parked`
 * are facts about the boundary the engine reached, not operator preferences.
 */
export function resolveEffectivePosturePolicy(
  input: EffectivePosturePolicyInput,
): EffectivePosturePolicy {
  const explicitChoice =
    input.gateChoice && input.gateChoice !== 'project-default' ? input.gateChoice : undefined;
  const preset = explicitChoice ?? input.waitPolicy;
  const honorsChoice = input.posture === 'operator-wait' && preset !== undefined;
  const posture = honorsChoice ? postureForGateChoice(preset) : input.posture;
  const postureSource: ResourcePosturePolicySource = honorsChoice
    ? explicitChoice
      ? 'gate-choice'
      : 'run-dispatch'
    : 'framework-default';

  const byId = new Map(input.catalog.map((entry) => [entry.id, entry]));
  const required = new Set(input.proofRequirements.map((requirement) => requirement.capabilityId));
  const ids = [...new Set([...input.capabilityIds, ...(posture === 'active' ? required : [])])];
  const perCapability = new Map<string, PostureCapabilityDecision>();

  for (const capabilityId of ids.sort()) {
    const entry = byId.get(capabilityId);
    if (posture === 'active') {
      perCapability.set(
        capabilityId,
        required.has(capabilityId)
          ? {
              desired: 'acquired',
              source: 'framework-default',
              reason: 'required by the current proof plan',
            }
          : {
              desired: 'stopped',
              source: 'framework-default',
              reason: 'not required by the current proof plan',
            },
      );
      continue;
    }
    if (posture === 'parked') {
      perCapability.set(capabilityId, {
        desired: 'stopped',
        source: postureSource,
        reason: 'machine parking stops the worker and its manifest resources',
      });
      continue;
    }
    if (posture === 'terminal') {
      const override = retentionOverride(entry, input.projectPosture, 'terminal');
      if (override) {
        const { desired, degraded } = retentionToDisposition(override.value, entry);
        perCapability.set(capabilityId, {
          desired,
          source: 'project-default',
          reason: degraded
            ? `${override.scope} retention '${override.value}' at terminal has no keep_warm_ms; stopping`
            : `${override.scope} retention '${override.value}' at terminal`,
        });
        continue;
      }
      perCapability.set(capabilityId, {
        desired: 'stopped',
        source: 'framework-default',
        reason: 'terminal cleanup stops every run- and family-owned provider',
      });
      continue;
    }
    // operator-wait
    if (honorsChoice && preset === 'minimize') {
      const framework = frameworkWaitDisposition(entry);
      perCapability.set(capabilityId, {
        desired: framework.desired,
        source: postureSource,
        reason: `operator chose minimize: ${framework.reason}`,
      });
      continue;
    }
    const override = retentionOverride(entry, input.projectPosture, 'operator-wait');
    if (override) {
      const { desired, degraded } = retentionToDisposition(override.value, entry);
      perCapability.set(capabilityId, {
        desired,
        source: 'project-default',
        reason: degraded
          ? `${override.scope} retention 'warm' at operator-wait has no keep_warm_ms; stopping`
          : `${override.scope} retention '${override.value}' at operator-wait`,
      });
      continue;
    }
    const framework = frameworkWaitDisposition(entry);
    perCapability.set(capabilityId, {
      desired: framework.desired,
      source: 'framework-default',
      reason: framework.reason,
    });
  }

  const policySource = strongestSource([
    postureSource,
    ...[...perCapability.values()].map((decision) => decision.source),
  ]);
  return {
    posture,
    policySource,
    reason: honorsChoice
      ? `posture '${posture}' from ${postureSource === 'gate-choice' ? 'operator gate choice' : 'run dispatch waitPolicy'} '${preset}'`
      : `posture '${posture}' from the lifecycle boundary`,
    ...(explicitChoice ? { gateChoice: explicitChoice } : {}),
    perCapability,
  };
}

export function observedStateForLease(
  lease: RuntimeCapabilityLease | undefined,
  nowMs: number,
): ResourcePostureObservedState {
  if (!lease) return 'stopped';
  if (lease.state === 'error') return lease.cleanupFailure ? 'unhealthy' : 'unknown';
  if (lease.state === 'acquiring' || lease.state === 'releasing' || lease.state === 'queued') {
    return 'transitioning';
  }
  if (lease.state === 'acquired')
    return lease.health.state === 'unhealthy' ? 'unhealthy' : 'running';
  // A released lease is not a stopped provider while keep-warm is still live.
  if (lease.keepWarmUntil && Date.parse(lease.keepWarmUntil) > nowMs) return 'running';
  return 'stopped';
}

function dispositionSatisfied(
  desired: ResourcePostureDesiredDisposition,
  state: ResourcePostureCapabilityState,
): boolean {
  if (state.cleanupFailure) return false;
  if (desired === 'acquired') return state.observedState === 'running' && Boolean(state.leaseId);
  if (desired === 'stopped') return state.observedState === 'stopped';
  // `warm` is satisfied by a live warm provider or by one whose window elapsed;
  // neither needs another provider action.
  return state.observedState === 'running' || state.observedState === 'stopped';
}

export interface ResourcePostureRequest {
  runId: string;
  /** Omit to re-apply the run's persisted posture. */
  posture?: ResourcePosture;
  gateChoice?: ResourcePostureGateChoice;
  proofRequirements?: RuntimeCapabilityProofRequirement[];
  operationId?: string;
}

export interface RunResourcePostureDeps {
  getRun: (runId: string) => Run | undefined;
  updateRun: (runId: string, partial: Partial<Run>) => Run;
  capabilityStatus: (slotId: string) => Promise<RuntimeCapabilityStatusResult>;
  acquireCapability: (
    params: RuntimeCapabilityAcquireParams,
  ) => Promise<RuntimeCapabilityAcquireResult>;
  releaseForPosture: (
    slotId: string,
    dispositions: Array<{ leaseId: string; keepWarm: boolean }>,
  ) => Promise<RuntimeCapabilityReleaseResult>;
  machineForSlot: (slotId: string) => Promise<string | null>;
  parkPreview: (params: MachinePausePreviewParams) => Promise<MachinePausePreviewResult>;
  parkExecute: (params: MachinePauseExecuteParams) => Promise<MachinePauseExecuteResult>;
  onRunUpdated?: (run: Run) => void;
  now?: () => Date;
  newOperationId?: () => string;
}

interface ParkTarget {
  machine: string;
  previewId: string;
  generation: number;
}

interface ResolvedContext {
  run: Run;
  slotId: string;
  status: RuntimeCapabilityStatusResult;
  policy: EffectivePosturePolicy;
  states: ResourcePostureCapabilityState[];
  leases: Map<string, RuntimeCapabilityLease>;
  proofRequirements: RuntimeCapabilityProofRequirement[];
}

export class RunResourcePostureReconciler {
  private readonly now: () => Date;
  private readonly newOperationId: () => string;
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RunResourcePostureDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newOperationId = deps.newOperationId ?? (() => `posture-${randomUUID()}`);
  }

  /** Serialize per run: two boundaries can fire concurrently (cancel during a gate). */
  private async serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.tails.set(
      runId,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.tails.get(runId) === next) this.tails.delete(runId);
    }
  }

  async status(runId: string): Promise<RuntimePostureStatusResult> {
    const run = this.deps.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const persisted = run.resourcePosture;
    if (!run.slotId) {
      return {
        runId,
        slotId: null,
        state: persisted ?? this.emptyState(run),
      };
    }
    const status = await this.deps.capabilityStatus(run.slotId);
    const leases = this.leasesForRun(run, status, persisted?.posture ?? 'active');
    const nowMs = this.now().getTime();
    const byId = new Map(status.catalog.map((entry) => [entry.id, entry]));
    // Re-merge the persisted desired policy with what the providers are doing now.
    const capabilities = (persisted?.capabilities ?? []).map((state) => {
      const lease = leases.get(state.capabilityId);
      return this.capabilityState(
        state.capabilityId,
        state.desiredDisposition,
        state.policySource,
        state.reason,
        lease,
        byId.get(state.capabilityId),
        nowMs,
      );
    });
    const known = new Set(capabilities.map((state) => state.capabilityId));
    for (const [capabilityId, lease] of leases) {
      if (known.has(capabilityId)) continue;
      capabilities.push(
        this.capabilityState(
          capabilityId,
          'acquired',
          'framework-default',
          'held by this run without a recorded posture decision',
          lease,
          byId.get(capabilityId),
          nowMs,
        ),
      );
    }
    capabilities.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    return {
      runId,
      slotId: run.slotId,
      state: {
        ...(persisted ?? this.emptyState(run)),
        capabilities,
      },
    };
  }

  async preview(request: ResourcePostureRequest): Promise<ResourcePosturePlan> {
    const resolved = await this.resolve(request);
    if ('rejection' in resolved) return resolved.plan;
    return this.planFrom(resolved.context);
  }

  async apply(request: ResourcePostureRequest): Promise<RuntimePostureApplyResult> {
    return this.serialize(request.runId, () => this.applyInternal(request));
  }

  private async applyInternal(request: ResourcePostureRequest): Promise<RuntimePostureApplyResult> {
    const run = this.deps.getRun(request.runId);
    if (run && request.operationId) {
      const previous = run.resourcePosture?.lastTransition;
      if (previous?.id === request.operationId && previous.outcome !== 'in-progress') {
        return {
          ok: previous.outcome !== 'rejected',
          status: run.resourcePosture!,
          transition: previous,
        };
      }
    }
    const resolved = await this.resolve(request);
    if ('rejection' in resolved) {
      return this.rejectionResult(request, resolved.plan, resolved.rejection);
    }
    const context = resolved.context;
    const requestedAt = this.now().toISOString();
    const operationId = request.operationId ?? this.newOperationId();

    if (this.isIdempotent(context)) {
      const transition: ResourcePostureTransition = {
        id: operationId,
        posture: context.policy.posture,
        policySource: context.policy.policySource,
        ...(context.policy.gateChoice ? { gateChoice: context.policy.gateChoice } : {}),
        requestedAt,
        completedAt: this.now().toISOString(),
        outcome: 'idempotent',
        effects: [],
        progress: { total: context.states.length, completed: context.states.length },
        failures: [],
      };
      const state = this.persist(context, transition);
      return { ok: true, status: state, transition };
    }

    // Eligibility before write-ahead: an ineligible park must change no lease,
    // no process, and no persisted posture.
    let park: ParkTarget | null = null;
    if (context.policy.posture === 'parked') {
      const eligibility = await this.parkTarget(context);
      if ('rejection' in eligibility) {
        return this.rejectionResult(
          { runId: context.run.id, operationId },
          this.planFrom(context),
          eligibility.rejection,
        );
      }
      park = eligibility;
    }

    // Write-ahead: a crash between here and the provider actions must leave the
    // intent visible rather than a silently half-applied posture.
    const inProgress: ResourcePostureTransition = {
      id: operationId,
      posture: context.policy.posture,
      policySource: context.policy.policySource,
      ...(context.policy.gateChoice ? { gateChoice: context.policy.gateChoice } : {}),
      requestedAt,
      outcome: 'in-progress',
      effects: [],
      progress: { total: context.states.length, completed: 0 },
      failures: [],
    };
    this.persist(context, inProgress);

    if (park) return this.applyParked(context, inProgress, park);

    const failures: ResourcePostureTransitionFailure[] = [];
    const effects = new Set<string>();
    let completed = 0;

    for (const state of context.states) {
      if (state.desiredDisposition !== 'acquired') continue;
      const requirement = context.proofRequirements.find(
        (candidate) => candidate.capabilityId === state.capabilityId,
      );
      if (!requirement) {
        // Already held and not part of a proof plan: nothing to acquire.
        completed += 1;
        continue;
      }
      const result = await this.deps.acquireCapability({
        slotId: context.slotId,
        capabilityId: state.capabilityId,
        ownerRunId: context.run.id,
        ...(context.run.familyId ? { ownerFamilyId: context.run.familyId } : {}),
        proofRequirement: requirement,
        ...(requirement.parameters ? { parameters: requirement.parameters } : {}),
      });
      if (!result.ok) {
        // Blocking, not partial: the caller's action cannot run, and no other
        // owner's resource was touched.
        const rejection: ResourcePostureRejection = {
          kind: 'capability-unavailable',
          capabilityId: state.capabilityId,
          reason: result.conflict.reason,
          conflict: result.conflict,
        };
        const transition: ResourcePostureTransition = {
          ...inProgress,
          completedAt: this.now().toISOString(),
          outcome: 'rejected',
          effects: [...effects],
          progress: { total: context.states.length, completed },
          failures,
          rejection,
        };
        const refreshed = await this.refresh(context);
        const persisted = this.persist(refreshed, transition);
        return { ok: false, status: persisted, transition };
      }
      completed += 1;
    }

    const dispositions = context.states
      .filter((state) => state.desiredDisposition !== 'acquired' && state.leaseId)
      .map((state) => ({
        leaseId: state.leaseId!,
        keepWarm: state.desiredDisposition === 'warm',
      }));
    if (dispositions.length > 0) {
      const released = await this.deps.releaseForPosture(context.slotId, dispositions);
      for (const effect of released.effects) effects.add(effect);
      for (const failure of released.failures) {
        failures.push({
          capabilityId: failure.capabilityId,
          leaseId: failure.leaseId,
          reason: failure.reason,
        });
      }
      completed += dispositions.length - released.failures.length;
    }

    const refreshed = await this.refresh(context);
    const transition: ResourcePostureTransition = {
      ...inProgress,
      completedAt: this.now().toISOString(),
      // A cleanup failure never reports success, and the capability keeps its
      // unhealthy/unknown observed state with the provider's reason.
      outcome: failures.length > 0 ? 'partial' : 'applied',
      effects: [...effects],
      progress: { total: context.states.length, completed },
      failures,
    };
    const persisted = this.persist(refreshed, transition);
    return { ok: failures.length === 0, status: persisted, transition };
  }

  /**
   * Ask machine parking whether this one run may be released. Its verdict is the
   * only eligibility policy; nothing here reimplements it.
   */
  private async parkTarget(
    context: ResolvedContext,
  ): Promise<ParkTarget | { rejection: ResourcePostureRejection }> {
    const machine = await this.deps.machineForSlot(context.slotId);
    if (!machine) {
      return {
        rejection: {
          kind: 'invalid-request',
          reason: `slot '${context.slotId}' is not owned by a known machine`,
        },
      };
    }
    const preview = await this.deps.parkPreview({
      machine,
      mode: 'release',
      selector: { kind: 'include', runIds: [context.run.id] },
    });
    const entry = preview.runs.find((candidate) => candidate.runId === context.run.id);
    if (!entry || !entry.eligibility.eligible) {
      return {
        rejection: {
          kind: 'park-ineligible',
          code: entry?.eligibility.code ?? 'RUN_NOT_IN_PREVIEW',
          reason:
            entry?.eligibility.reason ??
            `run ${context.run.id} was not returned by the machine pause preview`,
        },
      };
    }
    return { machine, previewId: preview.previewId, generation: entry.generation };
  }

  private async applyParked(
    context: ResolvedContext,
    inProgress: ResourcePostureTransition,
    park: ParkTarget,
  ): Promise<RuntimePostureApplyResult> {
    const machine = park.machine;
    let execution: MachinePauseExecuteResult;
    try {
      execution = await this.deps.parkExecute({
        machine,
        mode: 'release',
        previewId: park.previewId,
        reviewedTargets: [{ runId: context.run.id, generation: park.generation }],
        operationId: inProgress.id,
      });
    } catch (error) {
      // Machine parking throws on a stale preview or a rejected batch. That is a
      // real verdict about this run, so surface it as the typed rejection the
      // clients already render — not an unhandled error.
      return this.rejectionResult(
        { runId: context.run.id, operationId: inProgress.id },
        this.planFrom(context),
        {
          kind: 'park-ineligible',
          code: 'PARK_EXECUTE_REFUSED',
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const refreshed = await this.refresh(context);
    const transition: ResourcePostureTransition = {
      ...inProgress,
      completedAt: this.now().toISOString(),
      outcome: execution.outcome === 'complete' ? 'applied' : 'partial',
      effects: [`machine parking ${execution.outcome} on ${machine}`],
      progress: {
        total: context.states.length,
        completed: execution.outcome === 'complete' ? context.states.length : 0,
      },
      failures:
        execution.outcome === 'complete'
          ? []
          : [
              {
                capabilityId: 'machine-parking',
                reason: `machine pause outcome '${execution.outcome}'`,
              },
            ],
    };
    const persisted = this.persist(refreshed, transition);
    return { ok: execution.ok, status: persisted, transition };
  }

  private rejectionResult(
    request: Pick<ResourcePostureRequest, 'runId' | 'operationId'>,
    plan: ResourcePosturePlan,
    rejection: ResourcePostureRejection,
  ): RuntimePostureApplyResult {
    const at = this.now().toISOString();
    const transition: ResourcePostureTransition = {
      id: request.operationId ?? this.newOperationId(),
      posture: plan.posture,
      policySource: plan.policySource,
      requestedAt: at,
      completedAt: at,
      outcome: 'rejected',
      effects: [],
      progress: { total: 0, completed: 0 },
      failures: [],
      rejection,
    };
    const run = this.deps.getRun(request.runId);
    const previous = run?.resourcePosture;
    if (!previous) {
      // Nothing was applied and there is no earlier posture to annotate, so
      // inventing one would report a policy the Gateway never resolved. The
      // caller still receives the typed rejection.
      return {
        ok: false,
        status: {
          posture: plan.posture,
          policySource: plan.policySource,
          capabilities: [],
          workerRetained: true,
          lastTransition: transition,
          updatedAt: at,
        },
        transition,
      };
    }
    const state: RunResourcePostureState = {
      ...previous,
      lastTransition: transition,
      updatedAt: at,
    };
    const updated = this.deps.updateRun(run!.id, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return { ok: false, status: state, transition };
  }

  private emptyState(run: Run): RunResourcePostureState {
    return {
      posture: 'active',
      policySource: 'framework-default',
      ...(run.waitPolicy ? { waitPolicy: run.waitPolicy } : {}),
      capabilities: [],
      workerRetained: true,
      updatedAt: run.updatedAt,
    };
  }

  private persist(
    context: ResolvedContext,
    transition: ResourcePostureTransition,
  ): RunResourcePostureState {
    const state: RunResourcePostureState = {
      posture: context.policy.posture,
      policySource: context.policy.policySource,
      ...(context.policy.gateChoice ? { gateChoice: context.policy.gateChoice } : {}),
      ...(context.run.waitPolicy ? { waitPolicy: context.run.waitPolicy } : {}),
      capabilities: context.states,
      // Nothing in this module can stop a worker; `parked` delegates that to
      // machine parking, which refuses gate-held runs.
      workerRetained: context.policy.posture !== 'parked',
      lastTransition: transition,
      updatedAt: this.now().toISOString(),
    };
    const updated = this.deps.updateRun(context.run.id, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return state;
  }

  private isIdempotent(context: ResolvedContext): boolean {
    const persisted = context.run.resourcePosture;
    if (persisted?.posture !== context.policy.posture) return false;
    return context.states.every((state) => dispositionSatisfied(state.desiredDisposition, state));
  }

  private leasesForRun(
    run: Run,
    status: RuntimeCapabilityStatusResult,
    posture: ResourcePosture,
  ): Map<string, RuntimeCapabilityLease> {
    const includeFamily = posture === 'terminal' && Boolean(run.familyId);
    const owned = status.leases.filter(
      (lease) =>
        lease.owner.runId === run.id || (includeFamily && lease.owner.familyId === run.familyId),
    );
    const byCapability = new Map<string, RuntimeCapabilityLease>();
    for (const lease of owned) {
      const existing = byCapability.get(lease.capabilityId);
      // Prefer the lease that still holds a provider over a historical one.
      if (!existing || Date.parse(lease.updatedAt) >= Date.parse(existing.updatedAt)) {
        byCapability.set(lease.capabilityId, lease);
      }
    }
    return byCapability;
  }

  private capabilityState(
    capabilityId: string,
    desired: ResourcePostureDesiredDisposition,
    source: ResourcePosturePolicySource,
    reason: string,
    lease: RuntimeCapabilityLease | undefined,
    entry: RuntimeCapabilityCatalogEntry | undefined,
    nowMs: number,
  ): ResourcePostureCapabilityState {
    const observedState = observedStateForLease(lease, nowMs);
    return {
      capabilityId,
      desiredDisposition: desired,
      observedState,
      policySource: source,
      reason,
      ...(lease?.id ? { leaseId: lease.id } : {}),
      ...(lease?.owner ? { owner: lease.owner } : {}),
      ...(lease?.keepWarmUntil && Date.parse(lease.keepWarmUntil) > nowMs
        ? { warmUntil: lease.keepWarmUntil }
        : {}),
      ...(lease?.updatedAt ? { lastTransitionAt: lease.updatedAt } : {}),
      releaseEffects: entry ? [...entry.releaseEffects] : [],
      ...(lease?.cleanupFailure ? { cleanupFailure: lease.cleanupFailure } : {}),
    };
  }

  private async resolve(
    request: ResourcePostureRequest,
  ): Promise<
    | { context: ResolvedContext }
    | { rejection: ResourcePostureRejection; plan: ResourcePosturePlan }
  > {
    const run = this.deps.getRun(request.runId);
    if (!run) {
      const rejection: ResourcePostureRejection = {
        kind: 'invalid-request',
        reason: `Run not found: ${request.runId}`,
      };
      return { rejection, plan: this.emptyPlan(request.runId, null, request.posture, rejection) };
    }
    if (!run.slotId) {
      const rejection: ResourcePostureRejection = {
        kind: 'invalid-request',
        reason: `run ${run.id} has no assigned slot`,
      };
      return { rejection, plan: this.emptyPlan(run.id, null, request.posture, rejection) };
    }
    const posture = request.posture ?? run.resourcePosture?.posture ?? 'active';
    const status = await this.deps.capabilityStatus(run.slotId);
    const leases = this.leasesForRun(run, status, posture);
    const proofRequirements =
      request.proofRequirements ?? status.proofPlans[run.id]?.requirements ?? [];
    const policy = resolveEffectivePosturePolicy({
      posture,
      ...(request.gateChoice ? { gateChoice: request.gateChoice } : {}),
      ...(run.waitPolicy ? { waitPolicy: run.waitPolicy } : {}),
      ...(status.posture ? { projectPosture: status.posture } : {}),
      catalog: status.catalog,
      proofRequirements,
      capabilityIds: [...leases.keys()],
    });
    const nowMs = this.now().getTime();
    const byId = new Map(status.catalog.map((entry) => [entry.id, entry]));
    const states = [...policy.perCapability.entries()].map(([capabilityId, decision]) =>
      this.capabilityState(
        capabilityId,
        decision.desired,
        decision.source,
        decision.reason,
        leases.get(capabilityId),
        byId.get(capabilityId),
        nowMs,
      ),
    );
    return {
      context: { run, slotId: run.slotId, status, policy, states, leases, proofRequirements },
    };
  }

  /** Re-read provider state so a reported disposition never outruns reality. */
  private async refresh(context: ResolvedContext): Promise<ResolvedContext> {
    const run = this.deps.getRun(context.run.id) ?? context.run;
    const status = await this.deps.capabilityStatus(context.slotId);
    const leases = this.leasesForRun(run, status, context.policy.posture);
    const nowMs = this.now().getTime();
    const byId = new Map(status.catalog.map((entry) => [entry.id, entry]));
    const states = context.states.map((state) =>
      this.capabilityState(
        state.capabilityId,
        state.desiredDisposition,
        state.policySource,
        state.reason,
        leases.get(state.capabilityId),
        byId.get(state.capabilityId),
        nowMs,
      ),
    );
    return { ...context, run, status, leases, states };
  }

  private planFrom(context: ResolvedContext): ResourcePosturePlan {
    const effects = new Set<string>();
    for (const state of context.states) {
      if (state.desiredDisposition === 'stopped') {
        for (const effect of state.releaseEffects) effects.add(effect);
      }
    }
    const held = (state: ResourcePostureCapabilityState) => Boolean(state.leaseId);
    return {
      runId: context.run.id,
      slotId: context.slotId,
      posture: context.policy.posture,
      policySource: context.policy.policySource,
      reason: context.policy.reason,
      acquire: context.states.filter(
        (state) =>
          state.desiredDisposition === 'acquired' && !dispositionSatisfied('acquired', state),
      ),
      retain: context.states.filter(
        (state) =>
          state.desiredDisposition === 'acquired' && dispositionSatisfied('acquired', state),
      ),
      warm: context.states.filter((state) => state.desiredDisposition === 'warm'),
      stop: context.states.filter((state) => state.desiredDisposition === 'stopped' && held(state)),
      effects: [...effects],
    };
  }

  private emptyPlan(
    runId: string,
    slotId: string | null,
    posture: ResourcePosture | undefined,
    rejection: ResourcePostureRejection,
  ): ResourcePosturePlan {
    return {
      runId,
      slotId,
      posture: posture ?? 'active',
      policySource: 'framework-default',
      reason: rejection.reason,
      acquire: [],
      retain: [],
      warm: [],
      stop: [],
      effects: [],
      rejection,
    };
  }
}
