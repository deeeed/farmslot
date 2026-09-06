import os from 'node:os';
import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  type Run,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityListParams,
  type RuntimeCapabilityListResult,
  type RuntimeCapabilityProviderActionRef,
  type RuntimeCapabilityReleaseParams,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusParams,
  type RuntimeCapabilityStatusResult,
  type RuntimeCapabilityStopWarmParams,
  type RuntimeCapabilityStopWarmResult,
} from '@farmslot/protocol';

import {
  loadProjectVars,
  loadSlotVars,
  normalizeRawRuntimeCapabilities,
  resolveSlot,
} from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { executeResourceControl, probeResourceStatus } from '../fleet/resource-manager.js';
import { loadFleetStatus } from '../fleet/state.js';
import { getRun } from '../runs/store.js';
import {
  evaluateRuntimeCapabilityAdmission,
  type RuntimeCapabilityPressureSnapshot,
} from '../runtime-capabilities/admission.js';
import {
  claimsDevice,
  crossSlotTargetConflict,
  type DeviceHolder,
  deviceIdentityOnly,
  deviceTargetExtraVars,
  displaceIdentity,
} from '../runtime-capabilities/device-target.js';
import {
  type RuntimeCapabilityActionResult,
  type RuntimeCapabilityCatalogContext,
  runtimeCapabilityProviderDigest,
  RuntimeCapabilityRegistry,
  type WarmSweepSummary,
} from '../runtime-capabilities/registry.js';
import { RuntimeCapabilityStore } from '../runtime-capabilities/store.js';

import { resourceHealth, resourceHostPressure } from './resource.js';
import { slotActionRun } from './slot-actions.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn | null = null;
let keepWarmCleanupTimer: ReturnType<typeof setInterval> | null = null;

function testStorePath(): string {
  return path.join(os.tmpdir(), `farmslot-test-runtime-capabilities-${process.pid}.json`);
}

function runtimeCapabilityStorePath(): string {
  if (process.env.FARMSLOT_CAPABILITY_STORE_FILE) {
    return process.env.FARMSLOT_CAPABILITY_STORE_FILE;
  }
  if (process.env.FARMSLOT_TEST_TMP === '1' || process.env.NODE_TEST_CONTEXT) {
    return testStorePath();
  }
  const gatewayPort = process.env.GATEWAY_PORT?.trim() || '7777';
  const root = process.env.FARMSLOT_ROOT?.trim() || process.cwd();
  return path.join(root, '.runs', `runtime-capabilities-${gatewayPort}.json`);
}

function normalizeActionId(
  ref: Extract<RuntimeCapabilityProviderActionRef, { kind: 'slot-action' }>,
): string {
  if (ref.actionId.startsWith('slot:') || ref.actionId.startsWith('resource:')) return ref.actionId;
  const [resourceId, actionId] = ref.actionId.split('.', 2);
  return actionId ? `resource:${resourceId}:${actionId}` : `slot:${ref.actionId}`;
}

function actionCommand(
  projectJson: Awaited<ReturnType<typeof loadProjectVars>>['projectJson'],
  ref: RuntimeCapabilityProviderActionRef,
): string | undefined {
  if (ref.kind === 'resource') {
    const resource = projectJson.resources?.[ref.resourceId];
    const hook = resource?.hooks?.[ref.action];
    if (hook || ref.action !== 'health') return hook;
    const watchInputs = [resource?.watch?.path, resource?.watch?.port, resource?.watch?.cmd].filter(
      (value): value is string => typeof value === 'string',
    );
    return watchInputs.length > 0 ? watchInputs.join(' ') : undefined;
  }
  const [resourceId, nestedActionId] = ref.actionId.split('.', 2);
  return nestedActionId
    ? projectJson.resources?.[resourceId]?.actions?.[nestedActionId]?.command
    : projectJson.slot_actions?.[ref.actionId]?.command;
}

async function catalogForSlot(slotId: string): Promise<RuntimeCapabilityCatalogContext> {
  const slotVars = await loadSlotVars(slotId);
  const projectVars = await loadProjectVars(slotVars.projectName);
  const { slot } = await resolveSlot(slotId);
  const configured = normalizeRawRuntimeCapabilities(projectVars.projectJson.runtime_capabilities);
  const providers = configured?.providers ?? {};
  const capabilities: RuntimeCapabilityCatalogEntry[] = Object.entries(providers)
    .map(([id, provider]) => {
      const digest = runtimeCapabilityProviderDigest(provider);
      let unavailableReason: string | undefined;
      for (const ref of Object.values(provider.actions)) {
        if (ref.kind === 'resource') {
          if (!Object.prototype.hasOwnProperty.call(slot.resources ?? {}, ref.resourceId)) {
            unavailableReason = `Slot '${slotId}' does not configure resource '${ref.resourceId}'`;
            break;
          }
        }
        const command = actionCommand(projectVars.projectJson, ref);
        const unresolved = command
          ? expandTemplate(command, slotVars, projectVars).match(/\{\{[^}\n]+\}\}/g)
          : null;
        if (!command || unresolved?.length) {
          const actionId =
            ref.kind === 'resource' ? `${ref.resourceId}.${ref.action}` : ref.actionId;
          unavailableReason = !command
            ? `Provider action '${actionId}' is unavailable`
            : `Provider action '${actionId}' needs ${unresolved!.join(', ')}`;
          break;
        }
      }
      return {
        id,
        project: slotVars.projectName,
        ...structuredClone(provider),
        provenance: {
          project: slotVars.projectName,
          providerId: id,
          version: provider.version,
          digest,
        },
        availability: unavailableReason
          ? { state: 'unavailable' as const, reason: unavailableReason }
          : { state: 'available' as const },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    slotId,
    project: slotVars.projectName,
    capabilities,
    ...(configured?.posture ? { posture: structuredClone(configured.posture) } : {}),
  };
}

/**
 * Run one provider action for a lease.
 *
 * The lease's acquire parameters are what make a re-target real (ADR-054 item
 * 3): the device-identity subset becomes hook template variables that take
 * precedence over the slot's configured resource fields, so `{{simulator}}`,
 * `{{avd}}` and `{{adb_serial}}` resolve to the leased device. A value that
 * cannot be safely substituted into a project hook command is refused here
 * rather than escaped — see `deviceTargetExtraVars`.
 */
async function runProviderAction(
  slotId: string,
  ref: RuntimeCapabilityProviderActionRef,
  parameters: Record<string, unknown>,
  declaredParameters: readonly string[],
): Promise<RuntimeCapabilityActionResult> {
  const target = deviceTargetExtraVars(parameters, declaredParameters);
  if (!target.ok) return { ok: false, detail: target.reason };
  const extraVars = target.value;
  if (ref.kind === 'slot-action') {
    const result = await slotActionRun({ slotId, actionId: normalizeActionId(ref) }, extraVars);
    return { ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) };
  }
  if (ref.action === 'health') {
    // With no device override the slot-wide poll stays the health read: it also
    // refreshes the resource cache every client renders from. A re-targeted
    // lease cannot use it — that poll answers for the slot's CONFIGURED device —
    // so it probes the leased device directly instead.
    // Gated on a DEVICE key, not on any extraVars: a parameter set carrying only
    // `platform` resolves to the slot's own device, so the slot-wide poll is
    // still the right read and still refreshes the cache clients render from.
    if (extraVars && deviceIdentityOnly(extraVars)) {
      // Same derivation as the poll below — `probeResourceStatus` is where that
      // rule lives — so a re-targeted lease cannot be called healthy where the
      // default path would report the resource unknown or stopped.
      const probe = await probeResourceStatus(slotId, ref.resourceId, extraVars);
      return {
        ok: probe.status === 'running',
        detail: `${ref.resourceId} is ${probe.status}${probe.detail ? `: ${probe.detail}` : ''}`,
      };
    }
    const result = await resourceHealth({ slotId });
    const resource = result.resources.find((candidate) => candidate.id === ref.resourceId);
    if (!resource) return { ok: false, detail: `Resource '${ref.resourceId}' is unavailable` };
    return {
      ok: resource.status === 'running',
      detail: `${ref.resourceId} is ${resource.status}`,
    };
  }
  return executeResourceControl(slotId, ref.resourceId, ref.action, extraVars);
}

/**
 * Refuse a device target that another slot's live lease is already driving.
 *
 * Capability leases are slot-scoped, so nothing else stops two runs booting one
 * simulator once a target can name a device outside the slot's own config.
 * Fleet-scoped arbitration with a wait queue is the separate
 * `fleet-scoped-device-claims` item; until it lands this refuses rather than
 * queues.
 */
/** The config reads the guard needs, injectable so the rule can be tested. */
export interface DeviceTargetGuardDeps {
  loadSlotVars: (
    slotId: string,
  ) => Promise<{ machine: string; resourceVars: Record<string, string> }>;
  catalogForSlot: (slotId: string) => Promise<{ capabilities: RuntimeCapabilityCatalogEntry[] }>;
}

export async function assertDeviceTargetAvailable(
  input: {
    slotId: string;
    capabilityId: string;
    ownerRunId: string;
    parameters: Record<string, unknown>;
    /**
     * Whether this capability claims a device, resolved by the registry from the
     * catalog entry it already holds under its own lock. Passed in rather than
     * re-read here: re-reading meant a config file mid-write could make the
     * guard skip itself for exactly the acquires it exists to check.
     */
    claimsDevice: boolean;
    activeLeases: readonly RuntimeCapabilityLease[];
  },
  deps: DeviceTargetGuardDeps = { loadSlotVars, catalogForSlot },
): Promise<string | null> {
  const target = deviceTargetExtraVars(input.parameters);
  if (!target.ok) return target.reason;
  // `platform` names no device, so it can never conflict. Short-circuit before
  // any slot config is read: the fan-out below can REFUSE when a foreign slot's
  // config is unreadable, and refusing over a parameter that could not have
  // conflicted would block an acquire for nothing.
  const requested = target.value ? deviceIdentityOnly(target.value) : undefined;
  if (!requested && !input.claimsDevice) return null;

  // The acquiring slot's own machine and configured device. Fails CLOSED, like
  // the foreign-slot read below: an acquire that names no device still resolves
  // to the slot's configured one, and without this read we cannot say which
  // device that is or which machine it is on.
  let ownVars;
  try {
    ownVars = await deps.loadSlotVars(input.slotId);
  } catch (error) {
    return `cannot resolve the configured device of slot '${input.slotId}': ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const machine = ownVars.machine;
  const effective = requested ?? deviceIdentityOnly(ownVars.resourceVars);
  if (!effective) return null;

  // Holders are built for every foreign slot and carry THEIR OWN machine;
  // `crossSlotTargetConflict` does the machine scoping. Filtering here instead
  // would leave that filter unreachable and stamp the acquirer's machine on the
  // refusal, naming the wrong host. The extra reads are bounded by the number of
  // distinct slots holding a live lease, which is small.
  const slotState = new Map<
    string,
    { machine: string; identity: Record<string, unknown>; deviceCapabilities: Set<string> }
  >();
  const holders: DeviceHolder[] = [];
  for (const lease of input.activeLeases) {
    if (lease.slotId === input.slotId) continue;
    let state = slotState.get(lease.slotId);
    if (!state) {
      try {
        const slotVars = await deps.loadSlotVars(lease.slotId);
        const catalog = await deps.catalogForSlot(lease.slotId);
        state = {
          machine: slotVars.machine,
          identity: slotVars.resourceVars,
          // A slot's configured device is only off-limits when something is
          // actually driving a DEVICE there. Treating any lease as a holder
          // made a slot running only a browser or Metro block its own
          // simulator, and named that capability as the reason.
          deviceCapabilities: new Set(
            catalog.capabilities.filter(claimsDevice).map((entry) => entry.id),
          ),
        };
      } catch (error) {
        // Handled, not swallowed: without that slot's configuration we cannot
        // prove the requested device is free, and guessing costs two runs
        // driving one device. Refuse and name the slot that could not be read.
        return `cannot verify device target against slot '${lease.slotId}', which holds an active '${lease.capabilityId}' lease: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      slotState.set(lease.slotId, state);
    }
    if (!state.deviceCapabilities.has(lease.capabilityId)) continue;
    holders.push({
      slotId: lease.slotId,
      machine: state.machine,
      capabilityId: lease.capabilityId,
      runId: lease.owner.runId,
      // The lease's own identity DISPLACES the slot's configured one within the
      // same group: a slot whose lease was re-targeted away from its configured
      // simulator is not using that simulator, and refusing a target for it
      // would block a legal move.
      identities: [displaceIdentity(state.identity, lease.parameters)],
    });
  }
  return crossSlotTargetConflict(effective, holders, machine);
}

async function pressureFor(
  slotId: string,
  entry: RuntimeCapabilityCatalogEntry,
  queueOnPressure: boolean,
) {
  const slotVars = await loadSlotVars(slotId);
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((candidate) => candidate.slot === slotId);
  const machineName = slot?.machine ?? slotVars.machine;
  const machine = await resourceHostPressure(machineName, entry.project);
  const localSlot = isLocal(slotVars.host, slotVars.machine);
  const unavailableReason = !localSlot
    ? machine?.online === false
      ? 'Machine is offline.'
      : machine?.online == null
        ? 'No machine health metrics available.'
        : undefined
    : undefined;
  const staleLocalAvailability = localSlot && machine?.online !== true;
  const pressure: RuntimeCapabilityPressureSnapshot = {
    severity: staleLocalAvailability ? 'ok' : machine.severity,
    ...(!staleLocalAvailability && machine.concerns[0]?.reason
      ? { reason: machine.concerns[0].reason }
      : {}),
    machine: machineName,
    retryAfterMs: 15_000,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  return evaluateRuntimeCapabilityAdmission(entry, pressure, queueOnPressure);
}

/**
 * Whether the run store says this run has had its terminal capability cleanup.
 *
 * Terminal status OR the ADR-054 terminal posture: the posture is what the
 * reconciler records when it stops a run's providers, and it can land before
 * the run itself settles.
 */
function hasHadTerminalCleanup(run: Run): boolean {
  return isTerminalRunStatus(run.status) || run.resourcePosture?.posture === 'terminal';
}

const registry = new RuntimeCapabilityRegistry({
  store: new RuntimeCapabilityStore(runtimeCapabilityStorePath()),
  catalogForSlot,
  runAction: runProviderAction,
  assertTargetAvailable: assertDeviceTargetAvailable,
  pressureFor,
  familyForRun: (ownerRunId) => getRun(ownerRunId)?.familyId,
  // The durable half of the terminal fence. The registry's own owner list is a
  // bounded fast path; the run store is what still knows after a restart or an
  // eviction, from the run's own terminal status or the terminal posture
  // ADR-054 recorded on it.
  isTerminalOwner: (ownerRunId) => {
    const run = getRun(ownerRunId);
    if (!run) return false;
    return hasHadTerminalCleanup(run);
  },
  // No family predicate on purpose. There is no run-store question that answers
  // "did a family-scope cleanup run": asking whether any member is terminal
  // fenced live children, because a CI-watch chain's follow-up run shares its
  // parent's family and the parent reaching `done` refused its own child at
  // PREPARE. The durable family entries, written only by an actual family-scope
  // cleanup, are the whole authority.
  onEvent(event) {
    broadcastFn?.(Events.RUNTIME_CAPABILITY_LIFECYCLE, { event });
  },
});

export async function initRuntimeCapabilities(broadcast: BroadcastFn): Promise<void> {
  broadcastFn = broadcast;
  await registry.initialize();
  if (!keepWarmCleanupTimer) {
    keepWarmCleanupTimer = setInterval(() => {
      void registry.cleanupExpiredWarmProviders().catch((error: unknown) => {
        console.warn(
          `[runtime-capabilities] keep-warm cleanup failed: ${(error as Error).message}`,
        );
      });
    }, 30_000);
    keepWarmCleanupTimer.unref();
  }
}

export function getRuntimeCapabilityRegistry(): RuntimeCapabilityRegistry {
  return registry;
}

export async function runtimeCapabilityList(
  params: RuntimeCapabilityListParams,
): Promise<RuntimeCapabilityListResult> {
  return registry.list(params.slotId);
}

export async function runtimeCapabilityAcquire(
  params: RuntimeCapabilityAcquireParams,
): Promise<RuntimeCapabilityAcquireResult> {
  return registry.acquire(params);
}

export async function runtimeCapabilityRelease(
  params: RuntimeCapabilityReleaseParams,
): Promise<RuntimeCapabilityReleaseResult> {
  return registry.release(params);
}

export async function runtimeCapabilityStatus(
  params: RuntimeCapabilityStatusParams,
): Promise<RuntimeCapabilityStatusResult> {
  return registry.status(params);
}

export async function releaseRuntimeCapabilitiesForRunAndFamily(
  slotId: string,
  ownerRunId: string,
  familyId: string,
): Promise<RuntimeCapabilityReleaseResult> {
  return registry.releaseRunAndFamily(slotId, ownerRunId, familyId);
}

export async function releaseRuntimeCapabilitiesForSlot(
  slotId: string,
): Promise<RuntimeCapabilityReleaseResult> {
  return registry.releaseSlot(slotId);
}

/**
 * Map one warm-sweep summary onto the RPC result. Pure so every outcome —
 * including "cleanup failed, so we do not know" — is testable without a slot.
 */
export function stopWarmResultFromSummary(
  params: RuntimeCapabilityStopWarmParams,
  summary: WarmSweepSummary,
  /** The capability's leases on this slot after the sweep. */
  leases: RuntimeCapabilityLease[] = [],
): RuntimeCapabilityStopWarmResult {
  const base = { slotId: params.slotId, capabilityId: params.capabilityId };
  const failure = summary.failures.find((entry) => entry.capabilityId === params.capabilityId);
  if (failure) {
    // Cleanup ran and failed, so the provider's real state is not known. Never
    // report it stopped.
    return {
      ...base,
      ok: false,
      outcome: 'failed',
      observedState: 'unhealthy',
      cleanupFailure: failure.reason,
      effects: [],
    };
  }
  if (summary.released.some((lease) => lease.capabilityId === params.capabilityId)) {
    return {
      ...base,
      ok: true,
      outcome: 'stopped',
      observedState: 'stopped',
      effects: summary.effects,
    };
  }
  if (summary.deferred.some((lease) => lease.capabilityId === params.capabilityId)) {
    return {
      ...base,
      ok: false,
      outcome: 'deferred',
      observedState: 'running',
      reason: `'${params.capabilityId}' is still needed by an active or warm dependent; it stays up until that dependent is done with it`,
      effects: [],
    };
  }
  if (summary.stillHeld.some((lease) => lease.capabilityId === params.capabilityId)) {
    return {
      ...base,
      ok: false,
      outcome: 'deferred',
      observedState: 'running',
      reason: `'${params.capabilityId}' is still held by another lease on this slot`,
      effects: [],
    };
  }
  // An earlier cleanup that failed leaves the lease in `error` with the reason
  // stored on it. The sweep selects only `released` leases, so a retry finds
  // nothing warm — but the provider may well still be up, which is exactly what
  // that stored failure records. Report it, never `stopped`.
  const unresolved = leases.find(
    (lease) =>
      lease.capabilityId === params.capabilityId &&
      lease.state === 'error' &&
      Boolean(lease.cleanupFailure),
  );
  if (unresolved) {
    return {
      ...base,
      ok: false,
      outcome: 'failed',
      observedState: 'unknown',
      reason: `'${params.capabilityId}' has unresolved cleanup on ${params.slotId}; its provider may still be running`,
      cleanupFailure: unresolved.cleanupFailure!,
      effects: [],
    };
  }
  // Nothing was warm, which says nothing about whether the provider is up: an
  // active lease may still hold it. Read that off the leases rather than
  // assuming stopped.
  const heldByActiveLease = leases.some(
    (lease) =>
      lease.capabilityId === params.capabilityId &&
      ['acquiring', 'acquired', 'releasing'].includes(lease.state),
  );
  return {
    ...base,
    ok: true,
    outcome: 'not-warm',
    observedState: heldByActiveLease ? 'running' : 'stopped',
    reason: heldByActiveLease
      ? `'${params.capabilityId}' is not warm on ${params.slotId}; it is held by an active lease`
      : `nothing is keeping '${params.capabilityId}' warm on ${params.slotId}`,
    effects: [],
  };
}

/**
 * Stop one provider that a released lease is still keeping warm.
 *
 * `runtime.capability.release` cannot do this: it only considers leases that
 * still hold a provider, so for an already-released warm lease it reports
 * success while the process keeps running. This runs the registry's own
 * dependency-safe warm sweep for that single capability, which defers rather
 * than stopping anything an active or still-warm dependent needs, and reports
 * what actually happened instead of assuming.
 */
export async function runtimeCapabilityStopWarm(
  params: RuntimeCapabilityStopWarmParams,
): Promise<RuntimeCapabilityStopWarmResult> {
  if (typeof params.slotId !== 'string' || !params.slotId.trim()) {
    throw new Error('slotId must be a non-empty string');
  }
  if (typeof params.capabilityId !== 'string' || !params.capabilityId.trim()) {
    throw new Error('capabilityId must be a non-empty string');
  }
  const summary = await registry.stopWarmProviders(params.slotId, [params.capabilityId]);
  const status = await registry.status({ slotId: params.slotId });
  return stopWarmResultFromSummary(params, summary, status.leases);
}
