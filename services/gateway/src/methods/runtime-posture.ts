/**
 * Production wiring for the ADR-054 posture reconciler and its three RPCs.
 *
 * The reconciler itself is dependency-injected and project-agnostic; this module
 * is the only place that binds it to the live registry, run store, fleet, and
 * machine parking service.
 */
import {
  Events,
  type RuntimePostureApplyParams,
  type RuntimePostureApplyResult,
  type RuntimePosturePreviewParams,
  type RuntimePosturePreviewResult,
  type RuntimePostureStatusParams,
  type RuntimePostureStatusResult,
} from '@farmslot/protocol';

import { loadFleetStatus } from '../fleet/state.js';
import { machineParkingService } from '../machine-parking/service.js';
import { getRun, updateRun } from '../runs/store.js';
import { RunResourcePostureReconciler } from '../runtime-capabilities/posture.js';

import { getRuntimeCapabilityRegistry } from './runtime-capabilities.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn | null = null;

export function initRuntimePosture(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

const reconciler = new RunResourcePostureReconciler({
  getRun,
  updateRun,
  capabilityStatus: (slotId) => getRuntimeCapabilityRegistry().status({ slotId }),
  acquireCapability: (params) => getRuntimeCapabilityRegistry().acquire(params),
  releaseForPosture: (slotId, dispositions) =>
    getRuntimeCapabilityRegistry().releaseForPosture(slotId, dispositions),
  machineForSlot: async (slotId) => {
    const fleet = await loadFleetStatus();
    return fleet.slots.find((candidate) => candidate.slot === slotId)?.machine ?? null;
  },
  parkPreview: (params) => machineParkingService.preview(params),
  parkExecute: (params) => machineParkingService.execute(params),
  onRunUpdated: (run) => broadcastFn?.(Events.RUN_UPDATED, { run }),
});

export function getRunResourcePostureReconciler(): RunResourcePostureReconciler {
  return reconciler;
}

export async function runtimePostureStatus(
  params: RuntimePostureStatusParams,
): Promise<RuntimePostureStatusResult> {
  return reconciler.status(params.runId);
}

export async function runtimePosturePreview(
  params: RuntimePosturePreviewParams,
): Promise<RuntimePosturePreviewResult> {
  return reconciler.preview(params);
}

export async function runtimePostureApply(
  params: RuntimePostureApplyParams,
): Promise<RuntimePostureApplyResult> {
  return reconciler.apply(params);
}
