import type { OkResult } from '../contracts/index.js';

import { Methods } from './registry.js';

export const ResourceMethods = {
  list: Methods.RESOURCE_LIST,
  control: Methods.RESOURCE_CONTROL,
  health: Methods.RESOURCE_HEALTH,
  cleanup: Methods.RESOURCE_CLEANUP,
  watchSetEnabled: Methods.RESOURCE_WATCH_SET_ENABLED,
  pressureSnapshot: Methods.RESOURCE_PRESSURE_SNAPSHOT,
  streamSubscribe: Methods.STREAM_SUBSCRIBE,
  streamUnsubscribe: Methods.STREAM_UNSUBSCRIBE,
  streamSnapshot: Methods.STREAM_SNAPSHOT,
  screenSubscribe: Methods.SCREEN_SUBSCRIBE,
  screenUnsubscribe: Methods.SCREEN_UNSUBSCRIBE,
  screenThumbnail: Methods.SCREEN_THUMBNAIL,
} as const;

// ─── Node Health param/result types ───

export interface NodeHealthParams {
  machine: string;
}

export interface NodeHealthResult {
  health: import('../contracts/index.js').MachineHealth;
}

export interface NodeHealthAllResult {
  machines: import('../contracts/index.js').MachineHealth[];
}

// ─── Screen Thumbnail param/result types ───

export interface ScreenThumbnailParams {
  slotId: string;
  platform?: string;
  maxWidth?: number;
}

export interface ScreenThumbnailResult {
  data: string; // base64 PNG
  width: number;
  height: number;
  timestamp: number;
}

export interface StreamSubscribeParams {
  slotId: string;
  platform?: string;
  resourceId?: string;
  maxFps?: number;
  maxWidth?: number;
}

export type StreamSubscribeResult = OkResult & { resourceIndex?: number };

export interface StreamUnsubscribeParams {
  slotId: string;
  platform?: string;
  resourceId?: string;
}

export interface StreamSnapshotParams {
  slotId: string;
}

export interface StreamSnapshotResult {
  data: string; // base64 PNG
}
export interface ScreenSubscribeParams {
  slotId: string;
  platform: string;
  maxFps?: number;
  maxSize?: number;
  iosWindowName?: string;
  androidSerial?: string;
  browserPid?: number;
}

export interface ScreenUnsubscribeParams {
  slotId: string;
}
export interface ResourceListParams {
  slotId: string;
}

export interface ResourceListResult {
  resources: import('../contracts/index.js').SlotResource[];
}

export type ResourceControlAction = 'boot' | 'shutdown' | 'relaunch';

export interface ResourceControlParams {
  slotId: string;
  resourceId: string;
  action: ResourceControlAction;
}

export interface ResourceControlResult {
  ok: boolean;
  detail?: string;
}

export interface ResourceHealthParams {
  slotId: string;
}

export interface ResourceHealthResult {
  slotId: string;
  resources: import('../contracts/index.js').ResourceStateUpdate[];
}

export interface ResourceCleanupParams {
  dryRun?: boolean;
  includeBusy?: boolean;
  machine?: string;
  project?: string;
  slotIds?: string[];
  resourceIds?: string[];
  /** Exact reviewed targets. Required when dryRun=false; cleanup cannot widen beyond these triples. */
  targets?: Array<{ machine: string; slotId: string; resourceId: string }>;
  statuses?: import('../contracts/index.js').ResourceStatus[];
}

export interface ResourceCleanupTarget {
  slotId: string;
  machine: string;
  project: string;
  resourceId: string;
  label: string;
  status: import('../contracts/index.js').ResourceStatus;
  afterStatus?: import('../contracts/index.js').ResourceStatus;
  ok?: boolean;
  detail?: string;
}

export interface ResourceCleanupResult {
  ok: boolean;
  dryRun: boolean;
  targets: ResourceCleanupTarget[];
  stopped: number;
  failed: number;
}

export interface ResourceWatchSetEnabledParams {
  enabled: boolean;
}

export interface ResourceWatchSetEnabledResult {
  ok: boolean;
  enabled: boolean;
  affectedMachines: string[];
  affectedSlots: string[];
  detail?: string;
}

export type ResourcePressureSeverity = 'ok' | 'warn' | 'critical';
export type ProcessOwnershipClass = 'active' | 'retained' | 'stale' | 'manual' | 'unknown';
export type ProcessAttributionConfidence = 'high' | 'medium' | 'low';

export interface NodePressureHistorySample {
  generation?: string;
  sampleId?: number;
  collectedAt: string;
  pressure: import('../contracts/index.js').NodePressureRatios;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  loadAvg1: number;
  loadAvg5: number;
}

export interface ProcessAttributionGroup {
  rootPid: number;
  processCount: number;
  executable: string;
  topPid: number;
  topExecutable: string;
  topCpuPercent: number;
  topRssBytes: number;
  cpuPercent: number;
  rssBytes: number;
  classification: ProcessOwnershipClass;
  confidence: ProcessAttributionConfidence;
  evidence: string[];
  slotId?: string;
  runId?: string;
  resourceId?: string;
  tmuxTarget?: string;
}

export function selectResourcePressureGroups(
  groups: ProcessAttributionGroup[],
  limit: number,
): ProcessAttributionGroup[] {
  if (limit <= 0) return [];
  const hottest = groups[0] ? [groups[0]] : [];
  const managedCandidates = groups.filter(
    (group) =>
      !hottest.includes(group) && ['active', 'retained', 'stale'].includes(group.classification),
  );
  const managed = managedCandidates.slice(0, Math.max(0, limit - hottest.length));
  const pinned = [...hottest, ...managed];
  return [
    ...groups
      .filter((group) => !pinned.includes(group))
      .slice(0, Math.max(0, limit - pinned.length)),
    ...pinned,
  ].sort((a, b) => groups.indexOf(a) - groups.indexOf(b));
}

export interface ResourcePressureSnapshotParams {
  machine?: string;
  project?: string;
}

export interface ResourcePressureConcern {
  severity: Exclude<ResourcePressureSeverity, 'ok'>;
  reason: string;
}

export interface ResourcePressureMachine {
  machine: string;
  online: boolean | null;
  headroom: import('../contracts/index.js').MachineHealth['headroom'] | 'unknown';
  severity: ResourcePressureSeverity;
  concerns: ResourcePressureConcern[];
  system?: import('../contracts/index.js').MachineHealth['system'];
  capacity?: import('../contracts/index.js').MachineHealth['capacity'];
  history: NodePressureHistorySample[];
  processAttribution: {
    sampledAt?: string;
    unavailableReason?: string;
    degradedReason?: string;
    generation?: string;
    sampleId?: number;
    truncated: boolean;
    ancestryTruncated: boolean;
    sampledProcesses: number;
    totalProcesses: number;
    maxEntries: number;
    omittedGroups: number;
    classCounts: Record<ProcessOwnershipClass, number>;
    groups: ProcessAttributionGroup[];
    sampler?: import('../contracts/index.js').NodeProcessSamplerHealth;
  };
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
    byStatus: Record<import('../contracts/index.js').ResourceStatus, number>;
    cleanupCandidates: number;
  };
}

export interface ResourcePressureCleanupCandidate extends ResourceCleanupTarget {
  slotLifecycle: import('../contracts/index.js').SlotLifecycle;
  currentRunId: string | null;
  effect: 'configured-shutdown-hook';
  activeWorkExcluded: true;
  processImpact?: {
    scope: 'resource' | 'slot-related';
    process: string;
    processCount: number;
    treeCpuPercent: number;
    hotRssBytes: number;
    classification: ProcessOwnershipClass;
    confidence: ProcessAttributionConfidence;
  };
}

export interface ResourcePressureSnapshotResult {
  checkedAt: string;
  watchState: { enabled: boolean; updatedAt: string | null };
  watchAutoStartEnabled: boolean;
  cleanupScope: 'non-active-slots-only';
  filters: ResourcePressureSnapshotParams;
  summary: {
    machines: number;
    severity: ResourcePressureSeverity;
    cleanupCandidates: number;
    runningResources: number;
    staleResources: number;
    busySlots: number;
    workingSlots: number;
  };
  machines: ResourcePressureMachine[];
  cleanupCandidates: ResourcePressureCleanupCandidate[];
}
