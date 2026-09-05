import os from 'node:os';
import path from 'node:path';

import {
  Events,
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
import { loadFleetStatus } from '../fleet/state.js';
import { getRun } from '../runs/store.js';
import {
  evaluateRuntimeCapabilityAdmission,
  type RuntimeCapabilityPressureSnapshot,
} from '../runtime-capabilities/admission.js';
import {
  type RuntimeCapabilityActionResult,
  type RuntimeCapabilityCatalogContext,
  runtimeCapabilityProviderDigest,
  RuntimeCapabilityRegistry,
  type WarmSweepSummary,
} from '../runtime-capabilities/registry.js';
import { RuntimeCapabilityStore } from '../runtime-capabilities/store.js';

import { resourceControl, resourceHealth, resourceHostPressure } from './resource.js';
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

async function runProviderAction(
  slotId: string,
  ref: RuntimeCapabilityProviderActionRef,
): Promise<RuntimeCapabilityActionResult> {
  if (ref.kind === 'slot-action') {
    const result = await slotActionRun({ slotId, actionId: normalizeActionId(ref) });
    return { ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) };
  }
  if (ref.action === 'health') {
    const result = await resourceHealth({ slotId });
    const resource = result.resources.find((candidate) => candidate.id === ref.resourceId);
    if (!resource) return { ok: false, detail: `Resource '${ref.resourceId}' is unavailable` };
    return {
      ok: resource.status === 'running',
      detail: `${ref.resourceId} is ${resource.status}`,
    };
  }
  return resourceControl({ slotId, resourceId: ref.resourceId, action: ref.action });
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

const registry = new RuntimeCapabilityRegistry({
  store: new RuntimeCapabilityStore(runtimeCapabilityStorePath()),
  catalogForSlot,
  runAction: runProviderAction,
  pressureFor,
  familyForRun: (ownerRunId) => getRun(ownerRunId)?.familyId,
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
