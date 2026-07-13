import type { RecipeRuntimeCapabilityDeclaration } from '../recipe/common.js';

import type { AgentContextSummary, SlotAgent } from './agents.js';
import type { ResourceRollup } from './resources.js';
import type { RunLane } from './runs.js';

export type SlotLifecycle =
  | 'ready' // Idle, dispatchable.
  | 'busy' // Gateway or worker actively using this slot.
  | 'held' // Worker done, slot reserved for PR (affinity, CI monitoring).
  | 'manual' // Human working on slot — blocks dispatch, easy UI toggle to release.
  | 'disabled'; // Offline or excluded from all operations.

// Sub-state detail for UI display. Not used for dispatch logic.
export type SlotPhase =
  | 'preparing' // busy: Gateway running prepare-slot.sh
  | 'dispatching' // busy: Gateway launching worker agent
  | 'working' // busy: Worker agent executing TASK.md
  | 'releasing' // busy: Gateway cleaning up
  | 'review-gate' // busy: Blocked on human decision
  | 'ci-watch' // held: Monitoring CI status
  | 'pr-watch' // held: Waiting for PR events (merge, review)
  | null; // ready/manual/disabled — no active phase
export type PoolSlotMode = 'dispatch' | 'custom' | 'disabled';

/**
 * Slot-lifecycle operations that run destructive git (`reset --hard` / `clean
 * -fd`) on a slot's repo. Used to label the operator-root safety guard so the
 * operation name is a typed constant, not a free-form string at each call site.
 */
export const SLOT_DESTRUCTIVE_OPS = {
  idleReset: 'idle-reset',
  refresh: 'refresh',
  prepare: 'prepare',
  release: 'release',
} as const;
export type SlotDestructiveOp = (typeof SLOT_DESTRUCTIVE_OPS)[keyof typeof SLOT_DESTRUCTIVE_OPS];

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface SlotHealth {
  ssh: string; // LOCAL | OK | FAIL
  device: string; // emu:OK | sim:OK | emu:OFF | -
  devserver: string; // OK | OFF | -
  cdp: string; // Wallet | OFF | FAIL | -
  fixtures: string; // OK | 2/3 | -
}

export interface SlotStatus {
  slot: string;
  machine: string;
  platform: string;
  project: string;
  health: SlotHealth;
  branch: string;
  /** Pool tmux/session id — used to resolve slot_tracking_branch templates. */
  session?: string;
  /** Slot checkout path from pool config. */
  repo?: string;
  /** True when the slot repo is a linked git worktree (.git file), probed at fleet refresh. */
  linkedWorktree?: boolean;
  agent: SlotAgent;
  enabled: boolean;
  dispatchable: boolean;
  /** True when this slot id no longer resolves in live pool JSONs — a status-file ghost. Never prepare/dispatch it. */
  missingFromPool?: boolean;
  lifecycle: SlotLifecycle;
  phase: SlotPhase;
  warm: boolean;
  taskId: string | null;
  taskFile: string | null;
  currentRunId?: string | null;
  currentFlowType?: string | null;
  currentTicketOrPr?: string | null;
  currentMode?: string | null;
  currentFamilyId?: string | null;
  currentLane?: RunLane | null;
  currentVariant?: string | null;
  activeTaskFile?: string; // currently active task md (TASK.md, SELF-REVIEW.md, SELF-REVIEW-FIX.md)
  agentContexts?: AgentContextSummary[];
  dispatchedAt: string | null;
  completedAt: string | null;
  runner: string | null; // claude | codex | cursor | grok | opencode | custom
  model: string | null; // sonnet | opus | haiku | gpt-5.5 | composer-2.5 | grok-4.5-fast-xhigh | grok-build | custom
  resources?: Record<string, Record<string, string | number | boolean>>;
  deviceName: string | null;
  taskPhase: string | null; // e.g. "Validate 5/7"
  taskStepProgress: number | null; // 0.0-1.0
  hostLoad?: { cpuPercent: number; memoryPercent: number; diskPercent: number; headroom: string };
  /** Composite coherence verdict across all watched resources. Computed by gateway in fleet-state builder. */
  resourceRollup?: ResourceRollup;
  /** PR health for held slots (populated by CI monitor) */
  prHealth?: {
    pr: number;
    conflict: boolean;
    ciPassed: number;
    ciFailed: number;
    ciPending: number;
    ciTotal: number;
    updatedAt: string;
  };
}

export interface FleetSummary {
  total: number;
  ready: number;
  busy: number;
  held: number;
  manual: number;
  disabled: number;
  blocked: number; // ready but health != ok
  warmCount: number; // ready slots with warm build
}

export interface FleetStatus {
  checkedAt: string;
  slots: SlotStatus[];
  summary: FleetSummary;
  machines?: MachineHealth[];
  /**
   * True when checkedAt is older than the gateway freshness threshold. Consumers
   * must not surface prepare/dispatch suggestions from a stale fleet snapshot.
   */
  stale?: boolean;
}

// Slot contracts include resource/action shapes used by slot UI and gateway actions.
export type {
  ActiveResourcePointer,
  SlotActionDefinition,
  SlotActionMode,
  SlotActionPlacement,
  SlotActionRefreshTarget,
  SlotActionStyle,
  SlotActionSummary,
  SlotResource,
} from './resources.js';
export type { SlotRunHistoryEntry } from './runs.js';

// ─── Node Health ───

export type ThermalPressure = 'nominal' | 'fair' | 'serious' | 'critical';
export type Headroom = 'green' | 'yellow' | 'red';

export interface NodeSystemMetrics {
  cpuPercent: number; // 0-100
  memoryPercent: number; // 0-100
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskPercent: number; // 0-100
  loadAvg1: number;
  loadAvg5: number;
  thermalPressure?: ThermalPressure; // macOS only
  collectedAt: string;
}

export interface MachineHealth {
  machine: string;
  online: boolean;
  capabilities?: RecipeRuntimeCapabilityDeclaration[];
  system?: NodeSystemMetrics;
  capacity?: { maxSlots: number; activeSlots: number; cpuCores: number };
  headroom: Headroom;
}
