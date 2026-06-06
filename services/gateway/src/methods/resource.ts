// methods/resource.ts — resource.list + resource.control + resource.health handlers

import type {
  MachineHealth,
  ResourceCleanupParams,
  ResourceCleanupResult,
  ResourceControlParams,
  ResourceControlResult,
  ResourceHealthParams,
  ResourceHealthResult,
  ResourceListParams,
  ResourceListResult,
  ResourceStatus,
  ResourceWatchSetEnabledParams,
  ResourceWatchSetEnabledResult,
  SlotStatus,
} from '@farmslot/protocol';

import {
  executeResourceControl,
  getResourceWatchRuntimeState,
  pollSlotResources,
  resolveSlotResources,
  setResourceWatchesEnabled,
} from '../fleet/resource-manager.js';
import { loadFleetStatus } from '../fleet/state.js';

const RESOURCE_STATUSES: ResourceStatus[] = ['unknown', 'running', 'stopped', 'error', 'stale'];

type PressureSeverity = 'ok' | 'warn' | 'critical';

interface PressureConcern {
  severity: Exclude<PressureSeverity, 'ok'>;
  reason: string;
}

export interface ResourcePressureSnapshotParams {
  machine?: string;
  project?: string;
}

export interface ResourcePressureMachine {
  machine: string;
  online: boolean | null;
  headroom: MachineHealth['headroom'] | 'unknown';
  severity: PressureSeverity;
  concerns: PressureConcern[];
  system?: MachineHealth['system'];
  capacity?: MachineHealth['capacity'];
  slots: {
    total: number;
    ready: number;
    busy: number;
    working: number;
    manual: number;
    disabled: number;
  };
  resources: {
    total: number;
    byStatus: Record<ResourceStatus, number>;
    cleanupCandidates: number;
  };
}

export interface ResourcePressureSnapshotResult {
  checkedAt: string;
  watchState: { enabled: boolean; updatedAt: string | null };
  watchAutoStartEnabled: boolean;
  cleanupScope: 'idle-only';
  filters: ResourcePressureSnapshotParams;
  summary: {
    machines: number;
    severity: PressureSeverity;
    cleanupCandidates: number;
    runningResources: number;
    staleResources: number;
    busySlots: number;
    workingSlots: number;
  };
  machines: ResourcePressureMachine[];
  cleanupCandidates: ResourceCleanupResult['targets'];
}

export async function resourceList(params: ResourceListParams): Promise<ResourceListResult> {
  const resources = await resolveSlotResources(params.slotId);
  return { resources };
}

export async function resourceControl(
  params: ResourceControlParams,
): Promise<ResourceControlResult> {
  return executeResourceControl(params.slotId, params.resourceId, params.action);
}

export async function resourceHealth(params: ResourceHealthParams): Promise<ResourceHealthResult> {
  const results = await pollSlotResources(params.slotId, { probeInactiveSimulators: true });
  return { slotId: params.slotId, resources: results };
}

export async function resourceWatchSetEnabled(
  params: ResourceWatchSetEnabledParams,
): Promise<ResourceWatchSetEnabledResult> {
  return setResourceWatchesEnabled(params.enabled);
}

export async function resourceCleanup(
  params: ResourceCleanupParams,
): Promise<ResourceCleanupResult> {
  const dryRun = params.dryRun !== false;
  const statuses = new Set(params.statuses ?? ['running', 'stale']);
  const slotFilter = new Set(params.slotIds ?? []);
  const resourceFilter = new Set(params.resourceIds ?? []);
  const fleet = await loadFleetStatus();
  const slots = fleet.slots.filter((slot) => {
    if (!slot.enabled) return false;
    if (slot.lifecycle === 'disabled' || slot.lifecycle === 'manual') return false;
    if (!params.includeBusy && (slot.lifecycle === 'busy' || slot.agent === 'working'))
      return false;
    if (params.machine && slot.machine !== params.machine) return false;
    if (params.project && slot.project !== params.project) return false;
    if (slotFilter.size > 0 && !slotFilter.has(slot.slot)) return false;
    return true;
  });

  const targets: ResourceCleanupResult['targets'] = [];
  for (const slot of slots) {
    const resources = await resolveSlotResources(slot.slot);
    for (const resource of resources) {
      if (resourceFilter.size > 0 && !resourceFilter.has(resource.id)) continue;
      if (!statuses.has(resource.status)) continue;
      if (!resource.definition.controllable || !resource.definition.hooks?.shutdown) continue;
      targets.push({
        slotId: slot.slot,
        machine: slot.machine,
        project: slot.project,
        resourceId: resource.id,
        label: resource.definition.label,
        status: resource.status,
      });
    }
  }

  if (!dryRun) {
    for (const target of targets) {
      const result = await executeResourceControl(target.slotId, target.resourceId, 'shutdown');
      target.ok = result.ok;
      target.detail = result.detail;
    }
    const slotsToVerify = [...new Set(targets.map((target) => target.slotId))];
    for (const slotId of slotsToVerify) {
      const statuses = await pollSlotResources(slotId);
      const statusByResource = new Map(statuses.map((status) => [status.id, status.status]));
      for (const target of targets.filter((item) => item.slotId === slotId)) {
        const afterStatus = statusByResource.get(target.resourceId);
        if (!afterStatus) continue;
        target.afterStatus = afterStatus;
        if (afterStatus === 'running' || afterStatus === 'stale') {
          target.ok = false;
          target.detail = target.detail
            ? `${target.detail}; shutdown verification still reports ${afterStatus}`
            : `shutdown verification still reports ${afterStatus}`;
        }
      }
    }
  }

  const stopped = dryRun ? 0 : targets.filter((target) => target.ok).length;
  const failed = dryRun ? 0 : targets.filter((target) => target.ok === false).length;
  return { ok: failed === 0, dryRun, targets, stopped, failed };
}

export async function resourcePressureSnapshot(
  params: ResourcePressureSnapshotParams = {},
): Promise<ResourcePressureSnapshotResult> {
  const fleet = await loadFleetStatus();
  const cleanupPreview = await resourceCleanup({ dryRun: true, ...params });
  const watchState = getResourceWatchRuntimeState();
  const healthByMachine = new Map((fleet.machines ?? []).map((health) => [health.machine, health]));
  const slots = fleet.slots.filter((slot) => matchesPressureFilters(slot, params));
  const machineNames = new Set<string>();
  for (const slot of slots) machineNames.add(slot.machine);
  for (const health of fleet.machines ?? []) {
    if (params.machine && health.machine !== params.machine) continue;
    machineNames.add(health.machine);
  }

  const machines: ResourcePressureMachine[] = [];
  for (const machine of [...machineNames].sort()) {
    const health = healthByMachine.get(machine);
    const machineSlots = slots.filter((slot) => slot.machine === machine);
    const byStatus = emptyStatusCounts();
    for (const slot of machineSlots) {
      const resources = await resolveSlotResources(slot.slot);
      for (const resource of resources) byStatus[resource.status] += 1;
    }
    const cleanupCandidates = cleanupPreview.targets.filter(
      (target) => target.machine === machine,
    ).length;
    const concerns = buildPressureConcerns(
      health,
      machineSlots,
      byStatus,
      cleanupCandidates,
      watchState.enabled,
    );
    machines.push({
      machine,
      online: health?.online ?? null,
      headroom: health?.headroom ?? 'unknown',
      severity: pressureSeverity(concerns),
      concerns,
      ...(health?.system ? { system: health.system } : {}),
      ...(health?.capacity ? { capacity: health.capacity } : {}),
      slots: {
        total: machineSlots.length,
        ready: machineSlots.filter((slot) => slot.lifecycle === 'ready').length,
        busy: machineSlots.filter((slot) => slot.lifecycle === 'busy').length,
        working: machineSlots.filter((slot) => slot.agent === 'working').length,
        manual: machineSlots.filter((slot) => slot.lifecycle === 'manual').length,
        disabled: machineSlots.filter((slot) => slot.lifecycle === 'disabled' || !slot.enabled)
          .length,
      },
      resources: {
        total: RESOURCE_STATUSES.reduce((sum, status) => sum + byStatus[status], 0),
        byStatus,
        cleanupCandidates,
      },
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    watchState,
    watchAutoStartEnabled: watchState.enabled,
    cleanupScope: 'idle-only',
    filters: params,
    summary: {
      machines: machines.length,
      severity: aggregateSeverity(machines),
      cleanupCandidates: cleanupPreview.targets.length,
      runningResources: machines.reduce((sum, m) => sum + m.resources.byStatus.running, 0),
      staleResources: machines.reduce((sum, m) => sum + m.resources.byStatus.stale, 0),
      busySlots: machines.reduce((sum, m) => sum + m.slots.busy, 0),
      workingSlots: machines.reduce((sum, m) => sum + m.slots.working, 0),
    },
    machines,
    cleanupCandidates: cleanupPreview.targets,
  };
}

function matchesPressureFilters(slot: SlotStatus, params: ResourcePressureSnapshotParams): boolean {
  if (params.machine && slot.machine !== params.machine) return false;
  if (params.project && slot.project !== params.project) return false;
  return true;
}

function emptyStatusCounts(): Record<ResourceStatus, number> {
  return {
    unknown: 0,
    running: 0,
    stopped: 0,
    error: 0,
    stale: 0,
  };
}

function buildPressureConcerns(
  health: MachineHealth | undefined,
  slots: SlotStatus[],
  byStatus: Record<ResourceStatus, number>,
  cleanupCandidates: number,
  resourceWatchesEnabled: boolean,
): PressureConcern[] {
  const concerns: PressureConcern[] = [];
  if (!resourceWatchesEnabled) {
    concerns.push({
      severity: 'warn',
      reason: 'Resource watches are paused; cached resource statuses may be unknown.',
    });
  }
  if (!health) {
    concerns.push({ severity: 'warn', reason: 'No machine health metrics available.' });
  } else if (!health.online) {
    concerns.push({ severity: 'critical', reason: 'Machine is offline.' });
  } else {
    if (health.headroom === 'red') {
      concerns.push({ severity: 'critical', reason: 'Machine headroom is red.' });
    } else if (health.headroom === 'yellow') {
      concerns.push({ severity: 'warn', reason: 'Machine headroom is yellow.' });
    }
    const system = health.system;
    if (system) {
      addMetricConcern(concerns, 'CPU', system.cpuPercent, 90, 70);
      addMetricConcern(concerns, 'memory', system.memoryPercent, 90, 80);
      addMetricConcern(concerns, 'disk', system.diskPercent, 95, 85);
      const cores = health.capacity?.cpuCores;
      if (cores && system.loadAvg1 > cores * 1.5) {
        concerns.push({
          severity: 'critical',
          reason: `Load average ${system.loadAvg1} is above 1.5x ${cores} cores.`,
        });
      } else if (cores && system.loadAvg1 > cores) {
        concerns.push({
          severity: 'warn',
          reason: `Load average ${system.loadAvg1} is above ${cores} cores.`,
        });
      }
      if (system.thermalPressure === 'critical' || system.thermalPressure === 'serious') {
        concerns.push({
          severity: 'critical',
          reason: `Thermal pressure is ${system.thermalPressure}.`,
        });
      } else if (system.thermalPressure === 'fair') {
        concerns.push({ severity: 'warn', reason: 'Thermal pressure is fair.' });
      }
    }
  }

  if (byStatus.error > 0) {
    concerns.push({ severity: 'warn', reason: `${byStatus.error} resource(s) report error.` });
  }
  if (byStatus.stale > 0) {
    concerns.push({ severity: 'warn', reason: `${byStatus.stale} stale resource(s) found.` });
  }
  if (cleanupCandidates > 0) {
    concerns.push({
      severity: 'warn',
      reason: `${cleanupCandidates} idle cleanup candidate(s) available.`,
    });
  }
  const workingSlots = slots.filter((slot) => slot.agent === 'working').length;
  if (workingSlots >= 3) {
    concerns.push({
      severity: 'warn',
      reason: `${workingSlots} slots are actively working on this machine.`,
    });
  }
  return concerns;
}

function addMetricConcern(
  concerns: PressureConcern[],
  label: string,
  value: number,
  critical: number,
  warn: number,
): void {
  if (value >= critical) {
    concerns.push({ severity: 'critical', reason: `${label} usage is ${value}%.` });
  } else if (value >= warn) {
    concerns.push({ severity: 'warn', reason: `${label} usage is ${value}%.` });
  }
}

function pressureSeverity(concerns: PressureConcern[]): PressureSeverity {
  if (concerns.some((concern) => concern.severity === 'critical')) return 'critical';
  if (concerns.some((concern) => concern.severity === 'warn')) return 'warn';
  return 'ok';
}

function aggregateSeverity(machines: ResourcePressureMachine[]): PressureSeverity {
  if (machines.some((machine) => machine.severity === 'critical')) return 'critical';
  if (machines.some((machine) => machine.severity === 'warn')) return 'warn';
  return 'ok';
}
