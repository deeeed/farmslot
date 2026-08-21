import type { OkResult } from '../contracts/index.js';

import { Methods } from './registry.js';

export const ResourceMethods = {
  list: Methods.RESOURCE_LIST,
  control: Methods.RESOURCE_CONTROL,
  health: Methods.RESOURCE_HEALTH,
  cleanup: Methods.RESOURCE_CLEANUP,
  watchSetEnabled: Methods.RESOURCE_WATCH_SET_ENABLED,
  pressureSnapshot: Methods.RESOURCE_PRESSURE_SNAPSHOT,
  pressureHistory: Methods.RESOURCE_PRESSURE_HISTORY,
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
  machine?: string;
  machines?: string[];
  project?: string;
  projects?: string[];
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
  omittedTargets: number;
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

/** Shared default freshness window for the pressure ring: a newest sample
 * older than this counts as stale, both here and for dispatch admission. */
export const DEFAULT_PRESSURE_STALE_AFTER_MS = 150_000;

/** Freshness of a machine's bounded pressure history. `restored` means the
 * ring was rehydrated from the gateway's persisted store after a restart and
 * no live sample has arrived yet this boot; consumers get the history
 * immediately instead of waiting for three live 30s samples, with staleness
 * stated explicitly. `none` means the machine has no samples at all. */
export interface NodePressureHistoryFreshness {
  source: 'live' | 'restored' | 'none';
  latestSampleAt: string | null;
  ageMs: number | null;
  /** True when the newest sample is older than the admission staleness window. */
  stale: boolean;
}

// ─── Lightweight history-only read ───
//
// `resource.pressure.snapshot` resolves slot resources and process/tmux
// attribution before returning, so it cannot be the first paint after a
// gateway restart. `resource.pressure.history` reads ONLY the in-memory
// (possibly rehydrated) rings plus freshness and returns immediately; clients
// render charts from it first and load the full snapshot in the background.
// This is deliberately its own contract, not a partial snapshot shape.

export interface ResourcePressureHistoryParams {
  machine?: string;
  machines?: string[];
}

export interface ResourcePressureHistoryMachine {
  machine: string;
  online: boolean | null;
  history: NodePressureHistorySample[];
  historyFreshness: NodePressureHistoryFreshness;
}

export interface ResourcePressureHistoryResult {
  checkedAt: string;
  machines: ResourcePressureHistoryMachine[];
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

export interface ResourcePressureSnapshotParams {
  machine?: string;
  machines?: string[];
  project?: string;
  projects?: string[];
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
  historyFreshness?: NodePressureHistoryFreshness;
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
    managedGroupCount: number;
    managedClassCounts: Record<ProcessOwnershipClass, number>;
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
    scope: 'resource';
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
    omittedMachines: number;
    severity: ResourcePressureSeverity;
    cleanupCandidates: number;
    omittedCleanupCandidates: number;
    runningResources: number;
    staleResources: number;
    busySlots: number;
    workingSlots: number;
  };
  machines: ResourcePressureMachine[];
  cleanupCandidates: ResourcePressureCleanupCandidate[];
}
