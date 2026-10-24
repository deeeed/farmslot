import type { ResourceStatusUpdatedPayload, SlotResource } from '@farmslot/protocol';
import { Events } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { subscribe } from '../../state.js';
import { activeSlotPrepare, subscribeSlotPrepareTracker } from '../shared/slot-prepare-tracker.js';

import type { SlotView } from './slot-view.js';
import { loadLayout } from './slot-view-layout.js';
import { EDITOR_PREF_KEY, type EditorId, EDITORS } from './slot-view-model.js';
import { refreshSlotViewRecipeRunnerOptions } from './slot-view-recipe-runner-effects.js';
import {
  connectSlotViewLayoutObserver,
  disconnectSlotViewLayoutObserver,
} from './slot-view-resize-effects.js';

export function connectSlotView(view: SlotView): void {
  document.addEventListener('keydown', view._boundKeyHandler);
  window.addEventListener('hashchange', view._onHashChange);
  // Hydrate URL-pinned history modal state synchronously so any later
  // _syncUrlState call (run-refresh, recipe-runs refresh, etc.) sees the
  // correct internal state and doesn't need a URL fallback to survive.
  view._restoreHistoryFromUrl();
  const saved = localStorage.getItem(EDITOR_PREF_KEY);
  if (saved && EDITORS.some((editor) => editor.id === saved)) view._editor = saved as EditorId;

  restoreSlotViewLayout(view);
  if (view._getHashParam('activity') === 'info') {
    view._activity = 'info';
    view._sidebarOpen = true;
  }

  if (view.slotId) view._loadSlot();
  void refreshSlotViewRecipeRunnerOptions(view);

  const updateLinkedRun = () => {
    view._runQueries.sync();
  };

  // Follow the same fleet projection as the rest of the application.
  view._unsubState = subscribe((state) => {
    if (view.slotId) {
      const slot = state.fleet?.slots.find((candidate) => candidate.slot === view.slotId) ?? null;
      if (!view._slot && slot) {
        view._loadSlot();
      } else if (view._slot !== slot) {
        const previousRunId = view._slot?.currentRunId ?? null;
        view._slot = slot;
        if ((slot?.currentRunId ?? null) !== previousRunId) updateLinkedRun();
      }
    }
    view._requestSlotSwitcherUpdate(state.fleet?.slots ?? []);
  });

  // Init workspace when gateway connects (handles page refresh)
  view._unsubConn = gateway.onConnectionChange((conn) => {
    if (!view._isLive) return;
    if (conn === 'disconnected') {
      view._recoveryPhase = 'stale';
      view._recoveryMessage = 'Connection lost — waiting to recover from gateway';
      view._wsLoading = false;
      view._wsError = '';
      return;
    }
    if (conn === 'connected' && (view._liveInitPending || view._recoveryPhase !== 'live')) {
      view._liveInitPending = false;
      void view._beginLiveRecovery();
    }
    if (conn === 'connected') {
      void view._refreshWorkerHistoryCapability();
    }
  });

  updateLinkedRun();

  // Resource status updates (from polling)
  view._unsubResourceStatus = gateway.subscribe<ResourceStatusUpdatedPayload>(
    Events.RESOURCE_STATUS_UPDATED,
    (payload) => handleSlotViewResourceStatusUpdate(view, payload),
  );

  view._unsubPrepareTracker = subscribeSlotPrepareTracker(() => {
    view._activePrepare = view.slotId ? activeSlotPrepare(view.slotId) : null;
  });

  connectSlotViewLayoutObserver(view);
}

export function disconnectSlotView(view: SlotView): void {
  document.removeEventListener('keydown', view._boundKeyHandler);
  window.removeEventListener('hashchange', view._onHashChange);
  view._unsubState?.();
  view._unsubConn?.();
  view._unsubResourceStatus?.();
  view._unsubPrepareTracker?.();
  disconnectSlotViewLayoutObserver(view);
  view._cancelResourceRestoreRetry();
  view._teardownLive();
  view._confirmTimer.clear();
  view._copyFeedback.clear();
}

function restoreSlotViewLayout(view: SlotView): void {
  const layout = loadLayout();
  if (layout.sidebarWidth) view._sidebarWidth = layout.sidebarWidth;
  if (layout.terminalHeight) view._terminalHeight = layout.terminalHeight;
  if (layout.terminalOpen !== undefined) view._terminalOpen = layout.terminalOpen;
  if (layout.sidebarOpen !== undefined) view._sidebarOpen = layout.sidebarOpen;
  if (layout.sections) view._sections = { ...view._sections, ...layout.sections };
  if (layout.activity) view._activity = layout.activity as typeof view._activity;
  if (layout.pinnedHeight) view._pinnedHeight = layout.pinnedHeight;
  if (layout.streamWidth) view._streamWidth = layout.streamWidth;
  if (layout.reviewPanelWidth) view._reviewPanelWidth = layout.reviewPanelWidth;
  if (layout.selectedAgentContextIds)
    view._selectedAgentContextIds = layout.selectedAgentContextIds;
  // M8: Legacy migration — apply the flat selectedAgentContextId only to
  // the current slot, then delete the legacy key so it doesn't bleed into
  // other slots opened subsequently.
  if (layout.selectedAgentContextId && view.slotId && !view._selectedAgentContextIds[view.slotId]) {
    view._selectedAgentContextIds = {
      ...view._selectedAgentContextIds,
      [view.slotId]: layout.selectedAgentContextId,
    };
    delete (layout as Record<string, unknown>).selectedAgentContextId;
    view._saveLayout();
  }
  view._selectedAgentContextId = view._selectedAgentContextIds[view.slotId] ?? 'primary';
}

function handleSlotViewResourceStatusUpdate(
  view: SlotView,
  payload: ResourceStatusUpdatedPayload,
): void {
  if (payload.slotId === view.slotId && view._resources.length > 0) {
    view._resources = view._resources.map((resource) => {
      const updated = payload.resources.find((candidate) => candidate.id === resource.id);
      return updated
        ? {
            ...resource,
            status: updated.status as SlotResource['status'],
            stream: updated.stream,
          }
        : resource;
    });
  }
}
