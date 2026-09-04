/**
 * Production wiring for the ADR-054 posture reconciler and its three RPCs.
 *
 * The reconciler itself is dependency-injected and project-agnostic; this module
 * is the only place that binds it to the live registry, run store, fleet, and
 * machine parking service.
 */
import {
  Events,
  isResourcePosture,
  isResourcePostureGateChoice,
  RESOURCE_POSTURE_GATE_CHOICES,
  RESOURCE_POSTURES,
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
  stopWarmProviders: (slotId, capabilityIds) =>
    getRuntimeCapabilityRegistry().stopWarmProviders(slotId, capabilityIds),
  releaseRunTerminal: (slotId, ownerRunId, familyId) =>
    getRuntimeCapabilityRegistry().releaseRunTerminal(slotId, ownerRunId, familyId),
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

/**
 * Wire-level guard. The reconciler already turns an unknown run into a typed
 * rejection, but a malformed `runId` should fail as a request error rather than
 * reaching the run store at all.
 */
function requireRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('runId must be a non-empty string');
  }
  return runId;
}

const PROOF_MODES = new Set(['state', 'visual', 'mixed']);

function assertProofRequirements(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('proofRequirements must be an array');
  value.forEach((requirement, index) => {
    const field = `proofRequirements[${index}]`;
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new Error(`${field} must be an object`);
    }
    const entry = requirement as Record<string, unknown>;
    if (typeof entry.capabilityId !== 'string' || !entry.capabilityId.trim()) {
      throw new Error(`${field}.capabilityId must be a non-empty string`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`${field}.reason must be a non-empty string`);
    }
    if (typeof entry.mode !== 'string' || !PROOF_MODES.has(entry.mode)) {
      throw new Error(`${field}.mode must be one of ${[...PROOF_MODES].join(', ')}`);
    }
    if (
      entry.parameters !== undefined &&
      (entry.parameters === null ||
        typeof entry.parameters !== 'object' ||
        Array.isArray(entry.parameters))
    ) {
      throw new Error(`${field}.parameters must be an object`);
    }
  });
}

function assertPostureRequest(params: RuntimePosturePreviewParams): void {
  requireRunId(params.runId);
  if (params.posture !== undefined && !isResourcePosture(params.posture)) {
    throw new Error(`posture must be one of ${RESOURCE_POSTURES.join(', ')}`);
  }
  if (params.gateChoice !== undefined && !isResourcePostureGateChoice(params.gateChoice)) {
    throw new Error(`gateChoice must be one of ${RESOURCE_POSTURE_GATE_CHOICES.join(', ')}`);
  }
  assertProofRequirements(params.proofRequirements);
}

export async function runtimePostureStatus(
  params: RuntimePostureStatusParams,
): Promise<RuntimePostureStatusResult> {
  return reconciler.status(requireRunId(params.runId));
}

export async function runtimePosturePreview(
  params: RuntimePosturePreviewParams,
): Promise<RuntimePosturePreviewResult> {
  assertPostureRequest(params);
  return reconciler.preview(params);
}

export async function runtimePostureApply(
  params: RuntimePostureApplyParams,
): Promise<RuntimePostureApplyResult> {
  assertPostureRequest(params);
  if (params.operationId !== undefined) {
    if (typeof params.operationId !== 'string' || !params.operationId.trim()) {
      throw new Error('operationId must be a non-empty string');
    }
  }
  return reconciler.apply(params);
}
