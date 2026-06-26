import type { GitDiffResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import type { ResourcePanel } from '../resources/resource-panel.js';

import type { SlotView } from './slot-view.js';
import {
  getSlotViewHashParam,
  isSlotViewHashForSlot,
  requestedFileFromHash,
  requestedRecipeArtifactFromHash,
  requestedRecipeEvidenceModeFromHash,
  requestedRecipeFlowFromHash,
  requestedRecipeNodeFromHash,
  requestedRecipeRunFromHash,
  requestedRecipeViewerModeFromHash,
  requestedResourceFromHash,
  requestedReviewDrawerModeFromHash,
  requestedRunFromHash,
  slotViewHash,
} from './slot-view-url-state.js';

export function handleSlotViewHashChange(view: SlotView): void {
  // When navigating to the same slot with a different ?file= param, _initLive
  // won't re-run (slotId didn't change), so we must restore the file here.
  if (isSlotViewHashForSlot(view.slotId) && view._fileUrlReady) {
    // Hydrate URL-pinned history state BEFORE _refreshLinkedRun fires
    // _syncUrlState — otherwise the sync would write the URL back without
    // our just-arrived ?history=1, racing the hashchange we're handling.
    restoreSlotViewHistoryFromUrl(view);
    void restoreSlotViewFileFromUrl(view);
    restoreSlotViewResourceFromUrl(view);
    const requestedRunId = requestedRunFromHash();
    if (requestedRunId && !view._reviewPanelOpen) {
      view._reviewPanelOpen = true;
      view._saveLayout();
    }
    void view._refreshLinkedRun(view._linkedRun?.status ?? null);
  }
}

/** Read ?history=1&historyRun=<id> from the current hash and apply. */
export function restoreSlotViewHistoryFromUrl(view: SlotView): void {
  const wantOpen = getSlotViewHashParam('history') === '1';
  const wantRun = getSlotViewHashParam('historyRun') ?? '';
  if (view._historyOpen !== wantOpen) view._historyOpen = wantOpen;
  if (view._historyRunId !== wantRun) view._historyRunId = wantRun;
}

/** Update URL hash with current local slot-view state (replaceState to avoid history spam) */
export function syncSlotViewUrlState(view: SlotView): void {
  const fileForUrl = view._activeFile;
  const resourceForUrl = view._activeResourceId || requestedResourceFromHash();
  const runForUrl = view._linkedRun?.id ?? requestedRunFromHash() ?? undefined;
  // Internal state is the single source of truth. Earlier sync calls from
  // _refreshLinkedRun/_refreshRecipeRuns happen before connectedCallback
  // restores history state, so connectedCallback hydrates _historyOpen /
  // _historyRunId before the first sync and URL fallback is unnecessary here.
  const newHash = slotViewHash({
    slotId: view.slotId,
    runId: runForUrl,
    file: fileForUrl,
    resource: view._resourcePanelOpen ? (resourceForUrl ?? '') : '',
    recipeRun: view._selectedRecipeRunId,
    recipeFlow: view._selectedRecipeFlowPath,
    recipeNode: view._selectedRecipeNodeId,
    recipeEvidenceMode: view._recipeEvidenceMode,
    recipeArtifact: view._selectedRecipeArtifactPath,
    recipeViewerOpen: view._recipeLightboxOpen,
    recipeViewerMode: view._recipeLightboxMode,
    recipeViewerPair: view._recipeLightboxPairIndex,
    reviewDrawerMode: view._reviewDrawerMode,
    historyOpen: view._historyOpen,
    historyRun: view._historyRunId,
  });
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

/** Read ?file= from current hash and open it. */
export async function restoreSlotViewFileFromUrl(view: SlotView): Promise<void> {
  const file = requestedFileFromHash();
  if (!file) {
    cancelSlotViewFileRestoreRetry(view);
    view._openFiles = [];
    view._activeFile = '';
  } else {
    await openSlotViewFileFromUrl(view, file);
    if (!view._activeFile) {
      scheduleSlotViewUrlRestoreRetry(view, file, 3);
    }
  }
  restoreSlotViewResourceFromUrl(view);
  view._fileUrlReady = true;
  syncSlotViewUrlState(view);
}

export function restoreSlotViewResourceFromUrl(view: SlotView): void {
  const resourceId = requestedResourceFromHash();
  view._selectedRecipeRunId = requestedRecipeRunFromHash() ?? view._selectedRecipeRunId;
  view._selectedRecipeFlowPath = requestedRecipeFlowFromHash() ?? '';
  view._selectedRecipeNodeId = requestedRecipeNodeFromHash() ?? '';
  view._selectedRecipeArtifactPath = requestedRecipeArtifactFromHash();
  view._recipeEvidenceMode = view._selectedRecipeNodeId
    ? (requestedRecipeEvidenceModeFromHash() ?? 'node')
    : 'all';
  view._recipeLightboxOpen = getSlotViewHashParam('recipeViewer') === '1';
  view._recipeLightboxMode = requestedRecipeViewerModeFromHash();
  view._reviewDrawerMode = requestedReviewDrawerModeFromHash() ?? 'primary';
  const pairIdx = Number(getSlotViewHashParam('recipeViewerPair') ?? '');
  view._recipeLightboxPairIndex = Number.isFinite(pairIdx) && pairIdx > 0 ? pairIdx : 0;
  view._recipeEvidenceCache = null;
  if (!resourceId) {
    view._resourcePanelOpen = false;
    view._activeResourceId = '';
    return;
  }
  view._resourcePanelOpen = true;
  view._activeResourceId = resourceId;
  ensureSlotViewResourcePanelSelection(view, resourceId);
}

export function ensureSlotViewResourcePanelSelection(
  view: SlotView,
  resourceId: string,
  attemptsLeft = 4,
): void {
  if (!resourceId || attemptsLeft <= 0) return;
  cancelSlotViewResourceRestoreRetry(view);
  requestAnimationFrame(() => {
    const panel = view.querySelector('resource-panel') as ResourcePanel | null;
    if (panel) {
      panel.activateResource(resourceId);
      if (panel.activeIds.includes(resourceId)) return;
    }
    view._resourceRestoreRetryTimer = setTimeout(() => {
      view._resourceRestoreRetryTimer = null;
      ensureSlotViewResourcePanelSelection(view, resourceId, attemptsLeft - 1);
    }, 250);
  });
}

export function cancelSlotViewResourceRestoreRetry(view: SlotView): void {
  if (!view._resourceRestoreRetryTimer) return;
  clearTimeout(view._resourceRestoreRetryTimer);
  view._resourceRestoreRetryTimer = null;
}

export function cancelSlotViewFileRestoreRetry(view: SlotView): void {
  if (!view._fileRestoreRetryTimer) return;
  clearTimeout(view._fileRestoreRetryTimer);
  view._fileRestoreRetryTimer = null;
}

export function scheduleSlotViewUrlRestoreRetry(
  view: SlotView,
  file: string,
  attemptsLeft = 2,
): void {
  if (attemptsLeft <= 0 || view._activeFile) return;
  cancelSlotViewFileRestoreRetry(view);
  view._fileRestoreRetryTimer = setTimeout(async () => {
    view._fileRestoreRetryTimer = null;
    if (view._activeFile || requestedFileFromHash() !== file) return;
    await openSlotViewFileFromUrl(view, file);
    if (!view._activeFile) {
      scheduleSlotViewUrlRestoreRetry(view, file, attemptsLeft - 1);
    }
  }, 750);
}

export async function openSlotViewFileFromUrl(view: SlotView, file: string): Promise<void> {
  if (file.startsWith('branch:')) {
    const match = file.match(/^branch:([^:]+):(.+)$/);
    if (!match) return;
    const [, base, path] = match;
    view._branchDiffBase = base;
    const cacheKey = `branch:${base}:${path}`;
    if (view._isLive && !view._liveDiffContents.has(cacheKey)) {
      try {
        const result = await gateway.request<GitDiffResult>(Methods.GIT_DIFF, {
          slotId: view.slotId,
          path,
          base,
        });
        if (!result.diff.trim()) {
          await view._handleFileSelect(path);
          view._pinFile(path);
          return;
        }
        const next = new Map(view._liveDiffContents);
        next.set(cacheKey, result.diff);
        view._liveDiffContents = next;
      } catch (err) {
        const next = new Map(view._liveDiffContents);
        next.set(cacheKey, `Error: ${err instanceof Error ? err.message : 'Failed to load diff'}`);
        view._liveDiffContents = next;
      }
    }
    view._openBranchDiffFile(path, cacheKey);
    return;
  }

  await view._handleFileSelect(file);
  view._pinFile(file);
}
