// slot-selection.ts — operator-facing slot availability + selection core.
// TypeScript port of the scripts/find-slot.sh decision logic (Phase 4 of the
// CLI overhaul): which slots can take a task right now, and which one to
// prefer. Shared by the CLI (`farmslot fleet find-slot`) and any renderer.
//
// Dispatch-time scoring (branch affinity, host load, family identity) is a
// richer, separate core in services/gateway/src/methods/dispatch/slot-scoring.ts —
// this module answers the simpler operator question find-slot.sh answered.

import type { SlotStatus } from './slots.js';

export interface SelectSlotOptions {
  project?: string;
  /** Validate mode: check this specific slot instead of picking one. */
  slotId?: string;
  /** Prefer slots with a live CDP endpoint when any exist. */
  preferCdp?: boolean;
}

export type SelectSlotResult =
  | { ok: true; slot: SlotStatus }
  | { ok: false; reason: string; details: string[] };

/** Why a slot cannot take a new task right now; null when it can. */
export function slotUnavailableReason(slot: SlotStatus): string | null {
  if (slot.missingFromPool) return 'ghost (missing from live pools)';
  if (!slot.enabled || slot.lifecycle === 'disabled') return 'disabled';
  if (slot.lifecycle === 'manual') return 'manual mode';
  if (slot.agent === 'working') return 'agent working';
  if (slot.lifecycle !== 'ready') {
    return `lifecycle=${slot.lifecycle}${slot.phase ? ` (${slot.phase})` : ''}`;
  }
  if (!slot.dispatchable) return 'not dispatchable';
  return null;
}

export function cdpLive(slot: SlotStatus): boolean {
  return !['OFF', '-', 'FAIL', 'Other'].includes(slot.health.cdp);
}

/**
 * Preference score — lower is better. Mirrors find-slot.sh: CDP live (100),
 * device OK (5), fixtures OK (1). The bash "ready > released" criterion has
 * no gateway equivalent (only `ready` slots are selectable here).
 */
export function slotSelectionScore(slot: SlotStatus): number {
  let score = 0;
  if (!cdpLive(slot)) score += 100;
  if (!slot.health.device.endsWith(':OK')) score += 5;
  if (slot.health.fixtures !== 'OK') score += 1;
  return score;
}

export function selectSlot(slots: SlotStatus[], options: SelectSlotOptions): SelectSlotResult {
  if (options.slotId) {
    const slot = slots.find((candidate) => candidate.slot === options.slotId);
    if (!slot) {
      return { ok: false, reason: `Slot ${options.slotId} not found.`, details: [] };
    }
    const unavailable = slotUnavailableReason(slot);
    if (unavailable) {
      return {
        ok: false,
        reason: `Slot ${options.slotId} is unavailable: ${unavailable}.`,
        details: [],
      };
    }
    return { ok: true, slot };
  }

  const projectSlots = slots.filter((slot) => slot.project === options.project);
  if (projectSlots.length === 0) {
    return { ok: false, reason: `No slots found for project ${options.project}.`, details: [] };
  }
  let candidates = projectSlots.filter((slot) => slotUnavailableReason(slot) === null);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `All ${options.project} slots are occupied.`,
      details: projectSlots.map(
        (slot) => `${slot.slot}: ${slotUnavailableReason(slot) ?? 'unknown'}`,
      ),
    };
  }
  if (options.preferCdp) {
    const live = candidates.filter(cdpLive);
    if (live.length > 0) candidates = live;
  }
  const best = [...candidates].sort((a, b) => slotSelectionScore(a) - slotSelectionScore(b))[0];
  return { ok: true, slot: best };
}
