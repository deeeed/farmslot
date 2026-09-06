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
  observedStateForLease,
  postureForGateChoice,
  type ProjectResourcePostureConfig,
  RESOURCE_POSTURE_TRANSITION_HISTORY,
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

import { hasLiveParkRecord } from '../run-engine/park-slot-binding.js';

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
      // Terminal is not negotiable: ADR-054 stops every run- and family-owned
      // provider in dependency order, bypassing keep-warm. Config validation
      // rejects `retain` and `warm` here, so there is nothing left to honour.
      const override = retentionOverride(entry, input.projectPosture, 'terminal');
      perCapability.set(capabilityId, {
        desired: 'stopped',
        source: override ? 'project-default' : 'framework-default',
        reason: override
          ? `${override.scope} retention 'stop' at terminal`
          : 'terminal cleanup stops every run- and family-owned provider',
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

  // A dependency cannot be shed out from under something this posture keeps.
  // Propagate to a fixpoint so a chain (app -> simulator -> metro) inherits the
  // whole way down, and record where the disposition came from.
  const RETENTION_RANK: Record<ResourcePostureDesiredDisposition, number> = {
    stopped: 0,
    warm: 1,
    acquired: 2,
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [capabilityId, decision] of perCapability) {
      for (const dependencyId of byId.get(capabilityId)?.dependencies ?? []) {
        const dependency = perCapability.get(dependencyId);
        // A dependency this run does not own is the registry's to protect.
        if (!dependency) continue;
        if (RETENTION_RANK[dependency.desired] >= RETENTION_RANK[decision.desired]) continue;
        // `warm` means "released, but the provider stays up until a deadline".
        // A provider with no keep-warm window has no such state: releasing it
        // stops it outright. Inheriting `warm` there would shed the floor from
        // under a dependent that is still warm, so it is retained instead.
        const inherited: ResourcePostureDesiredDisposition =
          decision.desired === 'warm' && !byId.get(dependencyId)?.keepWarmMs
            ? 'acquired'
            : decision.desired;
        perCapability.set(dependencyId, {
          desired: inherited,
          source: decision.source,
          reason:
            inherited === decision.desired
              ? `kept ${inherited} because '${capabilityId}' depends on it and this posture keeps that ${inherited}`
              : `kept acquired because '${capabilityId}' depends on it and stays warm, and this provider declares no keep_warm_ms`,
        });
        changed = true;
      }
    }
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

/** Transitions a run has retained, newest first, including the latest. */
function historyOf(state: RunResourcePostureState | undefined): ResourcePostureTransition[] {
  if (!state) return [];
  const history = state.recentTransitions ?? [];
  if (state.lastTransition && !history.some((entry) => entry.id === state.lastTransition!.id)) {
    return [state.lastTransition, ...history];
  }
  return history;
}

/** Newest first, de-duplicated by operation id, bounded. */
function withTransition(
  state: RunResourcePostureState | undefined,
  transition: ResourcePostureTransition,
): ResourcePostureTransition[] {
  const previous = historyOf(state).filter((entry) => entry.id !== transition.id);
  return [transition, ...previous].slice(0, RESOURCE_POSTURE_TRANSITION_HISTORY);
}

function dispositionSatisfied(
  desired: ResourcePostureDesiredDisposition,
  state: ResourcePostureCapabilityState,
): boolean {
  if (state.cleanupFailure) return false;
  if (desired === 'acquired') return state.observedState === 'running' && Boolean(state.leaseId);
  if (desired === 'stopped') return state.observedState === 'stopped';
  // `warm` wants a provider that is still up. A stopped one is a failure of the
  // desire, not a cheaper way to satisfy it; `unknown` is an elapsed window
  // whose real outcome cleanup has yet to determine.
  return state.observedState === 'running' || state.observedState === 'unknown';
}

export interface ResourcePostureRequest {
  runId: string;
  /** Omit to re-apply the run's persisted posture. */
  posture?: ResourcePosture;
  gateChoice?: ResourcePostureGateChoice;
  proofRequirements?: RuntimeCapabilityProofRequirement[];
  operationId?: string;
  /**
   * Resolves the gate choice this request inherits, called INSIDE the per-run
   * serialization. Reading and clearing a one-shot suppression is a
   * read-modify-write on the run's posture, and this queue is the only thing
   * that serializes those writes.
   */
  resolveInheritedGateChoice?: (runId: string) => ResourcePostureGateChoice | undefined;
  /**
   * Admission check re-run INSIDE the per-run serialization, immediately before
   * the request executes. A caller that validated at the RPC boundary only
   * proved the run was admissible when the request arrived; a request queued
   * behind another one executes later, by which time a park may have landed.
   * Throw from here to refuse. Engine-internal boundaries omit it.
   */
  assertAdmissible?: () => void;
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
  /** Owner-scoped terminal cleanup, resolved inside the registry's own lock. */
  releaseRunTerminal: (
    slotId: string,
    ownerRunId: string,
    familyId?: string,
  ) => Promise<RuntimeCapabilityReleaseResult>;
  /** Stop providers a released lease is still keeping warm (ADR-054 terminal). */
  stopWarmProviders: (slotId: string, capabilityIds: string[]) => Promise<PostureWarmSweepResult>;
  machineForSlot: (slotId: string) => Promise<string | null>;
  parkPreview: (params: MachinePausePreviewParams) => Promise<MachinePausePreviewResult>;
  parkExecute: (params: MachinePauseExecuteParams) => Promise<MachinePauseExecuteResult>;
  onRunUpdated?: (run: Run) => void;
  now?: () => Date;
  newOperationId?: () => string;
}

/** What a keep-warm sweep did, in the shape the reconciler needs to report it. */
export interface PostureWarmSweepResult {
  released: Array<{ capabilityId: string }>;
  deferred: Array<{ capabilityId: string }>;
  failures: Array<{ capabilityId: string; leaseId?: string; reason: string }>;
  effects: string[];
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
  leases: Map<string, RuntimeCapabilityLease[]>;
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
    // The map holds a settled-either-way tail so the next caller chains onto it
    // rather than inheriting a rejection. Track that exact promise so the
    // cleanup below can recognise and drop it instead of leaking one entry per
    // run id for the process lifetime.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(runId, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(runId) === tail) this.tails.delete(runId);
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
    for (const [capabilityId, group] of leases) {
      if (known.has(capabilityId)) continue;
      capabilities.push(
        this.capabilityState(
          capabilityId,
          'acquired',
          'framework-default',
          'held by this run without a recorded posture decision',
          group,
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
    const context = resolved.context;
    const plan = this.planFrom(context);
    if (context.policy.posture !== 'parked') return plan;
    // Mirror apply's ordering exactly. Apply checks idempotency before it asks
    // machine parking anything, so an already-parked run returns `idempotent`
    // and never sees ALREADY_PARKED. A preview that asked first would report a
    // rejection for the one case apply treats as a success.
    if (this.isIdempotent(context)) {
      return {
        ...plan,
        reason: 'run is already parked; applying this again would do nothing',
        acquire: [],
        retain: [],
        warm: [],
        stop: [],
        effects: [],
      };
    }
    // Preview has to ask machine parking the same question apply does. Without
    // it, `free-slot` on a run parking will refuse previews as a normal plan —
    // the operator reads "Parked, 1 stopped" for a choice that cannot succeed.
    // Read-only: this resolves eligibility and touches no lease, process, or run.
    const eligibility = await this.parkTarget(context);
    if (!('rejection' in eligibility)) return plan;
    return {
      ...plan,
      acquire: [],
      retain: [],
      warm: [],
      stop: [],
      effects: [],
      rejection: eligibility.rejection,
    };
  }

  async apply(request: ResourcePostureRequest): Promise<RuntimePostureApplyResult> {
    return this.serialize(request.runId, () => {
      // Inside the queue, not before it. This is the only point where the check
      // and the effect are not separated by another request's execution.
      request.assertAdmissible?.();
      // Always called so the one-shot suppression is consumed even when an
      // explicit choice is present; that explicit choice then wins over what it
      // returns.
      const inherited = request.resolveInheritedGateChoice?.(request.runId);
      return this.applyInternal(
        request.gateChoice === undefined && inherited
          ? { ...request, gateChoice: inherited }
          : request,
      );
    });
  }

  private async applyInternal(request: ResourcePostureRequest): Promise<RuntimePostureApplyResult> {
    const run = this.deps.getRun(request.runId);
    if (run && request.operationId) {
      // Search the whole retained history, not just the last transition: after a
      // later operation lands, retrying an earlier id must still return that
      // earlier result rather than executing again and undoing the later one.
      const previous = historyOf(run.resourcePosture).find(
        (transition) =>
          transition.id === request.operationId && transition.outcome !== 'in-progress',
      );
      if (previous) {
        return {
          ok: previous.outcome === 'applied' || previous.outcome === 'idempotent',
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

    // The posture in force before the write-ahead. A park that machine parking
    // then refuses changed nothing, so status must roll back to this rather than
    // keep advertising `parked` with the worker reported as stopped.
    const priorState = context.run.resourcePosture;

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
    this.persist(context, inProgress, park ? (priorState?.posture ?? 'active') : undefined);

    if (park) return this.applyParked(context, inProgress, park, priorState);

    const failures: ResourcePostureTransitionFailure[] = [];
    const effects = new Set<string>();
    let completed = 0;

    // Release first, then acquire. Two capabilities can claim the same exclusive
    // resource, so acquiring the new one while this run still holds the old lease
    // would conflict the run against itself.
    // Every sibling lease, not just the representative one: a family terminal
    // that released only one holder would leave the provider running.
    const dispositions = context.states
      .filter((state) => state.desiredDisposition !== 'acquired')
      .flatMap((state) =>
        (context.leases.get(state.capabilityId) ?? []).map((lease) => ({
          leaseId: lease.id,
          keepWarm: state.desiredDisposition === 'warm',
        })),
      );
    // A provider kept alive by an already-released lease is invisible to the
    // release path, so a posture that wants it stopped has to end the warm
    // window explicitly. Terminal bypasses keep-warm by definition.
    const warmToStop = context.states
      .filter(
        (state) =>
          state.desiredDisposition === 'stopped' &&
          (context.leases.get(state.capabilityId) ?? []).some(
            (lease) => lease.state === 'released' && lease.keepWarmUntil !== undefined,
          ),
      )
      .map((state) => state.capabilityId);
    // A warm cleanup that failed or was deferred is not a success. Folding its
    // outcome into this transition is what stops the reconciler reporting
    // `applied` while a provider it asked to stop is still running.
    const warmDeferred = new Set<string>();
    if (warmToStop.length > 0) {
      const swept = await this.deps.stopWarmProviders(context.slotId, warmToStop);
      for (const effect of swept.effects) effects.add(effect);
      for (const failure of swept.failures) {
        failures.push({
          capabilityId: failure.capabilityId,
          ...(failure.leaseId ? { leaseId: failure.leaseId } : {}),
          reason: failure.reason,
        });
      }
      for (const lease of swept.deferred) warmDeferred.add(lease.capabilityId);
    }
    // At terminal the selection must be by owner and resolved inside the
    // registry's lock, not from the lease ids read a moment ago: an acquire
    // still in flight would otherwise finish afterwards and leave the run
    // holding providers nothing will ever release.
    const released =
      context.policy.posture === 'terminal'
        ? await this.deps.releaseRunTerminal(context.slotId, context.run.id, context.run.familyId)
        : dispositions.length > 0
          ? await this.deps.releaseForPosture(context.slotId, dispositions)
          : null;
    if (released) {
      for (const effect of released.effects) effects.add(effect);
      for (const failure of released.failures) {
        failures.push({
          capabilityId: failure.capabilityId,
          leaseId: failure.leaseId,
          reason: failure.reason,
        });
      }
      // The registry refuses to release a lease something else still depends on.
      // That is correct, but it means the plan did not happen: reporting
      // `applied` here would pair a desired `stopped` with a running provider.
      const wantedStopped = new Set(
        context.states
          .filter((state) => state.desiredDisposition !== 'acquired')
          .map((state) => state.capabilityId),
      );
      const blocked = released.retained.filter((lease) => wantedStopped.has(lease.capabilityId));
      for (const lease of blocked) {
        const dependents = context.status.leases
          .filter((candidate) => candidate.dependencyLeaseIds.includes(lease.id))
          .map((candidate) => `${candidate.capabilityId} (${candidate.owner.runId})`);
        failures.push({
          capabilityId: lease.capabilityId,
          leaseId: lease.id,
          reason: dependents.length
            ? `retained: still required by ${dependents.join(', ')}`
            : 'retained: still required by another active lease',
        });
      }
      completed +=
        Math.max(dispositions.length, released.released.length) -
        released.failures.length -
        blocked.length;
    }

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
        // ADR-054: preparation must prove a retained provider is still alive.
        revalidateHealth: true,
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

    const refreshed = await this.refresh(context);
    if (warmDeferred.size > 0) {
      // The sweep declined to stop these because something still needs them, so
      // they are demonstrably up whatever the lease rows say.
      refreshed.states = refreshed.states.map((state) =>
        warmDeferred.has(state.capabilityId)
          ? {
              ...state,
              observedState: 'running' as const,
              reason: `${state.reason}; kept running because an active or warm dependent still needs it`,
            }
          : state,
      );
    }
    // A deferral is not a failure of the provider, but it is a failure of the
    // plan: desired `stopped` while the thing is demonstrably running is never
    // `applied`. It is reported as `partial` with the reason, like any other
    // stop that did not happen.
    for (const capabilityId of warmDeferred) {
      if (failures.some((failure) => failure.capabilityId === capabilityId)) continue;
      failures.push({
        capabilityId,
        reason: `kept running because an active or warm dependent still needs it`,
      });
    }
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
    priorState: RunResourcePostureState | undefined,
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
        priorState,
      );
    }
    if (execution.outcome === 'failed') {
      // Parking ran and refused: nothing was stopped, so this is the same
      // situation as a thrown refusal and must not leave the run advertising
      // itself as parked with its worker reported stopped.
      return this.rejectionResult(
        { runId: context.run.id, operationId: inProgress.id },
        this.planFrom(context),
        {
          kind: 'park-ineligible',
          code: 'PARK_EXECUTE_FAILED',
          reason: `machine pause reported outcome 'failed' on ${machine}`,
        },
        priorState,
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
    /** Posture to restore when a write-ahead already advertised the attempt. */
    rollbackTo?: RunResourcePostureState,
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
    if (!run) {
      return {
        ok: false,
        status: {
          posture: plan.posture,
          policySource: plan.policySource,
          capabilities: [],
          workerRetained: true,
          lastTransition: transition,
          recentTransitions: withTransition(undefined, transition),
          updatedAt: at,
        },
        transition,
      };
    }
    // A rejection changes no posture, but it must still be persisted: replay
    // looks up an operation id in the retained history, and an unrecorded
    // rejection would let a retry of that id execute for real later.
    const previous = rollbackTo ?? run.resourcePosture;
    const state: RunResourcePostureState = {
      ...(previous ?? this.emptyState(run)),
      lastTransition: transition,
      recentTransitions: withTransition(previous, transition),
      updatedAt: at,
    };
    const updated = this.deps.updateRun(run.id, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return { ok: false, status: state, transition };
  }

  /**
   * Record that reconciliation could not run at all. Boundary callers must not
   * lose an unreachable catalog or provider to a log line: the failure lands on
   * the run's posture as a `failed` transition that status and reconnecting
   * clients render.
   */
  async recordFailure(
    runId: string,
    posture: ResourcePosture,
    reason: string,
    operationId?: string,
  ): Promise<RunResourcePostureState | null> {
    const run = this.deps.getRun(runId);
    if (!run) return null;
    const at = this.now().toISOString();
    const previous = run.resourcePosture;
    const transition: ResourcePostureTransition = {
      id: operationId ?? this.newOperationId(),
      posture,
      policySource: previous?.policySource ?? 'framework-default',
      ...(previous?.gateChoice ? { gateChoice: previous.gateChoice } : {}),
      requestedAt: at,
      completedAt: at,
      outcome: 'failed',
      effects: [],
      progress: { total: 0, completed: 0 },
      failures: [{ capabilityId: 'reconciler', reason }],
    };
    // The requested posture was never applied, so the run keeps whatever posture
    // it actually had; only the failed attempt is new information.
    const state: RunResourcePostureState = {
      ...(previous ?? this.emptyState(run)),
      lastTransition: transition,
      recentTransitions: withTransition(previous, transition),
      updatedAt: at,
    };
    const updated = this.deps.updateRun(runId, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return state;
  }

  /**
   * Record that the park this run's `parked` posture described is over.
   *
   * Not a reconcile, deliberately: nothing is acquired, released, or warmed.
   * `machine.pause.restore` has already put the run back where the park found
   * it — at its operator wait with its worker live and the manifest's
   * capabilities reacquired — and all that is left is for the persisted posture
   * to stop saying `parked` with the worker stopped. Without this, every client
   * reads a restored run as parked with a dead worker.
   *
   * Not a wait-boundary reconcile either, for a reason that matters: a wait
   * boundary resolves the run's INHERITED gate choice, and the choice this run
   * carries is the `free-slot` that parked it. Reconciling here would park it
   * again the instant it came back.
   */
  async recordParkRestored(runId: string): Promise<RunResourcePostureState | null> {
    const run = this.deps.getRun(runId);
    if (!run) return null;
    const previous = run.resourcePosture;
    if (previous?.posture !== 'parked') return previous ?? null;
    const at = this.now().toISOString();
    const transition: ResourcePostureTransition = {
      id: this.newOperationId(),
      posture: 'operator-wait',
      policySource: 'framework-default',
      requestedAt: at,
      completedAt: at,
      outcome: 'applied',
      effects: ['machine park restored; the run is back at its operator wait'],
      progress: { total: 0, completed: 0 },
      failures: [],
    };
    const state: RunResourcePostureState = {
      ...previous,
      posture: 'operator-wait',
      policySource: 'framework-default',
      // The park stopped the worker; the restore reloaded it. Leaving this false
      // is the same lie as leaving the posture `parked`.
      workerRetained: true,
      lastTransition: transition,
      recentTransitions: withTransition(previous, transition),
      updatedAt: at,
    };
    const updated = this.deps.updateRun(runId, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return state;
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
    /**
     * Posture to record on the run instead of the requested one. The `parked`
     * write-ahead uses this to advertise the attempt through `lastTransition`
     * without claiming the run is already parked; machine parking may still
     * refuse it, and a refusal changes nothing.
     */
    posture: ResourcePosture = context.policy.posture,
  ): RunResourcePostureState {
    const state: RunResourcePostureState = {
      posture,
      policySource: context.policy.policySource,
      ...(context.policy.gateChoice ? { gateChoice: context.policy.gateChoice } : {}),
      ...(context.run.waitPolicy ? { waitPolicy: context.run.waitPolicy } : {}),
      capabilities: context.states,
      // Nothing in this module can stop a worker; `parked` delegates that to
      // machine parking, which refuses gate-held runs.
      workerRetained: posture !== 'parked',
      lastTransition: transition,
      recentTransitions: withTransition(context.run.resourcePosture, transition),
      updatedAt: this.now().toISOString(),
    };
    const updated = this.deps.updateRun(context.run.id, { resourcePosture: state });
    this.deps.onRunUpdated?.(updated);
    return state;
  }

  /**
   * Preparation for a validation or recipe rerun has to prove its proof plan is
   * alive, and lease state is not that proof: a provider can die while the run
   * waits and the lease still reads `acquired`. So `active` with requirements
   * never takes the idempotent short-circuit — the acquire pass runs and
   * re-checks provider health.
   */
  private requiresFreshHealth(context: ResolvedContext): boolean {
    return context.policy.posture === 'active' && context.proofRequirements.length > 0;
  }

  private isIdempotent(context: ResolvedContext): boolean {
    if (this.requiresFreshHealth(context)) return false;
    const persisted = context.run.resourcePosture;
    if (persisted?.posture !== context.policy.posture) return false;
    // `parked` is the one posture this module does not own — machine parking
    // does, and its record is the authority. A run whose park was restored or
    // cancelled is NOT parked however the persisted posture still reads, and
    // short-circuiting there refuses to park it ever again: the operator picks
    // `free-slot` at the next gate and gets a silent no-op.
    if (context.policy.posture === 'parked' && !hasLiveParkRecord(context.run)) return false;
    return context.states.every((state) => dispositionSatisfied(state.desiredDisposition, state));
  }

  /**
   * Every lease this posture owns, grouped by capability and never collapsed:
   * two sibling family runs can each hold a lease on the same capability, and a
   * family terminal has to release both. Collapsing them would leave one
   * acquired while status claimed the capability was stopped.
   */
  private leasesForRun(
    run: Run,
    status: RuntimeCapabilityStatusResult,
    posture: ResourcePosture,
  ): Map<string, RuntimeCapabilityLease[]> {
    const includeFamily = posture === 'terminal' && Boolean(run.familyId);
    const owned = status.leases.filter(
      (lease) =>
        lease.owner.runId === run.id || (includeFamily && lease.owner.familyId === run.familyId),
    );
    const byCapability = new Map<string, RuntimeCapabilityLease[]>();
    for (const lease of owned) {
      const group = byCapability.get(lease.capabilityId) ?? [];
      group.push(lease);
      byCapability.set(lease.capabilityId, group);
    }
    for (const group of byCapability.values()) {
      group.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
    return byCapability;
  }

  private capabilityState(
    capabilityId: string,
    desired: ResourcePostureDesiredDisposition,
    source: ResourcePosturePolicySource,
    reason: string,
    group: RuntimeCapabilityLease[] | undefined,
    entry: RuntimeCapabilityCatalogEntry | undefined,
    nowMs: number,
  ): ResourcePostureCapabilityState {
    const leases = group ?? [];
    const observed = leases.map((lease) => observedStateForLease(lease, nowMs));
    // A capability is only stopped when no sibling lease still holds it, and a
    // cleanup failure always outranks a sibling that looks healthy.
    const failed = leases.find((lease) => lease.cleanupFailure);
    const observedState: ResourcePostureObservedState = failed
      ? 'unhealthy'
      : observed.includes('unhealthy')
        ? 'unhealthy'
        : observed.includes('transitioning')
          ? 'transitioning'
          : observed.includes('running')
            ? 'running'
            : observed.includes('unknown')
              ? 'unknown'
              : 'stopped';
    // Report the lease that still holds the provider, not merely the newest.
    const holder =
      leases.find((lease, index) => observed[index] === 'running') ?? failed ?? leases[0];
    const warmUntil = leases
      .map((lease) => lease.keepWarmUntil)
      .filter((value): value is string => Boolean(value && Date.parse(value) > nowMs))
      .sort()
      .at(-1);
    return {
      capabilityId,
      desiredDisposition: desired,
      observedState,
      policySource: source,
      reason,
      ...(holder?.id ? { leaseId: holder.id } : {}),
      ...(holder?.owner ? { owner: holder.owner } : {}),
      ...(warmUntil ? { warmUntil } : {}),
      ...(holder?.updatedAt ? { lastTransitionAt: holder.updatedAt } : {}),
      releaseEffects: entry ? [...entry.releaseEffects] : [],
      ...(failed?.cleanupFailure ? { cleanupFailure: failed.cleanupFailure } : {}),
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
