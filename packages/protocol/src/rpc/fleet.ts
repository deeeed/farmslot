import type { FleetStatus } from '../contracts/index.js';

import { Methods } from './registry.js';

export const FleetMethods = {
  status: Methods.FLEET_STATUS,
  refresh: Methods.FLEET_REFRESH,
  refreshSlots: Methods.FLEET_REFRESH_SLOTS,
  refreshSlotsCancel: Methods.FLEET_REFRESH_SLOTS_CANCEL,
  prSummary: Methods.FLEET_PR_SUMMARY,
} as const;

export interface FleetStatusParams {
  forceRefresh?: boolean;
}
export type FleetRefreshSlotStatus =
  | 'pending'
  | 'running'
  | 'refreshed'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface FleetRefreshSlotsParams {
  slots: Array<{ slotId: string; mode: 'safe' | 'force' }>;
  /** Pre-allocated bulk request id; same race-closing pattern as slot.refresh. */
  requestId?: string;
}

export interface FleetRefreshSlotsResult {
  /** Bulk request id. Subscribe to fleet.refresh.* events with this id. */
  requestId: string;
  /** Number of slots accepted into the run (after de-dup). */
  scheduled: number;
  /**
   * Map of slotId → per-slot requestId used by the underlying slot.refresh
   * call. Subscribe to script.output / script.complete with these to render
   * a per-row live log.
   */
  perSlotRequestIds: Record<string, string>;
}

export interface FleetRefreshSlotsCancelParams {
  requestId: string;
}

export interface FleetRefreshSlotsCancelResult {
  cancelled: boolean;
  /** Reason when cancelled=false (e.g. requestId not found, already complete). */
  reason?: string;
}

export interface FleetPrSummaryParams {
  slotIds: string[];
}

export interface FleetPrSummaryEntry {
  prNumber: number | null;
  /** Open / closed / merged when known; null when no PR data was available. */
  state: 'open' | 'closed' | 'merged' | null;
  repo: string | null;
}

export interface FleetPrSummaryResult {
  /** slotId → entry. Slots with no data are present with all-null fields. */
  entries: Record<string, FleetPrSummaryEntry>;
}

// Event payloads for fleet.refresh.* (emitted by FLEET_REFRESH_SLOTS).

export interface FleetRefreshScheduledEvent {
  requestId: string;
  total: number;
  perSlotRequestIds: Record<string, string>;
}

export interface FleetRefreshSlotUpdateEvent {
  requestId: string;
  slotId: string;
  status: FleetRefreshSlotStatus;
  /** Free-form context: skip reason, dirty/stale, error message, sha7. */
  detail?: string;
  /** HEAD sha (short) when status=refreshed. */
  sha?: string;
  mode?: 'safe' | 'force';
  /**
   * True when the slot was a safe-mode failure that a force-mode retry
   * could recover (dirty tree / stale branch). UI gates the inline Force
   * button on this typed flag rather than substring-matching `detail`.
   */
  recoverableViaForce?: boolean;
}

export interface FleetRefreshSummaryEvent {
  requestId: string;
  refreshed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  durationMs: number;
}
export interface FleetStatusResult {
  fleet: FleetStatus;
}
