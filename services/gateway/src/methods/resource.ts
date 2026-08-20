// methods/resource.ts — resource.list + resource.control + resource.health handlers

import {
  MachineHealth,
  ProcessOwnershipClass,
  ResourceCleanupParams,
  ResourceCleanupResult,
  ResourceControlParams,
  ResourceControlResult,
  ResourceHealthParams,
  ResourceHealthResult,
  ResourceListParams,
  ResourceListResult,
  ResourcePressureCleanupCandidate,
  ResourcePressureConcern,
  ResourcePressureMachine,
  ResourcePressureSeverity,
  ResourcePressureSnapshotParams,
  ResourcePressureSnapshotResult,
  ResourceStatus,
  ResourceWatchSetEnabledParams,
  ResourceWatchSetEnabledResult,
  selectResourcePressureGroups,
  SlotStatus,
} from '@farmslot/protocol';

import { isMissingProjectConfigError, SlotConfigError } from '../core/config.js';
import { getNode } from '../fleet/machine-registry.js';
import {
  getMachinePressureHistory,
  getMachineProcessInventory,
  getMachineProcessSamplerHealth,
} from '../fleet/node-health.js';
import {
  attributeProcessInventory,
  type ProcessAttributionResource,
} from '../fleet/process-attribution.js';
import {
  executeResourceControl,
  getActiveResources,
  getCachedResourceStatus,
  getResourceWatchRuntimeState,
  pollSlotResources,
  resolveSlotResources,
  setResourceWatchesEnabled,
} from '../fleet/resource-manager.js';
import { loadFleetStatus } from '../fleet/state.js';

const RESOURCE_STATUSES: ResourceStatus[] = ['unknown', 'running', 'stopped', 'error', 'stale'];
const PRESSURE_RESOURCE_RESOLUTION_CONCURRENCY = 4;
const PRESSURE_RESOURCE_CACHE_TTL_MS = 30_000;
const PRESSURE_RESOURCE_CACHE_MAX_SLOTS = 512;
const PROCESS_INVENTORY_MAX_AGE_MS = 7 * 60_000;
const MAX_PRESSURE_MACHINES = 32;
const MAX_PRESSURE_ATTRIBUTION_GROUPS = 32;
const MAX_PRESSURE_CLEANUP_CANDIDATES = 256;
const MAX_RESOURCE_CLEANUP_TARGETS = 256;

const EMPTY_PROCESS_CLASS_COUNTS: Record<ProcessOwnershipClass, number> = {
  active: 0,
  retained: 0,
  stale: 0,
  manual: 0,
  unknown: 0,
};
const pressureResourceCache = new Map<
  string,
  { cachedAt: number; resources: Awaited<ReturnType<typeof resolveSlotResources>> }
>();

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

/** Host-only pressure read for admission paths; never loads resources, tmux, runs, or census data. */
export async function resourceHostPressure(machine: string, project?: string) {
  const fleet = await loadFleetStatus();
  const health = fleet.machines?.find((candidate) => candidate.machine === machine);
  const slots = fleet.slots.filter(
    (slot) => slot.machine === machine && (!project || slot.project === project),
  );
  const concerns = buildPressureConcerns(
    health,
    slots,
    emptyStatusCounts(),
    0,
    getResourceWatchRuntimeState().enabled,
  );
  return {
    machine,
    online: health?.online ?? null,
    severity: pressureSeverity(concerns),
    concerns,
  };
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
  if (!dryRun && (!params.targets || params.targets.length === 0)) {
    throw new Error('live resource cleanup requires non-empty exact reviewed targets');
  }
  if ((params.targets?.length ?? 0) > MAX_RESOURCE_CLEANUP_TARGETS) {
    throw new Error(`resource cleanup accepts at most ${MAX_RESOURCE_CLEANUP_TARGETS} targets`);
  }
  if (
    dryRun &&
    (explicitEmptyFilter(params.machine, params.machines) ||
      explicitEmptyFilter(params.project, params.projects))
  ) {
    return {
      ok: true,
      dryRun: true,
      targets: [],
      omittedTargets: 0,
      stopped: 0,
      failed: 0,
    };
  }
  const machineFilter = combinedFilter(params.machine, params.machines);
  const projectFilter = combinedFilter(params.project, params.projects);
  const machineFilterPresent = params.machine !== undefined || params.machines !== undefined;
  const projectFilterPresent = params.project !== undefined || params.projects !== undefined;
  const statuses = new Set(params.statuses ?? ['running', 'stale']);
  const slotFilter = new Set(params.slotIds ?? []);
  const resourceFilter = new Set(params.resourceIds ?? []);
  const exactTargets = new Set(
    (params.targets ?? []).map(
      (target) => `${target.machine}:${target.slotId}:${target.resourceId}`,
    ),
  );
  const exactTargetSlots = new Set(
    (params.targets ?? []).map((target) => `${target.machine}:${target.slotId}`),
  );
  const exactTargetsEnabled = params.targets !== undefined;
  const fleet = await loadFleetStatus();
  const slots = fleet.slots.filter((slot) => {
    if (!slot.enabled) return false;
    if (slot.lifecycle === 'disabled' || slot.lifecycle === 'manual') return false;
    if (!slotAllowsDefaultResourceCleanup(slot)) return false;
    if (machineFilterPresent && !machineFilter.has(slot.machine)) return false;
    if (projectFilterPresent && !projectFilter.has(slot.project)) return false;
    if (slotFilter.size > 0 && !slotFilter.has(slot.slot)) return false;
    if (exactTargetsEnabled && !exactTargetSlots.has(`${slot.machine}:${slot.slot}`)) {
      return false;
    }
    return true;
  });

  const targets: ResourceCleanupResult['targets'] = [];
  for (const slot of slots) {
    let resources;
    try {
      resources = await resolveSlotResources(slot.slot);
    } catch (err) {
      if (!dryRun && params.targets) {
        for (const requested of params.targets.filter(
          (target) => target.machine === slot.machine && target.slotId === slot.slot,
        )) {
          targets.push({
            slotId: requested.slotId,
            machine: requested.machine,
            project: slot.project,
            resourceId: requested.resourceId,
            label: requested.resourceId,
            status: 'unknown',
            ok: false,
            detail: `reviewed target could not be resolved: ${(err as Error).message}`,
          });
        }
        continue;
      }
      if (!isUnresolvableSlotError(err)) throw err;
      console.warn(
        `[resource] skipping cleanup preview for ${slot.slot}: ${(err as Error).message}`,
      );
      continue;
    }
    for (const resource of resources) {
      if (exactTargetsEnabled && !exactTargets.has(`${slot.machine}:${slot.slot}:${resource.id}`)) {
        continue;
      }
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

  if (!dryRun && params.targets) {
    const resolvedKeys = new Set(
      targets.map((target) => `${target.machine}:${target.slotId}:${target.resourceId}`),
    );
    for (const requested of params.targets) {
      const key = `${requested.machine}:${requested.slotId}:${requested.resourceId}`;
      if (resolvedKeys.has(key)) continue;
      const slot = fleet.slots.find(
        (candidate) =>
          candidate.machine === requested.machine && candidate.slot === requested.slotId,
      );
      targets.push({
        slotId: requested.slotId,
        machine: requested.machine,
        project: slot?.project ?? 'unknown',
        resourceId: requested.resourceId,
        label: requested.resourceId,
        status: 'unknown',
        ok: false,
        detail: slot
          ? 'reviewed target is no longer eligible for idle resource cleanup'
          : 'reviewed target slot no longer exists',
      });
    }
  }

  if (!dryRun) {
    for (const target of targets) {
      if (target.ok === false) continue;
      const result = await executeResourceControl(target.slotId, target.resourceId, 'shutdown');
      target.ok = result.ok;
      target.detail = result.detail;
    }
    const slotsToVerify = [
      ...new Set(targets.filter((target) => target.ok !== false).map((target) => target.slotId)),
    ];
    for (const slotId of slotsToVerify) {
      const statuses = await pollSlotResources(slotId);
      const statusByResource = new Map(statuses.map((status) => [status.id, status.status]));
      for (const target of targets.filter((item) => item.slotId === slotId)) {
        const afterStatus = statusByResource.get(target.resourceId);
        if (!afterStatus) {
          target.ok = false;
          target.detail = target.detail
            ? `${target.detail}; shutdown verification returned no resource status`
            : 'shutdown verification returned no resource status';
          continue;
        }
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

  const boundedTargets = dryRun ? targets.slice(0, MAX_RESOURCE_CLEANUP_TARGETS) : targets;
  const omittedTargets = Math.max(0, targets.length - boundedTargets.length);
  const stopped = dryRun ? 0 : boundedTargets.filter((target) => target.ok).length;
  const failed = dryRun ? 0 : boundedTargets.filter((target) => target.ok === false).length;
  return {
    ok: failed === 0,
    dryRun,
    targets: boundedTargets,
    omittedTargets,
    stopped,
    failed,
  };
}

export async function resourcePressureSnapshot(
  params: ResourcePressureSnapshotParams = {},
): Promise<ResourcePressureSnapshotResult> {
  const watchState = getResourceWatchRuntimeState();
  if (
    explicitEmptyFilter(params.machine, params.machines) ||
    explicitEmptyFilter(params.project, params.projects)
  ) {
    return emptyPressureSnapshot(params, watchState);
  }
  const fleet = await loadFleetStatus();
  const [{ tmuxWorkerList }, { getAllRuns }] = await Promise.all([
    import('./tmux-workers.js'),
    import('../runs/store.js'),
  ]);
  let tmuxWorkers: Awaited<ReturnType<typeof tmuxWorkerList>>['workers'] = [];
  let tmuxAttributionError: string | undefined;
  const machineFilter = combinedFilter(params.machine, params.machines);
  const projectFilter = combinedFilter(params.project, params.projects);
  try {
    tmuxWorkers = (
      await tmuxWorkerList({
        includeDisconnected: true,
        ...(machineFilter.size ? { machines: [...machineFilter] } : {}),
      })
    ).workers;
  } catch (error) {
    tmuxAttributionError = error instanceof Error ? error.message : String(error);
    console.warn(`[resource] pressure tmux attribution degraded: ${tmuxAttributionError}`);
  }
  const allRuns = getAllRuns();
  const healthByMachine = new Map((fleet.machines ?? []).map((health) => [health.machine, health]));
  const slots = fleet.slots.filter((slot) => matchesPressureFilters(slot, params));
  const resourcesBySlot = await resolvePressureResourcesForSlots(slots);
  const cleanupCandidates = pressureCleanupCandidates(slots, resourcesBySlot);
  const machineNames = new Set<string>();
  for (const slot of slots) machineNames.add(slot.machine);
  for (const health of fleet.machines ?? []) {
    if (machineFilter.size > 0 && !machineFilter.has(health.machine)) continue;
    if (projectFilter.size > 0 && !slots.some((slot) => slot.machine === health.machine)) continue;
    machineNames.add(health.machine);
  }

  const sortedMachineNames = [...machineNames].sort();
  const omittedMachines = Math.max(0, sortedMachineNames.length - MAX_PRESSURE_MACHINES);
  const machines: ResourcePressureMachine[] = [];
  const allAttributionGroups = new Map<
    string,
    ResourcePressureMachine['processAttribution']['groups']
  >();
  for (const machine of sortedMachineNames) {
    const health = healthByMachine.get(machine);
    const machineSlots = slots.filter((slot) => slot.machine === machine);
    const byStatus = emptyStatusCounts();
    for (const slot of machineSlots) {
      const resources = resourcesBySlot.get(slot.slot) ?? [];
      for (const resource of resources) byStatus[resource.status] += 1;
    }
    const machineCleanupCandidates = cleanupCandidates.filter(
      (target) => target.machine === machine,
    ).length;
    const concerns = buildPressureConcerns(
      health,
      machineSlots,
      byStatus,
      machineCleanupCandidates,
      watchState.enabled,
    );
    const latestProcessInventory = getMachineProcessInventory(machine);
    const processSampler = getMachineProcessSamplerHealth(machine);
    const processInventoryAgeMs = latestProcessInventory
      ? Date.now() - Date.parse(latestProcessInventory.collectedAt)
      : Number.POSITIVE_INFINITY;
    const processInventory =
      latestProcessInventory && processInventoryAgeMs <= PROCESS_INVENTORY_MAX_AGE_MS
        ? latestProcessInventory
        : undefined;
    const attributionResources: ProcessAttributionResource[] = machineSlots.flatMap((slot) =>
      [...(getActiveResources(slot.slot)?.entries() ?? [])].map(([resourceId, pointer]) => ({
        pid: pointer.pid,
        slotId: slot.slot,
        resourceId,
        runId: pointer.runId,
        status: getCachedResourceStatus(slot.slot, resourceId),
      })),
    );
    const scopedSlotIds = new Set(machineSlots.map((slot) => slot.slot));
    const scopedRunIds = new Set(
      machineSlots.flatMap((slot) => (slot.currentRunId ? [slot.currentRunId] : [])),
    );
    const attribution = processInventory
      ? attributeProcessInventory({
          inventory: processInventory,
          workers: tmuxWorkers.filter((worker) => {
            if (worker.ref.nodeId !== machine) return false;
            if (worker.linkedSlotId) return scopedSlotIds.has(worker.linkedSlotId);
            if (projectFilter.size === 0) return true;
            const cwd = worker.cwd;
            if (!cwd) return false;
            return machineSlots.some(
              (slot) => slot.repo && (cwd === slot.repo || cwd.startsWith(`${slot.repo}/`)),
            );
          }),
          slots: machineSlots,
          runs: allRuns.filter(
            (run) => scopedRunIds.has(run.id) || (run.slotId && scopedSlotIds.has(run.slotId)),
          ),
          resources: attributionResources,
          maxGroups: processInventory.processes.length,
        })
      : {
          groups: [],
          omittedGroups: 0,
          classCounts: { ...EMPTY_PROCESS_CLASS_COUNTS },
        };
    const boundedAttributionGroups = selectResourcePressureGroups(
      attribution.groups,
      MAX_PRESSURE_ATTRIBUTION_GROUPS,
    );
    const omittedAttributionGroups =
      attribution.omittedGroups +
      Math.max(0, attribution.groups.length - boundedAttributionGroups.length);
    allAttributionGroups.set(machine, attribution.groups);
    machines.push({
      machine,
      online: health?.online ?? null,
      headroom: health?.headroom ?? 'unknown',
      severity: pressureSeverity(concerns),
      concerns,
      ...(health?.system ? { system: health.system } : {}),
      ...(health?.capacity ? { capacity: health.capacity } : {}),
      history: getMachinePressureHistory(machine),
      processAttribution: {
        ...(tmuxAttributionError
          ? { degradedReason: `Tmux attribution unavailable: ${tmuxAttributionError}` }
          : {}),
        ...(processInventory
          ? {
              sampledAt: processInventory.collectedAt,
              generation: processInventory.generation,
              sampleId: processInventory.sampleId,
              ...(processSampler ? { sampler: processSampler } : {}),
            }
          : {
              unavailableReason: latestProcessInventory
                ? 'Last process inventory is stale; waiting for the node to refresh it.'
                : health?.online === false
                  ? 'Node is offline.'
                  : health?.system
                    ? getNode(machine)
                      ? 'Connected node has not provided a process inventory yet.'
                      : 'Local gauge fallback does not collect process inventory; connect the Farmslot node for attribution.'
                    : 'System metrics are not available yet.',
            }),
        ...(!processInventory && processSampler ? { sampler: processSampler } : {}),
        truncated: processInventory?.truncated ?? false,
        ancestryTruncated: processInventory?.ancestryTruncated ?? false,
        sampledProcesses: processInventory?.processes.length ?? 0,
        totalProcesses: processInventory?.totalProcesses ?? 0,
        maxEntries: processInventory?.maxEntries ?? 0,
        omittedGroups: omittedAttributionGroups,
        classCounts: attribution.classCounts,
        groups: boundedAttributionGroups,
      },
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
        cleanupCandidates: machineCleanupCandidates,
      },
    });
  }

  const severityOrder: Record<ResourcePressureSeverity, number> = { critical: 2, warn: 1, ok: 0 };
  const pressureScore = (machine: ResourcePressureMachine) => {
    const latest = machine.history.at(-1)?.pressure;
    return Math.max(latest?.cpu ?? 0, latest?.memory ?? 0, latest?.load1 ?? 0);
  };
  const returnedMachineSet = new Set(
    [...machines]
      .sort(
        (a, b) =>
          severityOrder[b.severity] - severityOrder[a.severity] ||
          pressureScore(b) - pressureScore(a) ||
          a.machine.localeCompare(b.machine),
      )
      .slice(0, MAX_PRESSURE_MACHINES)
      .map((machine) => machine.machine),
  );
  const returnedMachines = machines.filter((machine) => returnedMachineSet.has(machine.machine));
  const returnedCleanupCandidates = cleanupCandidates.filter((target) =>
    returnedMachineSet.has(target.machine),
  );
  const boundedCleanupCandidates = returnedCleanupCandidates.slice(
    0,
    MAX_PRESSURE_CLEANUP_CANDIDATES,
  );
  const omittedCleanupCandidates = Math.max(
    0,
    cleanupCandidates.length - boundedCleanupCandidates.length,
  );
  return {
    checkedAt: new Date().toISOString(),
    watchState,
    watchAutoStartEnabled: watchState.enabled,
    cleanupScope: 'non-active-slots-only',
    filters: params,
    summary: {
      machines: returnedMachines.length,
      omittedMachines,
      severity: aggregateSeverity(returnedMachines),
      cleanupCandidates: boundedCleanupCandidates.length,
      omittedCleanupCandidates,
      runningResources: returnedMachines.reduce((sum, m) => sum + m.resources.byStatus.running, 0),
      staleResources: returnedMachines.reduce((sum, m) => sum + m.resources.byStatus.stale, 0),
      busySlots: returnedMachines.reduce((sum, m) => sum + m.slots.busy, 0),
      workingSlots: returnedMachines.reduce((sum, m) => sum + m.slots.working, 0),
    },
    machines: returnedMachines,
    cleanupCandidates: boundedCleanupCandidates.map((target) => {
      const exactGroup = allAttributionGroups
        .get(target.machine)
        ?.find(
          (candidate) =>
            candidate.slotId === target.slotId && candidate.resourceId === target.resourceId,
        );
      return {
        ...target,
        ...(exactGroup
          ? {
              processImpact: {
                scope: 'resource' as const,
                process: exactGroup.topExecutable,
                processCount: exactGroup.processCount,
                treeCpuPercent: exactGroup.cpuPercent,
                hotRssBytes: exactGroup.topRssBytes,
                classification: exactGroup.classification,
                confidence: exactGroup.confidence,
              },
            }
          : {}),
      };
    }),
  };
}

async function resolvePressureResourcesForSlots(slots: SlotStatus[]) {
  const resources = new Map<string, Awaited<ReturnType<typeof resolvePressureSlotResources>>>();
  for (let index = 0; index < slots.length; index += PRESSURE_RESOURCE_RESOLUTION_CONCURRENCY) {
    const batch = slots.slice(index, index + PRESSURE_RESOURCE_RESOLUTION_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(
        async (slot) => [slot.slot, await resolvePressureSlotResources(slot.slot)] as const,
      ),
    );
    for (const [slotId, slotResources] of resolved) resources.set(slotId, slotResources);
  }
  return resources;
}

export interface ResourcePressureModelSnapshot {
  checkedAt: string;
  filters: ResourcePressureSnapshotParams;
  summary: ResourcePressureSnapshotResult['summary'];
  machines: Array<{
    machine: string;
    online: ResourcePressureMachine['online'];
    headroom: ResourcePressureMachine['headroom'];
    severity: ResourcePressureMachine['severity'];
    concerns: ResourcePressureMachine['concerns'];
    capacity?: ResourcePressureMachine['capacity'];
    history: ResourcePressureMachine['history'];
    slots: ResourcePressureMachine['slots'];
    resources: ResourcePressureMachine['resources'];
    processAttribution: {
      sampledAt?: string;
      unavailableReason?: string;
      degradedReason?: string;
      truncated: boolean;
      omittedGroups: number;
      classCounts: ResourcePressureMachine['processAttribution']['classCounts'];
      sampler?: Omit<
        NonNullable<ResourcePressureMachine['processAttribution']['sampler']>,
        'lastError'
      >;
      groups: Array<{
        process: string;
        processCount: number;
        cpuPercent: number;
        hotRssBytes: number;
        classification: ProcessOwnershipClass;
        confidence: ResourcePressureMachine['processAttribution']['groups'][number]['confidence'];
      }>;
    };
  }>;
}

/** Bounded privacy projection for model context; operator RPC keeps the full admin detail. */
export function resourcePressureSnapshotForModel(
  snapshot: ResourcePressureSnapshotResult,
): ResourcePressureModelSnapshot {
  const processName = (executable: string) =>
    executable.match(/\/([^/]+)\.app(?:\/|$)/)?.[1] ?? executable.split('/').at(-1) ?? 'process';
  return {
    checkedAt: snapshot.checkedAt,
    filters: snapshot.filters,
    summary: snapshot.summary,
    machines: snapshot.machines.map((machine) => {
      const sampler = machine.processAttribution.sampler;
      const safeSampler = sampler
        ? {
            attempts: sampler.attempts,
            executions: sampler.executions,
            failures: sampler.failures,
            skippedBusy: sampler.skippedBusy,
            skippedCadence: sampler.skippedCadence,
            lastDurationMs: sampler.lastDurationMs,
          }
        : undefined;
      const projectScoped =
        snapshot.filters.project !== undefined || snapshot.filters.projects !== undefined;
      const modelSourceGroups = projectScoped
        ? machine.processAttribution.groups.filter((group) => group.slotId || group.resourceId)
        : machine.processAttribution.groups;
      const modelGroups = selectResourcePressureGroups(modelSourceGroups, 8);
      return {
        machine: machine.machine,
        online: machine.online,
        headroom: machine.headroom,
        severity: machine.severity,
        concerns: machine.concerns,
        ...(machine.capacity ? { capacity: machine.capacity } : {}),
        history: machine.history.slice(-12),
        slots: machine.slots,
        resources: machine.resources,
        processAttribution: {
          ...(machine.processAttribution.sampledAt
            ? { sampledAt: machine.processAttribution.sampledAt }
            : {}),
          ...(machine.processAttribution.unavailableReason
            ? { unavailableReason: machine.processAttribution.unavailableReason }
            : {}),
          ...(machine.processAttribution.degradedReason
            ? { degradedReason: machine.processAttribution.degradedReason }
            : {}),
          truncated: machine.processAttribution.truncated,
          omittedGroups:
            machine.processAttribution.omittedGroups +
            Math.max(0, machine.processAttribution.groups.length - modelGroups.length),
          classCounts: machine.processAttribution.classCounts,
          ...(safeSampler ? { sampler: safeSampler } : {}),
          groups: modelGroups.map((group) => ({
            process: processName(group.topExecutable),
            processCount: group.processCount,
            cpuPercent: group.cpuPercent,
            hotRssBytes: group.topRssBytes,
            classification: group.classification,
            confidence: group.confidence,
          })),
        },
      };
    }),
  };
}

function pressureCleanupCandidates(
  slots: SlotStatus[],
  resourcesBySlot: Map<string, Awaited<ReturnType<typeof resolvePressureSlotResources>>>,
): ResourcePressureCleanupCandidate[] {
  const targets: ResourcePressureCleanupCandidate[] = [];
  for (const slot of slots) {
    if (!slot.enabled || slot.lifecycle === 'disabled' || slot.lifecycle === 'manual') continue;
    if (!slotAllowsDefaultResourceCleanup(slot)) continue;
    for (const resource of resourcesBySlot.get(slot.slot) ?? []) {
      if (resource.status !== 'running' && resource.status !== 'stale') continue;
      if (!resource.definition.controllable || !resource.definition.hooks?.shutdown) continue;
      targets.push({
        slotId: slot.slot,
        machine: slot.machine,
        project: slot.project,
        resourceId: resource.id,
        label: resource.definition.label,
        status: resource.status,
        slotLifecycle: slot.lifecycle,
        currentRunId: slot.currentRunId ?? null,
        effect: 'configured-shutdown-hook',
        activeWorkExcluded: true,
      });
    }
  }
  return targets;
}

// The fleet snapshot and slot-config resolution do not see the same set of
// slots: a pool file can be gated (pool/farmslot-demo.json needs
// FARMSLOT_DEMO_POOL=1), removed, or renamed after the snapshot was written, and
// a slot can be listed without a resolvable project config. A read-only
// whole-fleet aggregation must report on the slots it can resolve rather than
// failing outright because one of N is unresolvable — otherwise a single
// unreadable slot blanks the entire pressure snapshot.
export function isUnresolvableSlotError(err: unknown): boolean {
  if (isMissingProjectConfigError(err)) return true;
  return err instanceof SlotConfigError && err.code === 'SLOT_NOT_FOUND';
}

export async function resolvePressureSlotResources(slotId: string) {
  const now = Date.now();
  for (const [cachedSlotId, entry] of pressureResourceCache) {
    if (now - entry.cachedAt >= PRESSURE_RESOURCE_CACHE_TTL_MS) {
      pressureResourceCache.delete(cachedSlotId);
    }
  }
  const cached = pressureResourceCache.get(slotId);
  if (cached) {
    return cached.resources.map((resource) => ({
      ...resource,
      status: getCachedResourceStatus(slotId, resource.id),
    }));
  }
  try {
    const resources = await resolveSlotResources(slotId);
    if (
      !pressureResourceCache.has(slotId) &&
      pressureResourceCache.size >= PRESSURE_RESOURCE_CACHE_MAX_SLOTS
    ) {
      const oldest = [...pressureResourceCache.entries()].sort(
        ([, a], [, b]) => a.cachedAt - b.cachedAt,
      )[0]?.[0];
      if (oldest) pressureResourceCache.delete(oldest);
    }
    pressureResourceCache.set(slotId, { cachedAt: now, resources });
    return resources;
  } catch (err) {
    if (!isUnresolvableSlotError(err)) throw err;
    console.warn(`[resource] skipping pressure resources for ${slotId}: ${(err as Error).message}`);
    return [];
  }
}

function matchesPressureFilters(slot: SlotStatus, params: ResourcePressureSnapshotParams): boolean {
  const machines = combinedFilter(params.machine, params.machines);
  const projects = combinedFilter(params.project, params.projects);
  if (
    (params.machine !== undefined || params.machines !== undefined) &&
    !machines.has(slot.machine)
  )
    return false;
  if (
    (params.project !== undefined || params.projects !== undefined) &&
    !projects.has(slot.project)
  )
    return false;
  return true;
}

/** Singular and plural selectors are one union so mixed-version clients cannot self-conflict. */
function combinedFilter(primary?: string, values?: string[]): Set<string> {
  return new Set([...(primary ? [primary] : []), ...(values ?? [])]);
}

function explicitEmptyFilter(primary?: string, values?: string[]): boolean {
  return !primary && values !== undefined && values.length === 0;
}

function emptyPressureSnapshot(
  filters: ResourcePressureSnapshotParams,
  watchState: { enabled: boolean; updatedAt: string | null },
): ResourcePressureSnapshotResult {
  return {
    checkedAt: new Date().toISOString(),
    watchState,
    watchAutoStartEnabled: watchState.enabled,
    cleanupScope: 'non-active-slots-only',
    filters,
    summary: {
      machines: 0,
      omittedMachines: 0,
      severity: 'ok',
      cleanupCandidates: 0,
      omittedCleanupCandidates: 0,
      runningResources: 0,
      staleResources: 0,
      busySlots: 0,
      workingSlots: 0,
    },
    machines: [],
    cleanupCandidates: [],
  };
}

export function slotAllowsDefaultResourceCleanup(
  slot: Pick<SlotStatus, 'agent' | 'currentRunId' | 'lifecycle'>,
): boolean {
  if (slot.lifecycle === 'busy' || slot.lifecycle === 'held') return false;
  if (slot.agent === 'working') return false;
  return !slot.currentRunId;
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
): ResourcePressureConcern[] {
  const concerns: ResourcePressureConcern[] = [];
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
    if (!system) {
      concerns.push({ severity: 'warn', reason: 'No system metrics available yet.' });
    } else {
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
  concerns: ResourcePressureConcern[],
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

function pressureSeverity(concerns: ResourcePressureConcern[]): ResourcePressureSeverity {
  if (concerns.some((concern) => concern.severity === 'critical')) return 'critical';
  if (concerns.some((concern) => concern.severity === 'warn')) return 'warn';
  return 'ok';
}

function aggregateSeverity(machines: ResourcePressureMachine[]): ResourcePressureSeverity {
  if (machines.some((machine) => machine.severity === 'critical')) return 'critical';
  if (machines.some((machine) => machine.severity === 'warn')) return 'warn';
  return 'ok';
}
