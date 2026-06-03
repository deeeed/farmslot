import type { SlotStatus } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getState } from '../../state.js';

import type { SlotView } from './slot-view.js';
import {
  adjacentSlotId,
  slotSwitcherEntries,
  type SlotSwitcherEntry,
  slotSwitcherSignature,
} from './slot-view-model.js';
import { slotViewHash } from './slot-view-url-state.js';

export function handleSlotViewBack(view: SlotView) {
  view.dispatchEvent(new CustomEvent('slot-back', { bubbles: true, composed: true }));
}

export function slotViewSwitcherEntries(view: SlotView): SlotSwitcherEntry[] {
  return slotSwitcherEntries(getState().fleet?.slots ?? [], view.slotId);
}

export function requestSlotViewSwitcherUpdate(view: SlotView, slots: readonly SlotStatus[]) {
  const nextSignature = slotSwitcherSignature(slots);
  if (nextSignature === view._slotSwitcherSignature) return;
  view._slotSwitcherSignature = nextSignature;
  view.requestUpdate();
}

export function hasSlotViewModalOpen(view: SlotView): boolean {
  return (
    view._historyOpen ||
    view._recipeExecutionOpen ||
    view._recipeLightboxOpen ||
    view._newFilePrompt ||
    document.querySelector('[aria-modal="true"]') !== null
  );
}

export function switchSlotViewSlot(view: SlotView, nextSlotId: string) {
  if (!nextSlotId || nextSlotId === view.slotId || hasSlotViewModalOpen(view)) return;
  // Switching slots intentionally starts a fresh slot-view URL so per-slot
  // file/history/recipe params from the previous workspace do not leak.
  location.hash = slotViewHash({ slotId: nextSlotId });
}

export function switchSlotViewRelativeSlot(view: SlotView, direction: -1 | 1) {
  const nextSlotId = adjacentSlotId(view._slotSwitcherEntries(), view.slotId, direction);
  view._switchSlot(nextSlotId);
}

export async function toggleSlotViewManualMode(view: SlotView, toManual: boolean) {
  if (!view.slotId || view._manualToggling || view._isRecoveryBlocked) return;
  view._manualToggling = true;
  try {
    await gateway.request(Methods.CONFIG_SLOT_UPDATE, {
      slotId: view.slotId,
      update: { mode: toManual ? 'custom' : 'dispatch', enabled: true },
    });
  } catch (err) {
    console.error('[slot-view] toggle manual failed:', err);
  } finally {
    view._manualToggling = false;
  }
}

export async function pauseSlotViewRun(view: SlotView) {
  if (!view._linkedRun || view._isRecoveryBlocked) return;
  try {
    await gateway.request(Methods.RUN_PAUSE, { runId: view._linkedRun.id });
  } catch (err) {
    console.error('[slot-view] pause failed:', err);
  }
}

export async function resumeSlotViewRun(view: SlotView) {
  if (!view._linkedRun || view._isRecoveryBlocked) return;
  try {
    await gateway.request(Methods.RUN_RESUME, { runId: view._linkedRun.id });
  } catch (err) {
    console.error('[slot-view] resume failed:', err);
  }
}

export function toggleSlotViewSidebar(view: SlotView) {
  view._sidebarOpen = !view._sidebarOpen;
  view._saveLayout();
}

export function setSlotViewActivity(view: SlotView, activity: typeof view._activity) {
  if (view._activity === activity && view._sidebarOpen) {
    // Clicking active tab toggles sidebar closed.
    view._sidebarOpen = false;
  } else {
    view._activity = activity;
    view._sidebarOpen = true;
  }
  view._saveLayout();
}

export function toggleSlotViewSection(view: SlotView, name: string) {
  view._sections = { ...view._sections, [name]: !view._sections[name] };
  view._saveLayout();
}

export async function replaySlotViewRunStep(
  view: SlotView,
  stepName: string,
  skipPrepare?: boolean,
) {
  if (!view._linkedRun || view._isRecoveryBlocked) return;
  try {
    await gateway.request(Methods.RUN_REPLAY_STEP, {
      runId: view._linkedRun.id,
      stepName,
      skipPrepare: skipPrepare || undefined,
    });
    view._runPanelSelectedStep = null;
  } catch (err) {
    console.error('Replay step failed:', err);
  }
}
