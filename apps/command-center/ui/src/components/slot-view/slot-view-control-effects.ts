import type { SlotStatus, TmuxWorkerRestoreResult } from '@farmslot/protocol';
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
  if (!view._linkedRun || view._runActionsBlocked) return;
  let current = () => view.isConnected;
  view._runCommandError = '';
  try {
    const run = view._requireCurrentRun();
    current = view._captureRunScope();
    await gateway.request(Methods.RUN_PAUSE, { runId: run.id });
  } catch (error) {
    if (current()) view._runCommandError = error instanceof Error ? error.message : String(error);
  }
}

export async function resumeSlotViewRun(view: SlotView) {
  if (!view._linkedRun || view._runActionsBlocked) return;
  let current = () => view.isConnected;
  view._runCommandError = '';
  try {
    const run = view._requireCurrentRun();
    current = view._captureRunScope();
    await gateway.request(Methods.RUN_RESUME, { runId: run.id });
  } catch (error) {
    if (current()) view._runCommandError = error instanceof Error ? error.message : String(error);
  }
}

export async function restoreSlotViewTmuxWorker(view: SlotView) {
  return recoverWorker(view, 'restore-window');
}

export async function reloadSlotViewWorkerSession(view: SlotView) {
  return recoverWorker(view, 'reload-session');
}

async function recoverWorker(view: SlotView, mode: 'restore-window' | 'reload-session') {
  if (!view.slotId || !view._linkedRun || view._runActionsBlocked || view._tmuxRestoreRequest)
    return;
  const request = Symbol('recover-worker');
  view._tmuxRestoreRequest = request;
  view._tmuxRestoreRunning = true;
  view._tmuxRestoreFeedback = '';
  view._tmuxRestoreError = '';
  let current = () => view.isConnected;
  try {
    const run = view._requireCurrentRun();
    current = view._captureRunScope();
    const result = await gateway.request<TmuxWorkerRestoreResult>(Methods.TMUX_WORKER_RESTORE, {
      slotId: view.slotId,
      runId: run.id,
      mode,
    });
    if (!current()) return;
    const recovered =
      result.contexts.find(
        (context) => context.status === 'restored-window' || context.status === 'reloaded-session',
      ) ?? result.contexts[0];
    view._tmuxRestoreFeedback =
      recovered?.detail ??
      (result.restored ? 'Worker session restored' : 'Worker session state reconciled');
  } catch (error) {
    if (current()) view._tmuxRestoreError = error instanceof Error ? error.message : String(error);
  } finally {
    if (view._tmuxRestoreRequest === request) {
      view._tmuxRestoreRequest = undefined;
      view._tmuxRestoreRunning = false;
    }
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
  prepareProfile?: string,
) {
  if (!view._linkedRun || view._runActionsBlocked) return;
  let current = () => view.isConnected;
  view._runCommandError = '';
  try {
    const run = view._requireCurrentRun();
    current = view._captureRunScope();
    await gateway.request(Methods.RUN_REPLAY_STEP, {
      runId: run.id,
      stepName,
      skipPrepare: skipPrepare || undefined,
      prepareProfile: prepareProfile || undefined,
    });
    if (current()) view._runPanelSelectedStep = null;
  } catch (error) {
    if (current()) view._runCommandError = error instanceof Error ? error.message : String(error);
  }
}
