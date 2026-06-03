import { gateway } from '../../gateway-client.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import type { ResourcePanel } from '../resources/resource-panel.js';

import type { SlotView } from './slot-view.js';
import { slotViewPendingReviewDecision } from './slot-view-model.js';

export function handleSlotViewUpdated(view: SlotView, changed: Map<string, unknown>): void {
  // Auto-focus new file input when prompt opens
  if (changed.has('_newFilePrompt') && view._newFilePrompt) {
    requestAnimationFrame(() => {
      const input = view.querySelector('.sv-new-file-input') as HTMLInputElement;
      input?.focus();
    });
  }
  if (changed.has('slotId') && view.slotId) {
    if (view.slotId !== view._prevSlotId) {
      view._prevSlotId = view.slotId;
      view._fileUrlReady = false;
      view._cancelFileRestoreRetry();
      view._cancelResourceRestoreRetry();
      view._resetRecipePanelState();
      view._openFiles = [];
      view._activeFile = '';
      view._activeResourceId = '';
      view._pinnedFolder = '';
      view._pinnedEntries = [];
      view._branchDiffBase = 'main';
      view._branchDiffFiles = [];
      view._branchDiffHead = '';
      view._selectedAgentContextId = view._selectedAgentContextIds[view.slotId] ?? 'primary';
      view._unavailableContextKeys = new Set();
      view._revealLine = 0;
      view._showInlineComments = false;
      view._resourcePanelOpen = !!view._requestedResourceFromUrl();
      if (view._isLive) {
        if (gateway.connectionState === 'connected') {
          void view._beginLiveRecovery();
        } else {
          view._liveInitPending = true;
          view._recoveryPhase = 'stale';
          view._recoveryMessage = 'Waiting for gateway reconnect';
          view._wsLoading = false;
          view._wsError = '';
        }
      } else {
        view._teardownLive();
      }
    }
    view._loadSlot();
    void view._refreshLinkedRun(view._linkedRun?.status ?? null);
  }
  // Sync URL-backed local state
  if (
    (changed.has('_activeFile') ||
      changed.has('_activeResourceId') ||
      changed.has('_resourcePanelOpen') ||
      changed.has('_selectedRecipeRunId') ||
      changed.has('_selectedRecipeFlowPath') ||
      changed.has('_selectedRecipeNodeId') ||
      changed.has('_selectedRecipeArtifactPath') ||
      changed.has('_recipeLightboxOpen') ||
      changed.has('_recipeLightboxMode') ||
      changed.has('_recipeLightboxPairIndex') ||
      changed.has('_reviewDrawerMode')) &&
    view._fileUrlReady
  ) {
    view._syncUrlState();
  }
  // Keep lightbox index aligned with selected artifact path so URL-restored
  // state (recipeViewer=1 + recipeArtifact=…) lands on the right item.
  if (
    view._recipeLightboxOpen &&
    (changed.has('_selectedRecipeArtifactPath') ||
      changed.has('_recipeLightboxOpen') ||
      changed.has('_linkedRun') ||
      changed.has('_selectedRecipeRunId'))
  ) {
    const recipeHost = createSlotViewRecipeHostEntry(
      view._linkedRun,
      view.slotId,
      view._selectedRecipeRun(),
    );
    if (recipeHost && view._selectedRecipeArtifactPath) {
      const items = view._recipeLightboxItems(recipeHost);
      const idx = items.findIndex((item) => item.path === view._selectedRecipeArtifactPath);
      if (idx >= 0 && idx !== view._recipeLightboxIndex) view._recipeLightboxIndex = idx;
    }
  }
  const requestedResource = view._requestedResourceFromUrl();
  if (view._resourcePanelOpen && (view._activeResourceId || requestedResource)) {
    const targetResource = view._activeResourceId || requestedResource || '';
    if (targetResource && view._activeResourceId !== targetResource) {
      view._activeResourceId = targetResource;
    }
    const panel = view.querySelector('resource-panel') as ResourcePanel | null;
    if (!panel?.activeIds.includes(targetResource)) {
      view._ensureResourcePanelSelection(targetResource, 2);
    }
  }
  const requestedFile = view._requestedFileFromUrl();
  if (
    view._fileUrlReady &&
    requestedFile &&
    !view._activeFile &&
    view._recoveryPhase === 'live' &&
    view._openFiles.length === 0
  ) {
    view._scheduleUrlRestoreRetry(requestedFile, 1);
  }
  // Auto-open review panel when a review gate decision becomes pending
  if (changed.has('_linkedRun')) {
    const hasSlotRecipeHost = !!createSlotViewRecipeHostEntry(view._linkedRun, view.slotId);
    const hasReadyDecision = !!view._readyGateDecision();
    const hasPendingReviewDecision = !!slotViewPendingReviewDecision(view._linkedRun);
    if (
      (hasReadyDecision || hasPendingReviewDecision || hasSlotRecipeHost) &&
      !view._reviewPanelOpen
    ) {
      view._reviewPanelOpen = true;
      view._saveLayout();
    }
    if (view._fileUrlReady) {
      view._syncUrlState();
    }
  }
}
