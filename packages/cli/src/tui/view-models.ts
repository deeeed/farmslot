// view-models.ts — pure mappings from protocol results to render props.
// Shared by the Ink TUI (and future formatters); no I/O, no React, no color.

import type { BacklogItem, FleetStatus, Run, SlotStatus } from '@farmslot/protocol';

export interface FleetRow {
  slot: string;
  machine: string;
  lifecycle: string;
  agent: string;
  branch: string;
  dispatchable: boolean;
  ghost: boolean;
  task: string;
}

export interface FleetViewModel {
  checkedAt: string;
  stale: boolean;
  rows: FleetRow[];
  summary: string;
}

export function fleetViewModel(fleet: FleetStatus): FleetViewModel {
  const rows = fleet.slots
    .filter((slot) => slot.lifecycle !== 'disabled')
    .map((slot: SlotStatus) => ({
      slot: slot.slot,
      machine: slot.machine,
      lifecycle: slot.lifecycle,
      agent: slot.agent,
      branch: slot.branch || '-',
      dispatchable: slot.dispatchable && !slot.missingFromPool,
      ghost: slot.missingFromPool === true,
      task: slot.taskId ?? '-',
    }));
  const s = fleet.summary;
  return {
    checkedAt: fleet.checkedAt,
    stale: fleet.stale === true,
    rows,
    summary: `ready ${s.ready} · busy ${s.busy} · held ${s.held} · blocked ${s.blocked}`,
  };
}

export interface BacklogRow {
  ref: string;
  itemId: string;
  status: string;
  priority: string;
  project: string;
  title: string;
  /** Actions the operator loop allows from this status. */
  canDispatch: boolean;
  canCloseShipped: boolean;
}

export function backlogViewModel(items: BacklogItem[]): BacklogRow[] {
  return [...items]
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((item) => ({
      ref: item.sourceRef ?? item.id.slice(0, 8),
      itemId: item.id,
      status: item.status,
      priority: String(item.priority ?? '-'),
      project: item.project,
      title: item.title,
      canDispatch: item.status === 'candidate' || item.status === 'ready',
      canCloseShipped: item.status !== 'done' && item.status !== 'archived',
    }));
}

export interface RunRow {
  id: string;
  shortId: string;
  status: string;
  flowType: string;
  ticket: string;
  slot: string;
  pendingDecisions: Array<{ id: string; title: string; actions: string[] }>;
}

export function runsViewModel(runs: Run[]): RunRow[] {
  return runs.map((run) => ({
    id: run.id,
    shortId: run.id.slice(0, 8),
    status: run.status,
    flowType: run.flowType,
    ticket: run.ticketOrPr ?? '-',
    slot: run.slotId ?? '-',
    pendingDecisions: (run.decisions ?? [])
      .filter((decision) => !decision.resolvedAt)
      .map((decision) => ({
        id: decision.id,
        title: decision.title ?? decision.type,
        actions: (decision.actions ?? []).map((action) => action.id),
      })),
  }));
}

export interface RecoveryDiagnosis {
  kind: 'empty-pool' | 'stale-status' | 'ghost-slots' | 'healthy';
  message: string;
  nextCommands: string[];
}

/** Recovery wizard diagnosis for the incident classes Phase 0 made honest. */
export function diagnoseFleet(fleet: FleetStatus): RecoveryDiagnosis {
  const live = fleet.slots.filter((slot) => !slot.missingFromPool);
  if (fleet.slots.length === 0 || live.length === 0) {
    return {
      kind: 'empty-pool',
      message:
        fleet.slots.length === 0
          ? 'No slots are configured in any pool.'
          : 'Every slot in the status file is missing from live pools.',
      nextCommands: ['farmslot project add <pack>', 'farmslot fleet refresh', 'farmslot doctor'],
    };
  }
  if (fleet.stale) {
    return {
      kind: 'stale-status',
      message: `Fleet snapshot is stale (checked ${fleet.checkedAt}). A re-probe is running.`,
      nextCommands: ['farmslot fleet status --force-refresh'],
    };
  }
  const ghosts = fleet.slots.filter((slot) => slot.missingFromPool);
  if (ghosts.length > 0) {
    return {
      kind: 'ghost-slots',
      message: `${ghosts.length} status-file slot(s) no longer exist in live pools: ${ghosts
        .map((slot) => slot.slot)
        .join(', ')}.`,
      nextCommands: ['farmslot fleet refresh', 'farmslot doctor'],
    };
  }
  return { kind: 'healthy', message: 'Fleet is healthy.', nextCommands: [] };
}
