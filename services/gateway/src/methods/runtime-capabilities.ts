import os from 'node:os';
import path from 'node:path';

import {
  Events,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityListParams,
  type RuntimeCapabilityListResult,
  type RuntimeCapabilityProviderActionRef,
  type RuntimeCapabilityReleaseParams,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusParams,
  type RuntimeCapabilityStatusResult,
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
import {
  evaluateRuntimeCapabilityAdmission,
  type RuntimeCapabilityPressureSnapshot,
} from '../runtime-capabilities/admission.js';
import {
  type RuntimeCapabilityActionResult,
  type RuntimeCapabilityCatalogContext,
  runtimeCapabilityProviderDigest,
  RuntimeCapabilityRegistry,
} from '../runtime-capabilities/registry.js';
import { RuntimeCapabilityStore } from '../runtime-capabilities/store.js';

import { resourceControl, resourceHealth, resourcePressureSnapshot } from './resource.js';
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
  return { slotId, project: slotVars.projectName, capabilities };
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
  const snapshot = await resourcePressureSnapshot({
    machine: machineName,
    project: entry.project,
  });
  const machine = snapshot.machines.find((candidate) => candidate.machine === machineName);
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
    severity: staleLocalAvailability ? 'ok' : (machine?.severity ?? snapshot.summary.severity),
    ...(!staleLocalAvailability && machine?.concerns[0]?.reason
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

export async function releaseRuntimeCapabilitiesForRun(
  slotId: string,
  runId: string,
): Promise<RuntimeCapabilityReleaseResult> {
  return registry.release({ slotId, ownerRunId: runId });
}
