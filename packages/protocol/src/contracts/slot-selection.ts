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
}

export type SelectSlotFailureCode =
  | 'SLOT_NOT_FOUND'
  | 'SLOT_UNAVAILABLE'
  | 'PROJECT_NOT_FOUND'
  | 'NO_SLOT_AVAILABLE';

export type SelectSlotResult =
  | { ok: true; slot: SlotStatus }
  | { ok: false; code: SelectSlotFailureCode; reason: string; details: string[] };

/**
 * Why a slot cannot take a NEW task right now; null when it can. Mirrors the
 * gateway dispatch gate (`isFreeSlot`): degraded health (device/CDP/fixtures)
 * is a scoring concern, not an availability blocker — prepare rebuilds those.
 */
export function slotUnavailableReason(slot: SlotStatus): string | null {
  if (slot.missingFromPool) return 'ghost (missing from live pools)';
  if (!slot.enabled || slot.lifecycle === 'disabled') return 'disabled';
  if (slot.lifecycle === 'manual') return 'manual mode';
  if (slot.agent === 'working') return 'agent working';
  if (slot.lifecycle !== 'ready') {
    return `lifecycle=${slot.lifecycle}${slot.phase ? ` (${slot.phase})` : ''}`;
  }
  return null;
}

/**
 * Why an EXPLICITLY named slot cannot be used; null when it can. Broader than
 * auto-selection: a held slot may be reused on purpose (PR affinity), matching
 * find-slot.sh validate mode and the gateway's `validateSlot`.
 */
export function explicitSlotBlocker(slot: SlotStatus): string | null {
  if (slot.missingFromPool) return 'ghost (missing from live pools)';
  if (!slot.enabled || slot.lifecycle === 'disabled') return 'disabled';
  if (slot.lifecycle === 'manual') return 'manual mode';
  if (slot.agent === 'working') return 'agent working';
  if (slot.lifecycle === 'busy') return `busy${slot.phase ? ` (${slot.phase})` : ''}`;
  return null;
}

/** Shared CDP-liveness check for raw health values (gateway + operator cores). */
export function isCdpLiveValue(cdp: string): boolean {
  return !['OFF', '-', 'FAIL', 'Other'].includes(cdp);
}

export function cdpLive(slot: SlotStatus): boolean {
  return isCdpLiveValue(slot.health.cdp);
}

/**
 * Preference score — lower is better. Mirrors find-slot.sh: CDP live (100),
 * warm build (10 — the bash "ready > released" criterion; the gateway maps
 * `released` to `lifecycle: ready, warm: false`), device OK (5), fixtures
 * OK (1). CDP dominates by construction, so no separate prefer-CDP filter
 * is needed.
 */
export function slotSelectionScore(slot: SlotStatus): number {
  let score = 0;
  if (!cdpLive(slot)) score += 100;
  if (!slot.warm) score += 10;
  if (!slot.health.device.endsWith(':OK')) score += 5;
  if (slot.health.fixtures !== 'OK') score += 1;
  return score;
}

export function selectSlot(slots: SlotStatus[], options: SelectSlotOptions): SelectSlotResult {
  if (options.slotId) {
    const slot = slots.find((candidate) => candidate.slot === options.slotId);
    if (!slot) {
      return {
        ok: false,
        code: 'SLOT_NOT_FOUND',
        reason: `Slot ${options.slotId} not found.`,
        details: [],
      };
    }
    const blocker = explicitSlotBlocker(slot);
    if (blocker) {
      return {
        ok: false,
        code: 'SLOT_UNAVAILABLE',
        reason: `Slot ${options.slotId} is unavailable: ${blocker}.`,
        details: [],
      };
    }
    return { ok: true, slot };
  }

  const projectSlots = slots.filter((slot) => slot.project === options.project);
  if (projectSlots.length === 0) {
    return {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      reason: `No slots found for project ${options.project}.`,
      details: [],
    };
  }
  const candidates = projectSlots.filter((slot) => slotUnavailableReason(slot) === null);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'NO_SLOT_AVAILABLE',
      reason: `All ${options.project} slots are occupied.`,
      details: projectSlots.map(
        (slot) => `${slot.slot}: ${slotUnavailableReason(slot) ?? 'unknown'}`,
      ),
    };
  }
  const best = [...candidates].sort((a, b) => slotSelectionScore(a) - slotSelectionScore(b))[0];
  return { ok: true, slot: best };
}
